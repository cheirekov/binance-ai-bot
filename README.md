# Binance AI Bot

Autonomous Binance trading assistant with an OpenAI-driven strategy layer and a React dashboard. Generates short, medium, and long-horizon plans while accounting for Binance fees and configurable risk caps.

## Features
- Fastify API with Binance Spot client, OpenAI strategy reinforcement, and simple scheduler to keep strategies fresh.
- Regime-based indicator engine (EMA/RSI/ATR/ADX/Bollinger) with deterministic entry/exit levels and risk sizing.
- React + Vite dashboard for live market stats, AI notes, balances, and quick simulated trades.
- Universe scanner that auto-picks a wallet-aware “best” symbol and reports the last auto-trade decision.
- Optional portfolio mode: multiple concurrent long positions, conversion to required quote assets, and “risk-off” return to `HOME_ASSET`.
- Optional spot grid mode: auto-discovers range-bound candidates (heuristics) and maintains a limit-order grid (spot-only).
- Risk Governor (account-level): state machine `NORMAL/CAUTION/HALT` driven by mark-to-market equity drawdown, trend regime, and fee burn (computed from live balances + tickers + `state.json`, not SQLite).
- Grid Guard (per-grid): detects trend / falling-knife / vol spike regimes and automatically pauses **new grid BUYs** while keeping SELLs active to unwind.
- Optional AI policy (gated): LLM can propose OPEN/CLOSE/HOLD/PANIC and bounded parameter tuning; engine still validates and enforces caps.
- AI Coach (slow loop): periodically reviews compact summaries (governor, PnL, grids, candidates, news) and proposes bounded tuning / grid actions / symbol bans.
- AI Autonomy Profiles: `safe | standard | pro | aggressive` control what the coach may auto-apply (risk tightening is allowed; risk relaxation is opt-in + bounded).
- Universe policy: `TRADE_UNIVERSE` (explicit allow-list; optional) + `QUOTE_ASSETS` discovery filter + `TRADE_DENYLIST`.
- Optional SQLite persistence for analytics/learning (features, decisions, trades, grid fills, equity snapshots, conversion events) stored under the Docker volume (`/app/data`).
- PnL reconciliation: `/stats/pnl_reconcile` and a Portfolio “PnL breakdown” card help explain why grid performance is not equal to total account PnL.
- Dockerfiles + `docker-compose` for Linux deployment; GitHub Actions CI for lint/test/build.
## Quick start (spot, Docker)

See: **[docs/QUICKSTART_SPOT.md](./docs/QUICKSTART_SPOT.md)**

Basic setup:

```bash
cp .env.spot.basic.example .env
docker-compose up --build
```
   - Universe discovery is controlled by `QUOTE_ASSETS`.
   - For full discovery, leave `TRADE_UNIVERSE=` empty. If you set `TRADE_UNIVERSE`, the bot will only open new trades within that list.
   - Auto-trading requires both `AUTO_TRADE_ENABLED=true` and `TRADING_ENABLED=true`.
   - Futures (advanced, higher risk): set `TRADE_VENUE=futures`, provide a key with futures permissions, and set `FUTURES_ENABLED=true`. Start with low leverage (e.g. `FUTURES_LEVERAGE=2`) and test on futures testnet first.
   - Portfolio mode (optional): set `PORTFOLIO_ENABLED=true`, choose `HOME_ASSET` (e.g. `USDC`), and optionally `CONVERSION_ENABLED=true` if you allow auto-converting into BTC/XRP quotes.
   - Spot grid mode (optional): set `GRID_ENABLED=true`. Grids are **spot-only** and only run on symbols quoted in `HOME_ASSET` (e.g. `BTCUSDC` if `HOME_ASSET=USDC`). Auto-discovery uses heuristics, or you can pin `GRID_SYMBOLS=BTCUSDC,ETHUSDC`.
   - AI policy (optional): set `AI_MODE=advisory` (no auto execution) or `AI_MODE=gated-live` (AI proposes, engine executes if safe). AI policy is rate-limited by `AI_POLICY_MIN_INTERVAL_SECONDS` and `AI_POLICY_MAX_CALLS_PER_DAY`.
     - The policy can also suggest bounded tuning (e.g. `MIN_QUOTE_VOLUME`, `PORTFOLIO_MAX_POSITIONS`). You can apply it from the UI (“Apply AI tuning”), or set `AI_POLICY_TUNING_AUTO_APPLY=true`.
     - Grid allocation tuning via `GRID_MAX_ALLOC_PCT` is additionally clamped: `AI_POLICY_MAX_GRID_ALLOC_INCREASE_PCT_PER_DAY` limits how much the AI can increase it per day (decreases are allowed).
     - Risk relaxation is **disabled by default**: `AI_POLICY_ALLOW_RISK_RELAXATION=false` blocks AI actions that increase risk (e.g. `RESUME_GRID`). Enable it only with explicit operator approval.
   - AI Coach (slow loop): enabled by default when `AI_MODE!=off`. Configure:
     - `AI_AUTONOMY_PROFILE` controls auto-apply capabilities (safe default: `safe`)
     - `AI_COACH_INTERVAL_SECONDS` (default 600) and `AI_COACH_MIN_EQUITY_USD` (default 200)
     - `*_RANGE` envelope vars (extra safety bounds for AI tuning changes)
   - Non-OpenAI models (optional): if your provider supports the OpenAI API format, set `AI_BASE_URL`.
   - If you deploy the UI, set `BASIC_AUTH_USER/PASS` and `API_KEY/CLIENT_KEY`.
2) Install: `npm install`.
3) Start API: `npm run dev --workspace backend` (listens on `8788`).
4) Start web: `npm run dev --workspace frontend` (opens on `4173`, expects API at `http://localhost:8788`).

## Docker
Build and run both services:
```bash
cp .env.example .env   # set keys
npm run docker:up
```
- API: `http://localhost:8788`
- Web UI: `http://localhost:4173`

Security:
- API requires `x-api-key` when `API_KEY` is set.
- UI is protected with HTTP basic auth when `BASIC_AUTH_USER/PASS` are set; Docker build consumes these via build args.

`VITE_API_URL` can be overridden to point the frontend at a remote API. In Compose it defaults to `http://api:8788`.  
To try Binance spot testnet, set `BINANCE_BASE_URL=https://testnet.binance.vision` and use testnet keys; live trading still respects `TRADING_ENABLED`.

## CI/CD
`.github/workflows/ci.yml` runs `npm ci`, lint, tests, and builds for both workspaces on push/PR to `main`.

## API
- `GET /health` — status + lastUpdated
- `GET /strategy?symbol=BTCEUR` — current market snapshot, balances, strategies, risk settings, and Risk Governor state (when enabled)
- `POST /strategy/refresh?symbol=BTCEUR` — force refresh now for the symbol
- `POST /strategy/auto-select` — score allowed symbols, pick the strongest, and refresh strategies
- `POST /backtest` — simple TP/SL sim over recent klines `{ symbol?, interval?, limit? }`
- `POST /trade/execute` — `{ side, quantity, price?, type?, symbol? }`; simulated unless `TRADING_ENABLED=true`
- `POST /bot/emergency-stop` — `{ enabled: boolean, reason?: string }` (halts auto-trade ticks)
- `POST /grid/start` — `{ symbol }` (spot only; starts a grid on the symbol)
- `POST /grid/stop` — `{ symbol }` (spot only; stops a grid and cancels tracked orders)
- `POST /portfolio/panic-liquidate` — `{ dryRun?: boolean, stopAutoTrade?: boolean }` (sell free balances to `HOME_ASSET` where markets exist)
- `GET /orders/open` — open orders (spot/futures). Optional query: `symbol=BTCUSDC` or `symbols=BTCUSDC,ETHUSDC`
- `GET /orders/history` — order history for a symbol. Query: `symbol=BTCUSDC&limit=50`
- `POST /portfolio/sweep-unused` — `{ dryRun?, stopAutoTrade?, keepAllowedQuotes?, keepPositionAssets?, keepAssets? }` (sell unused free balances to `HOME_ASSET`)
- `POST /ai-policy/apply-tuning` — `{ dryRun?: boolean }` (apply last AI policy tuning suggestion; persists to `state.json`)
- `GET /stats/performance` — read-only performance stats (requires `PERSIST_TO_SQLITE=true`)
- `GET /stats/pnl_reconcile?window=24h` — explainable PnL breakdown (equity change vs grid/portfolio realized+unrealized, fees, conversions, residual). Best with `PERSIST_TO_SQLITE=true`.
- `GET /stats/db` — SQLite health (requires `PERSIST_TO_SQLITE=true`; returns table counts + last write timestamp)
- `GET /stats/ai_coach` — latest AI Coach proposals + applied flags (best-effort; also surfaced in `/strategy`)

## Notes and safety
- The bot estimates Binance spot fees (0.1% maker/taker) and limits size via `MAX_POSITION_SIZE_USDT` + `RISK_PER_TRADE_BP`.
- Signals are deterministic by default (EMA/RSI/ATR/ADX/Bollinger). OpenAI only contributes optional notes and policy suggestions; risk caps and exchange rules remain authoritative.
- Live trading is **off by default**. Enable only after testing; consider using Binance testnet or a sub-account with tight limits.
- Frontend shows the current active symbol, the top candidates from the scanner, and the last auto-trade decision/reason.
- Risk Governor safety rules:
  - Decisions are computed from live balances + tickers + `state.json` (SQLite is best-effort logging only).
  - `CAUTION/HALT` never allow risk increases; only pauses/tightening are applied.
  - No forced market-selling unless explicitly enabled (see `RISK_HALT_MARKET_EXIT=false` default).
- Grid Guard safety rules:
  - When triggered it pauses **new BUYs only** and cancels open BUY orders; SELL orders remain active to unwind inventory.
  - Resume uses hysteresis + time gates to prevent thrashing.
- UI safety highlights:
  - Sticky top bar shows a **red** “LIVE TRADING ENABLED” banner whenever `TRADING_ENABLED=true`, plus an **orange** halt banner when `emergencyStop=true` or `tradeHalted=true`.
  - Manual BUY/SELL is hidden behind **Advanced mode** (Status page). Advanced mode auto-disables after 10 minutes of inactivity.
  - When LIVE trading is enabled, manual orders require typed confirmation: `LIVE BUY <SYMBOL>` / `LIVE SELL <SYMBOL>`.
  - Mobile uses a sticky bottom navigation (Home/Portfolio/Orders/Strategy/Status); desktop uses top tabs.
- `MIN_QUOTE_VOLUME` is enforced in `HOME_ASSET` terms (BTC/ETH quote volumes are converted using their `*HOME_ASSET` market).
- `DAILY_LOSS_CAP_PCT` enables emergency stop when equity drawdown exceeds the threshold (PnL baseline resets daily).
- `/stats/pnl_reconcile` is best-effort and may show a non-zero residual due to deposits/withdrawals, missing fills, or pricing gaps (it’s meant to make “grid PnL vs total account PnL” explainable).
- News sentiment uses RSS/Atom feeds; `NEWS_FEEDS` must point to actual XML feeds (not HTML pages). Many sites (including Binance news pages) serve HTML and/or block server-side fetches.
- Grid mode is **spot-only** and works best in sideways markets. In trends/breakouts it can accumulate losses; keep `GRID_MAX_ALLOC_PCT` small until you’re confident. Use `GRID_BREAKOUT_ACTION=cancel` to stop grids when price exits the range.
- Risk Governor / Grid Guard manual SIM validation checklist:
  - Force trend regime (high ADX) and verify: Risk Governor may enter `CAUTION/HALT`, and grid BUY legs pause while SELLs continue.
  - Force liquidity floor breach (`MIN_QUOTE_VOLUME`) and verify: per-symbol grid BUYs pause, open BUY orders are cancelled, SELLs remain.
  - Force drawdown and verify: `CAUTION` blocks new entries; `HALT` blocks new entries + prevents starting new grids.
  - Verify: no market exits occur unless `RISK_HALT_MARKET_EXIT=true`.
- AI policy is **gated**: it can only choose actions/symbols from data the bot provides, and the engine still enforces exchange rules (minQty/minNotional), risk flags, allocation caps, and daily loss caps. It can still lose money—test on small size or testnet first.
  - Risk increases proposed by AI are blocked unless `AI_POLICY_ALLOW_RISK_RELAXATION=true` (default false).
- AI Coach loop runs separately from the fast trading loop:
  - Fast loop (`REFRESH_SECONDS`): refresh strategies, run Risk Governor, run auto-trader, sync trades.
  - Coach loop (`AI_COACH_INTERVAL_SECONDS`): propose bounded tuning / symbol bans / grid actions. Auto-apply is limited by `AI_AUTONOMY_PROFILE` + hard safety gates.
- Hard safety gates are always enforced in code (AI cannot bypass):
  - `TRADING_ENABLED` (and `FUTURES_ENABLED` for futures) must be true for real orders
  - `DAILY_LOSS_CAP_PCT` triggers `emergencyStop` and blocks new entries
  - Risk Governor `CAUTION/HALT` blocks risk increases (coach relaxations/resumes require governor `NORMAL`)
  - AI tuning envelope (`*_RANGE`) clamps any AI-origin tuning changes
- State is persisted to `PERSISTENCE_PATH` (default `./data/state.json`) so the bot resumes last strategies/balances after restart.
- Optional analytics persistence: set `PERSIST_TO_SQLITE=true` and `SQLITE_PATH=/app/data/bot.sqlite` to store features/decisions/trades inside the existing Docker volume (`./data:/app/data`). SQLite failures are best-effort and never block trading.
