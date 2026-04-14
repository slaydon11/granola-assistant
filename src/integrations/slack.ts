/**
 * Slack Web API tools (bot token). Env: SLACK_BOT_TOKEN (xoxb-...).
 */
import type Anthropic from '@anthropic-ai/sdk';

function token(): string | undefined {
  const v = process.env.SLACK_BOT_TOKEN;
  if (!v?.trim()) return undefined;
  return v.trim();
}

export function isSlackConfigured(): boolean {
  return Boolean(token());
}

async function slackApi(method: string, params: Record<string, string | number | undefined>): Promise<unknown> {
  const t = token();
  if (!t) return { ok: false, error: 'SLACK_BOT_TOKEN not set' };

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') body.set(k, String(v));
  }

  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  return res.json();
}

export function isSlackToolName(name: string): boolean {
  return name.startsWith('slack_');
}

export async function runSlackTool(name: string, input: unknown): Promise<string> {
  if (!token()) return JSON.stringify({ error: 'Slack not configured' });
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  try {
    switch (name) {
      case 'slack_search_messages': {
        const query = typeof args.query === 'string' ? args.query.trim() : '';
        if (!query) return JSON.stringify({ error: 'query is required' });
        const count = Math.min(100, Math.max(1, Number(args.count) || 20));
        const out = await slackApi('search.messages', { query, count });
        return JSON.stringify(out);
      }
      case 'slack_conversation_history': {
        const channel = typeof args.channel === 'string' ? args.channel.trim() : '';
        if (!channel) return JSON.stringify({ error: 'channel (id) is required' });
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 30));
        const out = await slackApi('conversations.history', { channel, limit });
        return JSON.stringify(out);
      }
      case 'slack_post_message': {
        const channel = typeof args.channel === 'string' ? args.channel.trim() : '';
        const text = typeof args.text === 'string' ? args.text : '';
        if (!channel || !text.trim()) return JSON.stringify({ error: 'channel and text are required' });
        const out = await slackApi('chat.postMessage', { channel, text: text.slice(0, 12000) });
        return JSON.stringify(out);
      }
      default:
        return JSON.stringify({ error: `unknown slack tool: ${name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: String(e) });
  }
}

export function slackAnthropicTools(): Anthropic.Tool[] {
  if (!isSlackConfigured()) return [];
  return [
    {
      name: 'slack_search_messages',
      description: 'Search Slack workspace messages (same query syntax as Slack search).',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Max matches (default 20, max 100)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'slack_conversation_history',
      description: 'Fetch recent messages from a Slack channel or DM by channel ID (C… or D…).',
      input_schema: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Channel ID' },
          limit: { type: 'number' },
        },
        required: ['channel'],
      },
    },
    {
      name: 'slack_post_message',
      description: 'Post a message to a Slack channel or DM. Use carefully; prefer read/search for iMessage user questions.',
      input_schema: {
        type: 'object',
        properties: {
          channel: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['channel', 'text'],
      },
    },
  ];
}
