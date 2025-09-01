# Supabase Backend

AI-powered thought logging system with Telegram integration.

## Edge Functions

### ai-classify
Analyzes incoming messages for content classification and embedding generation:
- Extracts topics, sentiment, urgency scores
- Generates OpenAI embeddings for semantic search
- Creates follow-up entries for questions/important items

### ai-summarize-range
Generates concise summaries of messages within a date range:
- Identifies key themes and action items
- Caches results to avoid redundant processing
- Configurable time window (1-30 days)

### telegram-webhook
Handles Telegram bot interactions and commands:
- Commands: `/review`, `/summary`, `/dtg`, `/done`, `/snooze`
- Automatic message classification trigger
- Interactive inline buttons for workflow management

## Configuration

Project configured in `config.toml` with:
- PostgreSQL database (port 54322)
- API server (port 54321)
- Studio interface (port 54323)
- Edge runtime with Deno for functions

## Required Secrets

- `SERVICE_ROLE_KEY` - Database admin access
- `TELEGRAM_BOT_TOKEN` - Bot authentication
- `TELEGRAM_WEBHOOK_SECRET` - Webhook security
- `INTERNAL_FUNCTION_SECRET` - Inter-function calls
- `OPENAI_API_KEY` - AI classification/embeddings


## How it works (end-to-end)

* **You DM the bot** (any non-command message) → `telegram-webhook` stores it in `messages` and silently calls `ai-classify`.
* **`ai-classify`** → adds AI labels (`is_question`, `followup`, `urgency_score`, etc.), generates an embedding, and opens/updates a `followups` row when needed.
* **You run commands** in Telegram (the bot stays passive otherwise):

  * `/review [days]` — shows top items to triage (defaults to 3d). Top item includes **Done** / **Snooze 24h** buttons.
  * `/summary [n]` — returns a concise Markdown digest for the last `n` days (defaults to 7). Uses cached summaries when available.
  * `/dtg <phrase>` — “date-time group”: finds when you said something (top matches).
  * `/done <id>` — mark a follow-up resolved.
  * `/snooze <id> [h]` — snooze an item (default 24h).
* **Tip:** Only **non-command** messages trigger classification automatically.

## One-time setup (prod)

1. **Secrets** (Project Settings → Secrets):
   `SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `INTERNAL_FUNCTION_SECRET`, `OPENAI_API_KEY`.
2. **Deploy**:

   ```bash
   supabase functions deploy telegram-webhook --no-verify-jwt
   supabase functions deploy ai-classify --no-verify-jwt
   supabase functions deploy ai-summarize-range --no-verify-jwt
   ```
3. **Register Telegram webhook** (shares your secret with Telegram):

   ```bash
   curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://<PROJECT_REF>.functions.supabase.co/telegram-webhook",
       "secret_token": "'"$TELEGRAM_WEBHOOK_SECRET"'",
       "drop_pending_updates": true
     }'
   ```
4. **Optional schedule** (Supabase → Edge Functions → Schedules):
   Function `ai-summarize-range`, cron `0 3 * * *`, header `X-Internal-Secret: <INTERNAL_FUNCTION_SECRET>`, payload `{ "days": 7 }`.

## Local dev

```bash
supabase functions serve --env-file supabase/functions/.env.local --no-verify-jwt
```

(Use the same keys as above; Deno is the runtime. The bot stays passive; classification runs only on non-command messages.)
