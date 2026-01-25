# Binance AI Bot

Autonomous Binance trading assistant with an OpenAI-driven strategy layer and a React dashboard. Generates short, medium, and long-horizon plans while accounting for Binance fees and configurable risk caps.

## Features
- Fastify API with Binance Spot client, OpenAI strategy reinforcement, and simple scheduler to keep strategies fresh.
- Heuristic risk engine that sizes positions by risk-per-trade and estimates maker/taker fees.
- React + Vite dashboard for live market stats, AI notes, balances, and quick simulated trades.
- Universe scanner that auto-picks a wallet-aware “best” symbol and reports the last auto-trade decision.
- Optional portfolio mode: multiple concurrent long positions, conversion to required quote assets, and “risk-off” return to `HOME_ASSET`.
- Dockerfiles + `docker-compose` for Linux deployment; GitHub Actions CI for lint/test/build.

## Quick start (local)
1) Copy env: `cp .env.example .env` and fill `BINANCE_API_KEY/SECRET` (use restricted keys) and `OPENAI_API_KEY`. Keep `TRADING_ENABLED=false` until ready.
   - EU-friendly quotes: `QUOTE_ASSET=USDC` and `ALLOWED_QUOTES=USDC,EUR`.
   - For full discovery, leave `ALLOWED_SYMBOLS=` empty. If you set `ALLOWED_SYMBOLS`, the bot will only scan/trade within that allow-list.
   - Auto-trading requires both `AUTO_TRADE_ENABLED=true` and `TRADING_ENABLED=true`.
   - Portfolio mode (optional): set `PORTFOLIO_ENABLED=true`, choose `HOME_ASSET` (e.g. `USDC`), and optionally `CONVERSION_ENABLED=true` if you allow auto-converting into BTC/XRP quotes.
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
- `POST /portfolio/panic-liquidate` — `{ dryRun?: boolean, stopAutoTrade?: boolean }` (sell free balances to `HOME_ASSET` where markets exist)

## Notes and safety
- The bot estimates Binance spot fees (0.1% maker/taker) and limits size via `MAX_POSITION_SIZE_USDT` + `RISK_PER_TRADE_BP`.
- OpenAI assists with thesis notes; heuristics still produce numbers when AI is offline.
- Live trading is **off by default**. Enable only after testing; consider using Binance testnet or a sub-account with tight limits.
- Frontend shows the current active symbol, the top candidates from the scanner, and the last auto-trade decision/reason.
- `MIN_QUOTE_VOLUME` is enforced in `HOME_ASSET` terms (BTC/ETH quote volumes are converted using their `*HOME_ASSET` market).
- `DAILY_LOSS_CAP_PCT` enables emergency stop when equity drawdown exceeds the threshold (PnL baseline resets daily).
- News sentiment uses RSS/Atom feeds; `NEWS_FEEDS` must point to actual XML feeds (not HTML pages).
- State is persisted to `PERSISTENCE_PATH` (default `./data/state.json`) so the bot resumes last strategies/balances after restart.
