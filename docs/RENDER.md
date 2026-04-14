# Deploy this assistant on Render (second service)

This app is the **full** assistant: Granola (MCP) + optional Pipedrive + optional Slack + Claude. The **Linq iMessage bridge** (`linq-imessage-assistant`) should call it over HTTP, not the other way around.

## 1. Create a Web Service on Render

- **Root directory**: this folder (`granola-agent-reference`), or your fork/repo root if you merged these files.
- **Runtime**: Docker (uses the repo `Dockerfile`) **or** Node: build `npm ci && npm run build`, start `node dist/index.js`.
- **Plan**: any tier that keeps one instance warm enough for OAuth + chat.

## 2. Public URL (required for Granola OAuth)

Set **one** of these so links in iMessage resolve to this service:

| Variable | Example |
|----------|---------|
| `RENDER_EXTERNAL_URL` | Render often injects this automatically (e.g. `https://your-service.onrender.com`) |
| `BASE_URL` or `PUBLIC_BASE_URL` | `https://your-service.onrender.com` (no trailing slash) |

OAuth callback is `{BASE_URL}/auth/callback` in production.

## 3. Core secrets (required)

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude (required) |
| `LINQ_API_TOKEN` | Same Linq partner token as the bridge — needed for `getChat()` context when handling `/linq-bridge` requests |
| `CREDENTIAL_ENCRYPTION_KEY` | **64 hex chars** (32 bytes) — encrypts Granola tokens in DynamoDB (or dev fallback). **Set in production** so tokens survive restarts. Generate: `openssl rand -hex 32` |
| `ASSISTANT_WEBHOOK_SECRET` | Optional but **recommended**: shared secret; the bridge sends `Authorization: Bearer <value>`. Must match on **both** services. |

## 4. Granola

| Variable | Purpose |
|----------|---------|
| `GRANOLA_MCP_URL` | Default `https://mcp.granola.ai/mcp` |
| (user tokens) | Stored after each user completes OAuth at `/auth/callback` |

## 5. Pipedrive (optional)

| Variable | Purpose |
|----------|---------|
| `PIPEDRIVE_API_TOKEN` | Personal API token |
| `PIPEDRIVE_COMPANY_DOMAIN` | Subdomain only, e.g. `acme` for `https://acme.pipedrive.com` |
| `PIPEDRIVE_API_BASE_URL` | Optional full v1 base override |

## 6. Slack (optional)

| Variable | Purpose |
|----------|---------|
| `SLACK_BOT_TOKEN` | Bot token `xoxb-…` with scopes for `search:read`, `channels:history`, `chat:write` (as needed) |

## 7. Persistence (recommended on Render)

| Variable | Purpose |
|----------|---------|
| `DYNAMODB_TABLE_NAME` | AWS DynamoDB table for encrypted Granola tokens + profiles (same as upstream granola-agent) |

Without DynamoDB, the code falls back to **in-memory** storage (tokens lost on restart).

## 8. Linq bridge URL (for the other Render service)

On **linq-imessage-assistant**, set:

```text
ASSISTANT_WEBHOOK_URL=https://<THIS_SERVICE_HOST>/linq-bridge
```

If you set `ASSISTANT_WEBHOOK_SECRET` here, set the **same value** on the bridge service.

**Unset** `ANTHROPIC_API_KEY` on the bridge if you want to avoid the lightweight Claude fallback entirely.

## 9. Health check

Render health check path: `GET /health`
