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