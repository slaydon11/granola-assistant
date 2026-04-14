/**
 * Pipedrive REST tools (API token). Env: PIPEDRIVE_API_TOKEN + PIPEDRIVE_COMPANY_DOMAIN or PIPEDRIVE_API_BASE_URL.
 */
import type Anthropic from '@anthropic-ai/sdk';

function g(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined || v === null) return undefined;
  const t = String(v).replace(/^\uFEFF+/, '').trim();
  return t.length ? t : undefined;
}

export function isPipedriveConfigured(): boolean {
  return Boolean(getConfig());
}

type PdConfig = { token: string; baseV1: string; baseV2: string };

function getConfig(): PdConfig | null {
  const token = g('PIPEDRIVE_API_TOKEN');
  if (!token) return null;

  const explicitBase = g('PIPEDRIVE_API_BASE_URL');
  if (explicitBase) {
    const trimmed = explicitBase.replace(/\/$/, '');
    const baseV1 = trimmed.includes('/api/v')
      ? trimmed.replace(/\/api\/v\d+.*$/, '/api/v1')
      : `${trimmed}/api/v1`;
    const baseV2 = baseV1.replace(/\/api\/v1$/, '/api/v2');
    return { token, baseV1, baseV2 };
  }

  const domain = g('PIPEDRIVE_COMPANY_DOMAIN');
  if (!domain) return null;

  const host = domain.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\.pipedrive\.com.*$/i, '');
  const base = `https://${host}.pipedrive.com`;
  return { token, baseV1: `${base}/api/v1`, baseV2: `${base}/api/v2` };
}

async function fetchV1(
  apiPath: string,
  query?: Record<string, string | number | undefined>,
): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg) return { success: false, error: 'Pipedrive not configured' };

  const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const u = new URL(`${cfg.baseV1}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(u.toString(), {
    headers: { Accept: 'application/json', 'x-api-token': cfg.token },
  });
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw) : {};
  } catch {
    return { success: false, error: 'Invalid JSON from Pipedrive', status: res.status };
  }
  if (!res.ok) {
    const err = (parsed as { error?: string })?.error;
    return { success: false, error: err || `HTTP ${res.status}`, data: parsed };
  }
  return parsed;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

async function pipedrivePostJson(
  version: 1 | 2,
  apiPath: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const cfg = getConfig();
  if (!cfg) return { success: false, error: 'Pipedrive not configured' };
  const base = version === 1 ? cfg.baseV1 : cfg.baseV2;
  const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const url = `${base}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-token': cfg.token,
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw) : {};
  } catch {
    return { success: false, error: 'Invalid JSON from Pipedrive', status: res.status };
  }
  if (!res.ok) {
    const err = (parsed as { error?: string })?.error;
    return { success: false, error: err || `HTTP ${res.status}`, data: parsed };
  }
  return parsed;
}

function escapeHtmlPlain(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function noteContentToHtml(content: string): string {
  const trimmed = content.trim().slice(0, 95000);
  if (trimmed.startsWith('<')) return trimmed;
  const paras = trimmed.split(/\n{2,}/).map((p) => `<p>${escapeHtmlPlain(p).replace(/\n/g, '<br/>')}</p>`);
  return paras.join('');
}

function slimDeal(d: Record<string, unknown>): Record<string, unknown> {
  return {
    id: d.id,
    title: d.title,
    value: d.value,
    currency: d.currency,
    status: d.status,
    stage_id: d.stage_id,
    pipeline_id: d.pipeline_id,
    person_id: d.person_id,
    org_id: d.org_id,
    add_time: d.add_time,
    update_time: d.update_time,
    expected_close_date: d.expected_close_date,
  };
}

function summarizeList(data: unknown, limit: number): unknown {
  const obj = data as { success?: boolean; data?: unknown };
  if (obj.success === false) return data;
  const rows = Array.isArray(obj.data) ? obj.data : [];
  return {
    success: obj.success,
    count: rows.length,
    deals: rows.slice(0, limit).map((r) => slimDeal(r as Record<string, unknown>)),
  };
}

export function isPipedriveToolName(name: string): boolean {
  return name.startsWith('pipedrive_');
}

export async function runPipedriveTool(name: string, input: unknown): Promise<string> {
  const cfg = getConfig();
  if (!cfg) return JSON.stringify({ error: 'Pipedrive not configured' });
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  try {
    switch (name) {
      case 'pipedrive_list_deals': {
        const rawStatus = typeof args.status === 'string' ? args.status : 'open';
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 25));
        const query: Record<string, string | number | undefined> = { limit };
        if (rawStatus && rawStatus !== 'all') query.status = rawStatus;
        const raw = await fetchV1('/deals', query);
        return JSON.stringify(summarizeList(raw, limit));
      }
      case 'pipedrive_get_deal': {
        const id = num(args.deal_id);
        if (id === undefined || id <= 0) return JSON.stringify({ error: 'invalid deal_id' });
        const raw = await fetchV1(`/deals/${id}`);
        const obj = raw as { success?: boolean; data?: Record<string, unknown> };
        if (obj.data && typeof obj.data === 'object') {
          return JSON.stringify({ success: obj.success, data: slimDeal(obj.data) });
        }
        return JSON.stringify(raw);
      }
      case 'pipedrive_search_deals': {
        const term = typeof args.term === 'string' ? args.term.trim() : '';
        if (term.length < 1) return JSON.stringify({ error: 'term required' });
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
        const url = new URL(`${cfg.baseV2}/deals/search`);
        url.searchParams.set('term', term);
        url.searchParams.set('limit', String(limit));
        const st = typeof args.status === 'string' ? args.status : undefined;
        if (st && ['open', 'won', 'lost'].includes(st)) url.searchParams.set('status', st);
        if (args.exact_match === true) url.searchParams.set('exact_match', 'true');

        const res = await fetch(url.toString(), {
          headers: { Accept: 'application/json', 'x-api-token': cfg.token },
        });
        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = text.length ? JSON.parse(text) : {};
        } catch {
          return JSON.stringify({ error: 'bad JSON from search' });
        }
        const p = parsed as { data?: unknown };
        const d = p.data;
        let items: unknown[] = [];
        if (Array.isArray(d)) items = d;
        else if (d && typeof d === 'object' && Array.isArray((d as { items?: unknown[] }).items)) {
          items = (d as { items: unknown[] }).items;
        }
        const deals = items.slice(0, limit).map((it) => {
          const row = it as { item?: Record<string, unknown> };
          return row.item ? slimDeal(row.item) : it;
        });
        return JSON.stringify({ success: true, count: items.length, deals });
      }
      case 'pipedrive_add_deal_note': {
        const dealId = num(args.deal_id);
        if (dealId === undefined || dealId <= 0) return JSON.stringify({ error: 'invalid deal_id' });
        const rawContent = typeof args.content === 'string' ? args.content : '';
        if (!rawContent.trim()) return JSON.stringify({ error: 'content is required' });
        const body: Record<string, unknown> = {
          deal_id: dealId,
          content: noteContentToHtml(rawContent),
        };
        const uid = num(args.user_id);
        if (uid !== undefined) body.user_id = uid;
        const out = await pipedrivePostJson(1, '/notes', body);
        return JSON.stringify(out);
      }
      case 'pipedrive_create_activity': {
        const dealId = num(args.deal_id);
        if (dealId === undefined || dealId <= 0) return JSON.stringify({ error: 'invalid deal_id' });
        const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
        if (!subject) return JSON.stringify({ error: 'subject is required' });
        const type = typeof args.type === 'string' ? args.type.trim().toLowerCase() : '';
        const allowed = ['call', 'meeting', 'task', 'email', 'deadline', 'lunch'];
        if (!type || !allowed.includes(type)) {
          return JSON.stringify({ error: `type must be one of: ${allowed.join(', ')}` });
        }
        const body: Record<string, unknown> = { deal_id: dealId, subject, type };
        if (typeof args.note === 'string' && args.note.trim()) body.note = args.note.trim().slice(0, 10000);
        if (typeof args.due_date === 'string' && args.due_date.trim()) body.due_date = args.due_date.trim();
        if (typeof args.due_time === 'string' && args.due_time.trim()) body.due_time = args.due_time.trim();
        if (typeof args.duration === 'string' && args.duration.trim()) body.duration = args.duration.trim();
        if (args.done === true) body.done = true;
        if (args.done === false) body.done = false;
        const oid = num(args.owner_id);
        if (oid !== undefined) body.owner_id = oid;
        const out = await pipedrivePostJson(2, '/activities', body);
        return JSON.stringify(out);
      }
      default:
        return JSON.stringify({ error: `unknown pipedrive tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

export function pipedriveAnthropicTools(): Anthropic.Tool[] {
  if (!isPipedriveConfigured()) return [];
  return [
    {
      name: 'pipedrive_list_deals',
      description: 'List Pipedrive deals (open by default).',
      input_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['open', 'won', 'lost', 'all'] },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'pipedrive_get_deal',
      description:
        'Get one deal by id (value, currency, stage, custom fields for fee/GTV, org/person). Use before economics coaching.',
      input_schema: {
        type: 'object',
        properties: { deal_id: { type: 'number' } },
        required: ['deal_id'],
      },
    },
    {
      name: 'pipedrive_search_deals',
      description: 'Search deals by title, notes, or searchable custom fields.',
      input_schema: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          status: { type: 'string', enum: ['open', 'won', 'lost'] },
          limit: { type: 'number' },
          exact_match: { type: 'boolean' },
        },
        required: ['term'],
      },
    },
    {
      name: 'pipedrive_add_deal_note',
      description:
        'System of record for meeting recap on the deal: summaries, key discussion points, decisions, action items, and transcript highlights Sam wants kept on the account. Use the correct deal_id (search/get first). Do not try to store this content in Granola. Plain text becomes safe HTML.',
      input_schema: {
        type: 'object',
        properties: {
          deal_id: { type: 'number' },
          content: { type: 'string' },
          user_id: { type: 'number', description: 'Optional author (admin)' },
        },
        required: ['deal_id', 'content'],
      },
    },
    {
      name: 'pipedrive_create_activity',
      description:
        'Create a calendar-style Pipedrive activity on a deal (scheduled call, future meeting block, task with due date, etc.). For rich meeting write-ups and narrative context, use pipedrive_add_deal_note instead. Types: call, meeting, task, email, deadline, lunch. due_date / due_time optional; done true if already completed.',
      input_schema: {
        type: 'object',
        properties: {
          deal_id: { type: 'number' },
          subject: { type: 'string' },
          type: {
            type: 'string',
            enum: ['call', 'meeting', 'task', 'email', 'deadline', 'lunch'],
          },
          note: { type: 'string' },
          due_date: { type: 'string' },
          due_time: { type: 'string' },
          duration: { type: 'string' },
          done: { type: 'boolean' },
          owner_id: { type: 'number' },
        },
        required: ['deal_id', 'subject', 'type'],
      },
    },
  ];
}
