/**
 * HTTP adapter for linq-imessage-assistant ASSISTANT_WEBHOOK_URL.
 * POST /linq-bridge — body matches schema `linq-bridge.v1` (see linq-imessage-assistant README).
 */
import type { Express, Request, Response } from 'express';
import { getChat } from '../linq/client.js';
import { chat } from '../claude/client.js';
import { isUserAuthed, setUserProfile } from '../auth/store.js';
import { generateAuthUrl } from '../auth/oauth.js';

export type LinqBridgeV1Body = {
  schema: 'linq-bridge.v1';
  event_type: string;
  chat_id: string;
  from: string;
  text: string;
  message_id: string;
  images?: Array<{ url: string; mimeType?: string }>;
  audio?: Array<{ url: string; mimeType?: string }>;
  service?: string | null;
};

function cleanForDownstream(text: string): string {
  return text
    .replace(/\n\s*-\s*/g, ' - ')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function verifyBearer(req: Request): boolean {
  const secret = process.env.ASSISTANT_WEBHOOK_SECRET?.trim();
  if (!secret) return true;
  const h = String(req.get('authorization') || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return Boolean(m && m[1].trim() === secret);
}

export function mountLinqBridge(app: Express, getPublicBaseUrl: () => string): void {
  app.post('/linq-bridge', async (req: Request, res: Response) => {
    if (!verifyBearer(req)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const body = req.body as Partial<LinqBridgeV1Body>;
    if (body.schema !== 'linq-bridge.v1' || body.event_type !== 'message.received') {
      res.status(400).json({ error: 'invalid_body', detail: 'Expected schema linq-bridge.v1 and event_type message.received' });
      return;
    }

    const chatId = String(body.chat_id || '').trim();
    const from = String(body.from || '').trim();
    const text = String(body.text ?? '');
    if (!chatId || !from) {
      res.status(400).json({ error: 'missing_chat_id_or_from' });
      return;
    }

    const baseUrl = getPublicBaseUrl().trim();
    if (!baseUrl) {
      res.status(503).json({
        error: 'server_misconfigured',
        detail: 'Set BASE_URL or RENDER_EXTERNAL_URL (or PUBLIC_BASE_URL) on this assistant so Granola OAuth links work.',
      });
      return;
    }

    try {
      if (!(await isUserAuthed(from))) {
        await setUserProfile(from, { chatId });
        const authUrl = await generateAuthUrl(from, baseUrl, chatId);
        const messages = [
          'hey! i need to connect to your granola account for meeting notes',
          `tap here to link your account:\n${authUrl}`,
          'once youre connected, ask me about deals (pipedrive), slack, or meetings',
        ];
        res.json({ messages });
        return;
      }

      let userMessage = text;
      if (body.images?.length) {
        userMessage += `\n[User attached ${body.images.length} image(s): ${body.images.map((i) => i.url).join(', ')}]`;
      }
      if (body.audio?.length) {
        userMessage += `\n[User attached ${body.audio.length} audio clip(s); URLs only: ${body.audio.map((a) => a.url).join(', ')}]`;
      }

      const chatInfo = await getChat(chatId);
      const isGroupChat = chatInfo.handles.length > 2;
      const participantNames = chatInfo.handles.map((h) => h.handle);

      const { text: responseText } = await chat(chatId, userMessage, {
        isGroupChat,
        participantNames,
        chatName: chatInfo.display_name,
        senderHandle: from,
        service: (body.service as 'iMessage' | 'SMS' | 'RCS' | undefined) || undefined,
        baseUrl,
      });

      if (!responseText?.trim()) {
        res.json({ text: '(no reply)' });
        return;
      }

      const messages = responseText
        .split('---')
        .map((m) => cleanForDownstream(m))
        .filter((m) => m.length > 0);

      res.json(messages.length > 1 ? { messages } : { text: messages[0] || '(no reply)' });
    } catch (e) {
      console.error('[linq-bridge]', e);
      res.status(500).json({
        error: 'assistant_failed',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  });
}
