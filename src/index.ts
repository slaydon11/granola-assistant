import 'dotenv/config';
import express from 'express';
import { createWebhookHandler } from './webhook/handler.js';
import { sendMessage, markAsRead, startTyping, sendReaction, getChat } from './linq/client.js';
import { chat } from './claude/client.js';
import { clearGranolaTokens, getUserProfile, isUserAuthed, setUserProfile } from './auth/store.js';
import { disconnectUser } from './granola/client.js';
import { createAuthRoutes } from './auth/routes.js';
import { mountLinqBridge } from './routes/linqBridge.js';

// Clean up LLM response formatting for iMessage
function cleanResponse(text: string): string {
  return text
    .replace(/\n\s*-\s*/g, ' - ')
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/  +/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const app = express();
const PORT = process.env.PORT || 3000;

// The public base URL (Render, Railway, ngrok, or local)
let publicBaseUrl =
  process.env.BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  process.env.PUBLIC_BASE_URL ||
  '';

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (/auth/callback, /auth/status/:phone)
const authRoutes = createAuthRoutes(
  () => publicBaseUrl,
  // When a user completes auth, send them a welcome message with confetti
  async (phoneNumber: string) => {
    console.log(`[main] User ${phoneNumber} just authenticated!`);

    const profile = await getUserProfile(phoneNumber);
    if (profile?.chatId) {
      try {
        await startTyping(profile.chatId);
        await new Promise(r => setTimeout(r, 500));
        await sendMessage(
          profile.chatId,
          'granola meeting search is linked for this assistant',
          { type: 'screen', name: 'confetti' },
        );
        await new Promise(r => setTimeout(r, 600));
        await sendMessage(
          profile.chatId,
          'when you ask about meetings i can pull from granola if its connected — meeting recap you want saved still goes on the pipedrive deal as a note',
        );
        console.log(`[main] Welcome message sent to ${phoneNumber}`);
      } catch (error) {
        console.error(`[main] Failed to send welcome message:`, error);
      }
    }
  },
);
app.use(authRoutes);

// Downstream HTTP contract for linq-imessage-assistant (ASSISTANT_WEBHOOK_URL → …/linq-bridge)
mountLinqBridge(app, () => publicBaseUrl);

// Webhook endpoint for Linq Blue
app.post(
  '/webhook',
  createWebhookHandler(async (chatId, from, text, messageId, images, audio, incomingEffect, incomingReplyTo, service) => {
    const start = Date.now();
    console.log(`[main] Message from ${from}: "${text}"`);

    // Mark as read + start typing in parallel
    await Promise.all([markAsRead(chatId), startTyping(chatId)]);

    await setUserProfile(from, { chatId });

    const cmd = text.toLowerCase().trim();
    const isSignout = cmd === '/signout' || cmd === '/logout' || cmd === '/disconnect'
      || /\b(sign\s*out|log\s*out|disconnect|unlink|remove\s*auth|deauth)\b/.test(cmd);
    if (isSignout && (await isUserAuthed(from))) {
      await disconnectUser(from);
      await clearGranolaTokens(from);
      await sendMessage(chatId, 'done — granola link cleared for this assistant');
      console.log(`[main] User ${from} signed out`);
      return;
    }

    try {
      const chatInfo = await getChat(chatId);
      const isGroupChat = chatInfo.handles.length > 2;
      const participantNames = chatInfo.handles.map(h => h.handle);

      const { text: responseText, reaction } = await chat(chatId, text, {
        isGroupChat,
        participantNames,
        chatName: chatInfo.display_name,
        senderHandle: from,
        service,
        baseUrl: publicBaseUrl,
      });
      console.log(`[timing] claude: ${Date.now() - start}ms`);

      if (reaction) {
        await sendReaction(messageId, reaction);
      }

      const messages = responseText?.trim()
        ? responseText.split('---').map(m => cleanResponse(m)).filter(m => m.length > 0)
        : [];

      if (messages.length > 0) {
        const replyTo = incomingReplyTo ? { message_id: messageId } : undefined;

        for (let i = 0; i < messages.length; i++) {
          const messageReplyTo = i === 0 ? replyTo : undefined;
          await sendMessage(chatId, messages[i], undefined, messageReplyTo);

          if (i < messages.length - 1) {
            const delay = 400 + Math.random() * 400;
            await new Promise(r => setTimeout(r, delay));
          }
        }
        console.log(`[timing] sent ${messages.length} msg(s): ${Date.now() - start}ms`);
      } else if (!reaction) {
        await sendMessage(
          chatId,
          "I didn't get a text reply from the model — try again. If this keeps happening, check server logs and ANTHROPIC_API_KEY.",
        );
        console.warn(`[main] Empty assistant reply for ${from}`);
      }

      console.log(`[main] Done processing ${from}`);
    } catch (error) {
      console.error(`[main] Webhook handler error for ${from}:`, error);
      const hint =
        error instanceof Error && error.message
          ? error.message.slice(0, 120)
          : 'unknown error';
      try {
        await sendMessage(
          chatId,
          `Something failed on the assistant server (${hint}). Check deploy logs, ANTHROPIC_API_KEY, and Linq token.`,
        );
      } catch (sendErr) {
        console.error('[main] Could not send error message to user:', sendErr);
      }
    }
  })
);

// Auto-detect ngrok URL for local dev
async function detectNgrokUrl(): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch('http://localhost:4040/api/tunnels', { signal: controller.signal });
    clearTimeout(timeout);
    const data = await resp.json() as { tunnels: Array<{ public_url: string }> };
    const tunnel = data.tunnels.find(t => t.public_url.startsWith('https://'));
    return tunnel?.public_url || null;
  } catch {
    return null;
  }
}

async function main() {
  // Detect public URL
  if (!publicBaseUrl) {
    detectNgrokUrl().then(url => {
      if (url) {
        publicBaseUrl = url;
        console.log(`[main] Detected ngrok URL: ${publicBaseUrl}`);
      }
    }).catch(() => {});
    publicBaseUrl = `http://localhost:${PORT}`;
  }

  const host = process.env.LISTEN_HOST || '0.0.0.0';
  app.listen(Number(PORT), host, () => {
    const base = publicBaseUrl || `http://localhost:${PORT}`;
    const bridge = `${base.replace(/\/$/, '')}/linq-bridge`;
    console.log(`
╔═══════════════════════════════════════════════════════╗
║         Granola Meeting Agent (Linq Blue)             ║
╠═══════════════════════════════════════════════════════╣
║  Server: http://${host}:${PORT}                        ║
║  Public: ${base.padEnd(46)}║
║  Linq bridge URL (ASSISTANT_WEBHOOK_URL on bridge):   ║
║  ${bridge.padEnd(52)}║
╚═══════════════════════════════════════════════════════╝
    `);
  });
}

main().catch(console.error);
