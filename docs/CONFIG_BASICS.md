# Config basics (plain English)

This project is a Binance trading bot with an optional AI layer.

The goal of configuration is:

- **Beginner-friendly**: copy a basic `.env` and only touch a few knobs
- **Powerful**: advanced users can tune discovery, risk, grid, and AI behavior

## What happens at boot

1. The backend loads `.env` (environment variables)
2. It loads persisted state from `PERSISTENCE_PATH` (default: `./data/state.json` when using docker-compose)
3. If `PERSIST_TO_SQLITE=true`, it also opens SQLite at `SQLITE_PATH` and writes analytics (best-effort)
4. The backend starts the scheduler and HTTP API
5. The UI connects to the API and shows status

## What happens every tick

Think of the bot as a loop that repeats:

1. **Discovery**
   - If `TRADE_UNIVERSE` is set: use exactly those symbols (minus `TRADE_DENYLIST` and any blacklist)
   - If `TRADE_UNIVERSE` is empty: ask Binance for symbols and filter by `QUOTE_ASSETS` and other safety rules

2. **Scoring**
   - For each candidate, the bot looks at liquidity/volatility and a small set of signals
   - It ranks candidates and optionally auto-selects the active symbol (`AUTO_SELECT_SYMBOL=true`)

3. **Governor (safety brain)**
   - The Risk Governor classifies account conditions as NORMAL / CAUTION / HALT
   - In CAUTION/HALT it can pause entries and/or pause grid BUY legs

4. **Trading (execution)**
   - If `TRADING_ENABLED=false`, orders are simulated
   - If `AUTO_TRADE_ENABLED=true`, the bot can open/close positions automatically
   - Grid trading (spot-only) runs when `GRID_ENABLED=true`

5. **Persistence**
   - State is saved back to `state.json`
   - Optional SQLite tables are appended to (for analytics and debugging)

## What “Universe” means

The **Universe** controls what the bot is allowed to open **new** trades on.

- `TRADE_UNIVERSE` (optional): explicit list of tradable symbols
- `QUOTE_ASSETS`: what quotes are allowed during auto-discovery
- `TRADE_DENYLIST`: symbols that are always excluded

Existing positions and running grids remain **visible in the UI** even if they are outside the universe, but they are **trade-blocked** for new entries.

## What “AI” can and can’t do

The AI layer is optional. The engine still enforces risk gates and symbol gates.

- `AI_MODE=off`: no LLM calls
- `AI_MODE=advisory`: AI produces suggestions only; it does not open trades
- `AI_MODE=gated-live`: AI can propose actions, but the engine only executes if all gates pass

Token/cost control is handled by `AI_POLICY_MIN_INTERVAL_SECONDS`, `AI_POLICY_MAX_CALLS_PER_DAY`, and candidate limits.

## PnL: grid vs account

- Grid performance is **not** total account PnL.
- Portfolio PnL is tracked separately from grids.
- `pnl_reconcile` is where the system reconciles account-level changes.
