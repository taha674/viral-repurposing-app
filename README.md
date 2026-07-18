# Viral Repurposing Web App — MVP

Instagram-only reel discovery → transcript → **red-line-compliance adaptation** →
review/approve/copy. Local-first (SQLite); designed to port to Railway + Postgres later.

See the planning docs one level up: [`../phase1-spec.md`](../phase1-spec.md),
[`../reference-inputs.md`](../reference-inputs.md), [`../tasks.md`](../tasks.md).

## Stack

- Next.js 16 (App Router) + React 19, TypeScript
- `better-sqlite3` — local store at `data/app.db` (git-ignored, auto-seeded with the 12 tracked accounts)
- `apify-client` — `apify/instagram-reel-scraper` (scan = transcript off; single-reel = transcript on)
- `@google/genai` — the adaptation step (Gemini structured output)

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in APIFY_TOKEN and GEMINI_API_KEY
npm run dev                  # http://localhost:3000
```

Without keys the app still runs: pages load, the 12 accounts seed, and account
CRUD works. The scraper- and Gemini-backed actions (manual add, transcript
pull, scan, adaptation) return clear "key not set" errors instead of crashing.

## What works

- **Tracked accounts** (`/accounts`): add / pause / remove; seeded with the 12 IG handles.
- **Manual add** (`/`): paste an IG reel URL; confirms ≥1M views, or **Force-add** below threshold.
- **Weekly scan**: "Run scan now" sweeps active accounts for new 1M+ reels (transcript off), then pulls transcripts for qualifiers. Per-account errors are logged, not fatal. Scheduled cron is deferred to the Railway port.
- **Transcript**: auto-pulled on add/qualify; failures flagged; inline paste + "Re-pull from Apify".
- **Adaptation**: manual "Run adaptation" → source breakdown + minimally-edited compliant script + red-line flag. The prompt lives in [`lib/prompt.ts`](lib/prompt.ts) (written fresh, enforces the full 9-item red-line list; minimal edits, **no** Cyrus-voice rewrite).
- **Review**: inline-edit transcript & script, **Approve**, **Copy script**, **Archive**.

## Guardrails (per project rules)

- Human approval gate: adaptation is manual; nothing auto-approves or auto-publishes.
- Hard caps on every paid-API loop (`APIFY_MAX_RETRIES`, `GEMINI_MAX_RETRIES`); failures surface to the user.
- Secrets only in git-ignored `.env.local`.
- The app flags red lines; the human decides.

## Build-time TODO (see `../open-questions.md`)

- Re-verify the Apify actor's input keys / output field names in [`lib/apify.ts`](lib/apify.ts) — marked with a ⚠️ comment block.
