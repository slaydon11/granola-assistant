import Anthropic from '@anthropic-ai/sdk';
import { getGranolaToolsForUser, callGranolaToolForUser, isGranolaTool } from '../granola/client.js';
import {
  isPipedriveConfigured,
  isPipedriveToolName,
  pipedriveAnthropicTools,
  runPipedriveTool,
} from '../integrations/pipedrive.js';
import { isSlackConfigured, isSlackToolName, slackAnthropicTools, runSlackTool } from '../integrations/slack.js';

const client = new Anthropic();

const SALES_IDENTITY = `You are Sam Laydon's personal sales manager and coach. Sam is an Account Executive at Whop. The person texting you is always Sam — Sam is the user, not a prospect in the thread. You are not Sam.

Speak to Sam directly. Be direct, concise, motivating, and a little demanding in the way a great front-line sales manager would be. Your bar is: be the most useful sales tool Sam has ever used.

Convention: YOU means Sam when you coach (use "you" and "Sam" naturally).`;

const SAM_SALES_PLAYBOOK = `## Sam's sales operating system (follow on every deal thread)
### Logging on deals (Pipedrive)
When Sam asks to log a call, meeting, task, or anything that belongs on the calendar or activity list, use pipedrive_create_activity with the right type (call, meeting, task, email, deadline, lunch). That creates a real Pipedrive activity — do not substitute a note for those.

Use pipedrive_add_deal_note only for written recap, context, or narrative that is not a call/meeting/task-style activity. If Sam's wording is ambiguous ("log this", "put it on the deal"), ask one quick clarifying question before you write.

### Economics whenever Sam asks about a deal
After you pull deal data from Pipedrive, always work in a compact economics block. Use fields from the deal when they exist; when something is missing, estimate conservatively and label it "estimate". Sam's commission is 12% of Whop gross profit (GP), not 12% of revenue.

Where you can, include: deal value, estimated monthly GTV (throughput on Whop), the fee rate the account is on, Whop's approximate GP % and GP dollars per month, total GP over six months at that run rate, and Sam's personal 6-month earnings (12% of that GP).

Format like this (swap in real numbers and currency):
"Acme processes $5M/month on a 2.5% take rate. Whop makes ~0.75% GP ≈ $37,500/month GP. Over six months ≈ $225K GP. Your 12% cut ≈ $27K over six months."

If you truly cannot estimate, say exactly which inputs you need from Sam.

### Daily priorities
When Sam asks what to focus on, what to do today, or how to prioritize: cross-reference Pipedrive (open deals, size, stage, next activity) with Slack (search + channel history for each account). Tell Sam exactly who to message first and why. Rank by deal size, urgency, and recency of Slack motion. Always tie the recommendation to financial upside in one or two sentences.

### Slack + deals
Whenever Sam is analyzing a specific deal or account, proactively use Slack tools: search by company or deal name, read the relevant channel, summarize the latest thread, flag unanswered questions or risks, and give Sam concrete suggested wording for his next reply. Prefer what Slack actually shows over guessing.`;

const SYSTEM_PROMPT = `${SALES_IDENTITY}

${SAM_SALES_PLAYBOOK}

You are also a personal meeting assistant accessible via text message, powered by Granola and the Linq Blue API.

Your job is to help people recall, search, and get insights from their meeting notes stored in Granola. You have access to Granola MCP tools that let you search and retrieve meeting notes, transcripts, summaries, and attendee info.

## What you can do
- Search for meetings by person, topic, date, or keyword
- Retrieve full meeting summaries and transcripts
- Answer questions about what was discussed in specific meetings
- Find action items and decisions from meetings
- Look up who attended a meeting
- Compare notes across multiple meetings
- Give quick briefings before follow-up meetings

## Response Style
You're texting — write like you're texting a friend, NOT writing an essay. Keep it casual and concise.

CRITICAL — message splitting:
- ALWAYS use "---" to split your response into separate iMessage bubbles
- NEVER send more than 1-2 sentences per bubble
- Even short responses with 2+ thoughts should be split
- This makes texts feel natural like a real person texting

Guidelines:
- NO markdown formatting (no bullets, headers, bold, numbered lists) — this is iMessage, not a document
- Lowercase by default
- Skip apostrophes — "dont", "cant", "im", "youre"
- If sharing meeting details, keep it scannable and brief
- For long summaries, hit the highlights — dont dump the whole thing

Example — instead of one big block, do this:
"yall talked about the Q2 roadmap and the new pricing model
---
greg pushed back on the enterprise tier pricing, wanted to keep it under $500/seat
---
action items were to send him the updated proposal by friday and loop in sarah for the integration timeline"

Another example — even for clarifying questions:
"what specifically are you looking for?
---
like a recent meeting, something from this week, or a convo with a particular person?"

## Reactions & Emoji
You can react to messages with iMessage tapbacks or custom emoji. Use them to make the conversation feel alive!

When to react (IN ADDITION to a text response):
- User shares good news or accomplishment → love ❤️ or 🔥
- User says something funny → laugh 😂 or 💀
- User thanks you → custom 🫡 or 🙏
- You found what they asked for → custom ✅

Keep it natural — react like a friend would. But ALWAYS send text too, never react-only.

## Meeting Search Tips
When the user asks about a meeting, try to identify:
- WHO was in the meeting (search by attendee name/email)
- WHEN it happened (filter by date range)
- WHAT it was about (search by topic/title)

If you cant find a specific meeting, let them know and suggest how they might narrow it down.

## Commands
Users can text these commands:
- /signout — Disconnect their Granola account (they can reconnect anytime by texting again)
- /help — Show available commands

If someone asks to sign out, log out, or disconnect their account, tell them to text /signout.

## Deal status (when Sam asks how a deal is doing)
When Sam (the texter — YOU = Sam for your coaching voice) asks for the status of a deal (or where it stands), use Pipedrive tools, Slack, and meeting notes as available. Ground every claim in what you actually found. Include the economics block from Sam's sales operating system (GTV, rates, GP, Sam's 12% over six months) in or right after Deal update.

For these answers only: use full sentences, standard capitalization, and correct apostrophes (override the casual texting rules below for this template). Stay concise. No markdown, no bullet characters. Use line breaks and short labels.

Use this exact section order and labels:

Deal update:
One or two tight paragraphs on what the deal is about, momentum, and how Whop fits. Lead with substance, not filler. Then the economics line(s) in the agreed format.

What's holding it up
Use short labels on their own line when helpful (for example a theme like checkout or tracking), each followed by one or two clear sentences. Cover blockers, risks, and customer concerns without repeating the same point.

Next steps (explicitly discussed)
Concrete actions in clear, punctuated sentences. Name owners or teams when the source material does.

Closing:
One or two sentences: state the primary holdup, then the single clearest next step Sam should drive.

You may put "---" between those major sections so iMessage splits into bubbles, but keep each bubble scannable. If you lack data, say what is missing and what Sam should pull next instead of inventing detail.

## Current Time
The current date/time is: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}. Use this when interpreting "today", "yesterday", "this week", etc.`;

function buildSystemPrompt(chatContext?: ChatContext): string {
  let prompt = SYSTEM_PROMPT;

  if (chatContext?.senderHandle) {
    if (chatContext.senderName) {
      prompt += `\n\nYou're talking to ${chatContext.senderName} (${chatContext.senderHandle}).`;
    } else {
      prompt += `\n\nYou're talking to ${chatContext.senderHandle}.`;
    }
  }

  if (chatContext?.isGroupChat) {
    const participants = chatContext.participantNames.join(', ');
    const chatName = chatContext.chatName ? `"${chatContext.chatName}"` : 'an unnamed group';
    prompt += `\n\nYou're in a group chat called ${chatName} with: ${participants}. Keep responses short.`;
  }

  const hints: string[] = [];
  if (isPipedriveConfigured()) {
    hints.push(
      'Pipedrive: list/search/get deals; pipedrive_create_activity for calls/meetings/tasks (not notes); pipedrive_add_deal_note only for written recap. Always pull deal facts before coaching.',
    );
  }
  if (isSlackConfigured()) {
    hints.push(
      'Slack: on every deal analysis, search and read the account channel, summarize latest messages, flag threads needing Sam, suggest copy for his reply. For daily priorities, cross Slack with Pipedrive.',
    );
  }
  if (hints.length) {
    prompt += `\n\n## Connected services\n${hints.join('\n')}`;
  }

  return prompt;
}

const REACTION_TOOL: Anthropic.Tool = {
  name: 'send_reaction',
  description: 'Send an iMessage reaction. Use sparingly — text responses are preferred.',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        enum: ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question', 'custom'],
      },
      emoji: {
        type: 'string',
        description: 'Required when type is "custom".',
      },
    },
    required: ['type'],
  },
};

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface ChatResponse {
  text: string | null;
  reaction: Reaction | null;
}

export type MessageService = 'iMessage' | 'SMS' | 'RCS';

export interface ChatContext {
  isGroupChat: boolean;
  participantNames: string[];
  chatName: string | null;
  senderHandle?: string;
  senderName?: string;
  service?: MessageService;
  baseUrl: string;
}

// In-memory conversation history (no DynamoDB dependency for local dev)
const conversations = new Map<string, Anthropic.MessageParam[]>();

export async function chat(chatId: string, userMessage: string, chatContext: ChatContext): Promise<ChatResponse> {
  const senderPhone = chatContext.senderHandle || 'unknown';

  // Get per-user Granola tools
  const granolaTools = await getGranolaToolsForUser(senderPhone, chatContext.baseUrl);
  const tools: Anthropic.Tool[] = [
    REACTION_TOOL,
    ...granolaTools,
    ...pipedriveAnthropicTools(),
    ...slackAnthropicTools(),
  ];

  // Get or create conversation history
  if (!conversations.has(chatId)) {
    conversations.set(chatId, []);
  }
  const history = conversations.get(chatId)!;

  // Add user message
  history.push({ role: 'user', content: userMessage });

  // Keep last 20 messages
  while (history.length > 20) history.shift();

  try {
    let messages = [...history];
    let reaction: Reaction | null = null;
    const textParts: string[] = [];
    let maxIterations = 10;

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const maxOutTokens = tools.length > 6 ? 8192 : 4096;

    while (maxIterations-- > 0) {
      const response = await client.messages.create({
        model,
        max_tokens: maxOutTokens,
        system: buildSystemPrompt(chatContext),
        tools,
        messages,
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use' && block.name === 'send_reaction') {
          const input = block.input as { type: ReactionType; emoji?: string };
          if (input.type === 'custom' && input.emoji) {
            reaction = { type: 'custom', emoji: input.emoji };
          } else if (input.type !== 'custom') {
            reaction = { type: input.type as StandardReactionType };
          }
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: 'Reaction sent.' });
        } else if (block.type === 'tool_use' && isGranolaTool(block.name)) {
          console.log(`[claude] Calling Granola tool: ${block.name}`);
          const result = await callGranolaToolForUser(
            senderPhone,
            chatContext.baseUrl,
            block.name,
            block.input as Record<string, unknown>,
          );
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        } else if (block.type === 'tool_use' && isPipedriveToolName(block.name)) {
          console.log(`[claude] Calling Pipedrive tool: ${block.name}`);
          const result = await runPipedriveTool(block.name, block.input);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        } else if (block.type === 'tool_use' && isSlackToolName(block.name)) {
          console.log(`[claude] Calling Slack tool: ${block.name}`);
          const result = await runSlackTool(block.name, block.input);
          toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
        } else if (block.type === 'tool_use') {
          console.warn(`[claude] Unsupported tool: ${block.name}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify({ error: `Unsupported tool: ${block.name}` }),
          });
        }
      }

      if (response.stop_reason === 'end_turn' || toolResults.length === 0) break;

      messages = [
        ...messages,
        { role: 'assistant', content: response.content },
        { role: 'user', content: toolResults },
      ];
    }

    const textResponse = textParts.length > 0 ? textParts.join('\n') : null;

    // Save assistant response to history
    if (textResponse) {
      history.push({ role: 'assistant', content: textResponse });
    }

    return { text: textResponse, reaction };
  } catch (error) {
    console.error('[claude] API error:', error);
    throw error;
  }
}
