# Quickstart (Spot) — 10 minute setup

This guide gets the bot running locally with Docker Compose.

## 0) Requirements

- Docker + Docker Compose
- A Binance account
- (Optional) An OpenAI-compatible API key (can be OpenAI, or any provider that supports the OpenAI REST format)

## 1) Pick a config template

Beginner template:

```bash
cp .env.spot.basic.example .env
```

Advanced template (more knobs, more comments):

```bash
cp .env.spot.advanced.example .env
```

## 2) Fill your keys (never commit secrets)

Edit `.env` and set:

- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`

Optional AI:

- `AI_API_KEY` (leave empty to run without LLM calls)
- `AI_BASE_URL` (optional OpenAI-compatible endpoint)

Safety defaults:

- `TRADING_ENABLED=false` (keep it false until you understand what the bot is doing)
- `AUTO_TRADE_ENABLED=false` (start with UI-only)

## 3) Start the stack

```bash
docker-compose up --build
```

Then open the UI:

- http://localhost:4173

The API health endpoint:

- http://localhost:8788/health

## 4) Sanity-check the Status page

On **Status** you should see:

- **Venue**: spot
- **AI Mode**: off / advisory / gated-live
- **Universe**: static (TRADE_UNIVERSE) or auto-discovery

Important: the UI never shows secrets.

## 5) What the bot does (high level)

At startup:

1. Loads `.env`
2. Loads persisted state from `PERSISTENCE_PATH` (`./data/state.json` in compose)
3. If enabled, also writes analytics to SQLite (`SQLITE_PATH`)

Every tick (loop):

1. **Discovery**: determine the universe (static `TRADE_UNIVERSE` or exchange discovery filtered by `QUOTE_ASSETS` etc)
2. **Scoring**: rank candidates based on liquidity/volatility/news signals
3. **Governor**: compute safety state (NORMAL/CAUTION/HALT)
4. **Trading**: manage grids/positions and optionally open new trades (only if enabled)
5. **Persistence**: write updated state

## 6) Notes on PnL

- Grid PnL is **not** total account PnL.
- `pnl_reconcile` is the place where grid PnL + portfolio PnL + fees + conversions are reconciled into account-level views.

---

## Migration checklist (BREAKING config rename)

### AI

Removed:

- `OPENAI_API_KEY` → use `AI_API_KEY`
- `OPENAI_MODEL` → use `AI_MODEL`
- `OPENAI_BASE_URL` → use `AI_BASE_URL`

New:

- `AI_MODEL` is the default for all AI pillars
- `AI_POLICY_MODEL` overrides policy only (optional)
- `AI_STRATEGY_MODEL` overrides strategist/insight only (optional)

Rules:

- if `AI_POLICY_MODEL` is empty → uses `AI_MODEL`
- if `AI_STRATEGY_MODEL` is empty → uses `AI_MODEL`

Before:

```env
# old names (removed)
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
AI_POLICY_MODE=gated-live
```

After:

```env
AI_API_KEY=...
AI_MODEL=gpt-4.1-mini
AI_MODE=gated-live
```

### Universe

Removed:

- `ALLOWED_SYMBOLS`, `SYMBOL_WHITELIST`, `BLACKLIST_SYMBOLS`, `ALLOWED_QUOTES`

New:

- `TRADE_UNIVERSE` (explicit allow-list; empty = auto-discovery)
- `QUOTE_ASSETS` (discovery filter)
- `TRADE_DENYLIST` (always excluded)

Before:

```env
# old names (removed)
ALLOWED_SYMBOLS=BTCUSDC,ETHUSDC
ALLOWED_QUOTES=USDC,EUR
BLACKLIST_SYMBOLS=BADCOINUSDC
```

After:

```env
TRADE_UNIVERSE=BTCUSDC,ETHUSDC
QUOTE_ASSETS=USDC,EUR
TRADE_DENYLIST=BADCOINUSDC
```
