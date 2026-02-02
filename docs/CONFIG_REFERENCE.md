# Config reference

This document describes every supported environment variable.

For ready-to-use templates, see:

- `.env.spot.basic.example`
- `.env.spot.advanced.example`
- `.env.futures.basic.example`
- `.env.reference.example` (same content, but as a `.env` file)

## AI

### AI credentials

- `AI_API_KEY` — OpenAI-compatible API key (optional)
- `AI_BASE_URL` — optional OpenAI-compatible endpoint

### Models

- `AI_MODEL` — default model for all AI
- `AI_POLICY_MODEL` — optional override for policy only (empty => `AI_MODEL`)
- `AI_STRATEGY_MODEL` — optional override for strategist/insight only (empty => `AI_MODEL`)

### AI mode

- `AI_MODE=off|advisory|gated-live`

### Token / call limits

- `AI_POLICY_MIN_INTERVAL_SECONDS`
- `AI_POLICY_MAX_CALLS_PER_DAY`
- `AI_POLICY_MAX_CANDIDATES`

## Universe (symbols)

Universe controls which symbols are eligible for **new entries**.

- `TRADE_UNIVERSE` — comma-separated symbols (empty => auto-discovery)
- `QUOTE_ASSETS` — comma-separated allowed quote assets during discovery
- `TRADE_DENYLIST` — comma-separated symbols always excluded

## Safety switches

- `TRADING_ENABLED` — must be true for real orders
- `AUTO_TRADE_ENABLED` — enables the auto-trader scheduler
- `DAILY_LOSS_CAP_PCT` — emergency stop trigger

## Persistence

- `PERSISTENCE_PATH`
- `PERSIST_TO_SQLITE`
- `SQLITE_PATH`

## See also

- [CONFIG_BASICS.md](./CONFIG_BASICS.md)
- [AI_GUIDE.md](./AI_GUIDE.md)
