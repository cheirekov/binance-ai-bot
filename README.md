# Binance AI Bot

Autonomous Binance trading assistant with an OpenAI-driven strategy layer and a React dashboard. Generates short, medium, and long-horizon plans while accounting for Binance fees and configurable risk caps.

## Features
- Fastify API with Binance Spot client, OpenAI strategy reinforcement, and simple scheduler to keep strategies fresh.
- Heuristic risk engine that sizes positions by risk-per-trade and estimates maker/taker fees.
- React + Vite dashboard for live market stats, AI notes, balances, and quick simulated trades.
- Universe scanner that auto-picks a wallet-aware “best” symbol and reports the last auto-trade decision.
- Optional portfolio mode: multiple concurrent long positions, conversion to required quote assets, and “risk-off” return to `HOME_ASSET`.
- Optional spot grid mode: auto-discovers range-bound candidates (heuristics) and maintains a limit-order grid (spot-only).
- Optional AI policy (gated): LLM can propose OPEN/CLOSE/HOLD/PANIC and bounded parameter tuning; engine still validates and enforces caps.
- Dockerfiles + `docker-compose` for Linux deployment; GitHub Actions CI for lint/test/build.

## Quick start (local)
1) Copy env: `cp .env.example .env` (or start from `cp .env.spot.example .env` / `cp .env.future.example .env`) and fill `BINANCE_API_KEY/SECRET` (use restricted keys) and `OPENAI_API_KEY`. Keep `TRADING_ENABLED=false` until ready.
   - EU-friendly quotes: `QUOTE_ASSET=USDC` and `ALLOWED_QUOTES=USDC,EUR`.
   - For full discovery, leave `ALLOWED_SYMBOLS=` empty. If you set `ALLOWED_SYMBOLS`, the bot will only scan/trade within that allow-list.
   - Auto-trading requires both `AUTO_TRADE_ENABLED=true` and `TRADING_ENABLED=true`.
   - Futures (advanced, higher risk): set `TRADE_VENUE=futures`, provide a key with futures permissions, and set `FUTURES_ENABLED=true`. Start with low leverage (e.g. `FUTURES_LEVERAGE=2`) and test on futures testnet first.
   - Portfolio mode (optional): set `PORTFOLIO_ENABLED=true`, choose `HOME_ASSET` (e.g. `USDC`), and optionally `CONVERSION_ENABLED=true` if you allow auto-converting into BTC/XRP quotes.
   - Spot grid mode (optional): set `GRID_ENABLED=true`. Grids are **spot-only** and only run on symbols quoted in `HOME_ASSET` (e.g. `BTCUSDC` if `HOME_ASSET=USDC`). Auto-discovery uses heuristics, or you can pin `GRID_SYMBOLS=BTCUSDC,ETHUSDC`.
   - AI policy (optional): set `AI_POLICY_MODE=advisory` (no trading) or `AI_POLICY_MODE=gated-live` (AI proposes, engine executes if safe). AI policy is rate-limited by `AI_POLICY_MIN_INTERVAL_SECONDS` and `AI_POLICY_MAX_CALLS_PER_DAY`.
     - The policy can also suggest bounded tuning (e.g. `MIN_QUOTE_VOLUME`, `PORTFOLIO_MAX_POSITIONS`). You can apply it from the UI (“Apply AI tuning”), or set `AI_POLICY_TUNING_AUTO_APPLY=true`.
   - Non-OpenAI models (optional): if your provider supports the OpenAI API format, set `OPENAI_BASE_URL` (for example: local `ollama`, `llama.cpp` server, or `vLLM`).
   - If you deploy the UI, set `BASIC_AUTH_USER/PASS` and `API_KEY/CLIENT_KEY`.
2) Install: `npm install`.
3) Start API: `npm run dev --workspace backend` (listens on `8788`).
4) Start web: `npm run dev --workspace frontend` (opens on `4173`, expects API at `http://localhost:8788`).

## Docker
Build and run both services:
```bash
cp .env.example .env   # set keys
docker-compose up --build
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
- `GET /strategy?symbol=BTCEUR` — current market snapshot, balances, strategies, and risk settings for the symbol
- `POST /strategy/refresh?symbol=BTCEUR` — force refresh now for the symbol
- `POST /strategy/auto-select` — score allowed symbols, pick the strongest, and refresh strategies
- `POST /backtest` — simple TP/SL sim over recent klines `{ symbol?, interval?, limit? }`
- `POST /trade/execute` — `{ side, quantity, price?, type?, symbol? }`; simulated unless `TRADING_ENABLED=true`
- `POST /bot/emergency-stop` — `{ enabled: boolean, reason?: string }` (halts auto-trade ticks)
- `POST /grid/start` — `{ symbol }` (spot only; starts a grid on the symbol)
- `POST /grid/stop` — `{ symbol }` (spot only; stops a grid and cancels tracked orders)
- `POST /portfolio/panic-liquidate` — `{ dryRun?: boolean, stopAutoTrade?: boolean }` (sell free balances to `HOME_ASSET` where markets exist)
- `POST /portfolio/sweep-unused` — `{ dryRun?, stopAutoTrade?, keepAllowedQuotes?, keepPositionAssets?, keepAssets? }` (sell unused free balances to `HOME_ASSET`)
- `POST /ai-policy/apply-tuning` — `{ dryRun?: boolean }` (apply last AI policy tuning suggestion; persists to `state.json`)

## Notes and safety
- The bot estimates Binance spot fees (0.1% maker/taker) and limits size via `MAX_POSITION_SIZE_USDT` + `RISK_PER_TRADE_BP`.
- OpenAI assists with thesis notes; heuristics still produce numbers when AI is offline.
- Live trading is **off by default**. Enable only after testing; consider using Binance testnet or a sub-account with tight limits.
- Frontend shows the current active symbol, the top candidates from the scanner, and the last auto-trade decision/reason.
- `MIN_QUOTE_VOLUME` is enforced in `HOME_ASSET` terms (BTC/ETH quote volumes are converted using their `*HOME_ASSET` market).
- `DAILY_LOSS_CAP_PCT` enables emergency stop when equity drawdown exceeds the threshold (PnL baseline resets daily).
- News sentiment uses RSS/Atom feeds; `NEWS_FEEDS` must point to actual XML feeds (not HTML pages). Many sites (including Binance news pages) serve HTML and/or block server-side fetches.
- Grid mode is **spot-only** and works best in sideways markets. In trends/breakouts it can accumulate losses; keep `GRID_MAX_ALLOC_PCT` small until you’re confident. Use `GRID_BREAKOUT_ACTION=cancel` to stop grids when price exits the range.
- AI policy is **gated**: it can only choose actions/symbols from data the bot provides, and the engine still enforces exchange rules (minQty/minNotional), risk flags, allocation caps, and daily loss caps. It can still lose money—test on small size or testnet first.
- State is persisted to `PERSISTENCE_PATH` (default `./data/state.json`) so the bot resumes last strategies/balances after restart.
