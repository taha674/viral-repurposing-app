# Viral Repurposing Web App — MVP

Instagram-only reel discovery → transcript → **red-line-compliance adaptation** →
review/approve/copy. Runs on Postgres (Railway-hosted in production, or any
local Postgres for dev).

See the planning docs one level up: [`../phase1-spec.md`](../phase1-spec.md),
[`../reference-inputs.md`](../reference-inputs.md), [`../tasks.md`](../tasks.md).

## Stack

- Next.js 16 (App Router) + React 19, TypeScript
- `pg` — Postgres store (schema created/seeded on first connection; see [`lib/db.ts`](lib/db.ts))
- `apify-client` — `apify/instagram-reel-scraper` (scan = transcript off; single-reel = transcript on)
- `@google/genai` — the adaptation step (Gemini structured output)

## Setup

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL, APIFY_TOKEN, GEMINI_API_KEY
npm run dev                  # http://localhost:3000
```

`DATABASE_URL` must point at a reachable Postgres instance (local Postgres for
dev, Railway's managed Postgres in production). The schema and the 12 tracked
accounts are created/seeded automatically on first connection.

Without the other keys the app still runs: pages load, and account CRUD
works. The scraper- and Gemini-backed actions (manual add, transcript pull,
scan, adaptation) return clear "key not set" errors instead of crashing.

`APP_PASSWORD` gates the whole app behind a single shared password — leave it
unset for local dev (no gate) and set it as a Railway variable in production.
`CRON_SECRET` authenticates the scheduled weekly scan (`POST /api/cron/scan`),
called by a Railway cron service — see `../tasks.md` for the schedule.

## What works

- **Tracked accounts** (`/accounts`): add / pause / remove; seeded with the 12 IG handles.
- **Manual add** (`/`): paste an IG reel URL; confirms ≥1M views, or **Force-add** below threshold.
- **Weekly scan**: "Run scan now" sweeps active accounts for new 1M+ reels (transcript off), then pulls transcripts for qualifiers. Per-account errors are logged, not fatal. In production a Railway cron service also triggers this weekly via `POST /api/cron/scan` (bearer-secret protected).
- **Transcript**: auto-pulled on add/qualify; failures flagged; inline paste + "Re-pull from Apify".
- **Adaptation**: manual "Run adaptation" → source breakdown + minimally-edited compliant script + red-line flag. The prompt lives in [`lib/prompt.ts`](lib/prompt.ts) (written fresh, enforces the full 9-item red-line list; minimal edits, **no** Cyrus-voice rewrite).
- **Review**: inline-edit transcript & script, **Approve**, **Copy script**, **Archive**.

## MCP server (agentic control, e.g. Hermes)

`POST /api/mcp` is a stateless Streamable-HTTP MCP endpoint that exposes the
same controls as the web UI as 29 tools: discovery (accounts, hashtags, scans),
triage, adaptation, approval, voiceover, video hand-off, subtitle burn and the
publish-pack suggestions. Start with `get_pipeline_overview`; `get_reel`
returns `allowed_actions`, the tools that are legal for that reel right now.

Setup: set `MCP_API_TOKEN` (generate with `openssl rand -hex 32`)
as a Railway variable, plus `PUBLIC_BASE_URL` (used to build the signed media
and upload links). Nothing from the Instagram bot config is needed. The endpoint stays closed
(500) while the token is unset. Then point Hermes at it in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  cyrus_reels:
    url: "https://<railway-app>/api/mcp"
    headers:
      Authorization: "Bearer ${CYRUS_MCP_TOKEN}"   # set in ~/.hermes/.env
    timeout: 600          # voiceover / burn / scan run synchronously
    connect_timeout: 30
```

Guardrails, enforced server-side (see the 2026-09-29 note in the root `CLAUDE.md`):
the agent can approve only `red_line_flag = none` scripts; `needs_review` needs
`operator_confirmed` + the operator's quoted Telegram reply; `rejected` can never
be approved by the agent. Every mutating call is logged to `agent_actions`. Paid
tools are capped per day (`MCP_DAILY_PAID_CALL_CAP`, `MCP_DAILY_SCAN_CAP`) and
refuse rather than retry. Not exposed: posting, archive, prompt editing, storage
purge, reveal-in-Finder.

## Guardrails (per project rules)

- Human approval gate: adaptation is manual; nothing auto-approves or auto-publishes.
- Hard caps on every paid-API loop (`APIFY_MAX_RETRIES`, `GEMINI_MAX_RETRIES`); failures surface to the user.
- Secrets only in git-ignored `.env.local`.
- The app flags red lines; the human decides.

## Build-time TODO (see `../open-questions.md`)

- Re-verify the Apify actor's input keys / output field names in [`lib/apify.ts`](lib/apify.ts) — marked with a ⚠️ comment block.
