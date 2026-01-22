# Binance AI Bot

Autonomous Binance trading assistant with an OpenAI-driven strategy layer and a React dashboard. Generates short, medium, and long-horizon plans while accounting for Binance fees and configurable risk caps.

## Features
- Fastify API with Binance Spot client, OpenAI strategy reinforcement, and simple scheduler to keep strategies fresh.
- Heuristic risk engine that sizes positions by risk-per-trade and estimates maker/taker fees.
- React + Vite dashboard for live market stats, AI notes, balances, and quick simulated trades.
- Dockerfiles + `docker-compose` for Linux deployment; GitHub Actions CI for lint/test/build.

## Quick start (local)
1) Copy env: `cp .env.example .env` and fill `BINANCE_API_KEY/SECRET` (use restricted keys) and `OPENAI_API_KEY`. Keep `TRADING_ENABLED=false` until ready. Default symbol is `BTCEUR`; set `ALLOWED_SYMBOLS` and `ALLOWED_QUOTES` to what you can trade (e.g., EU: `ALLOWED_QUOTES=USDC,EUR` and symbols `BTCUSDC,ETHUSDC,...`). `AUTO_SELECT_SYMBOL=true` will score allowed symbols and pick the strongest on refresh. If you deploy the UI, set `BASIC_AUTH_USER/PASS` and `API_KEY/CLIENT_KEY`.
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

## Notes and safety
- The bot estimates Binance spot fees (0.1% maker/taker) and limits size via `MAX_POSITION_SIZE_USDT` + `RISK_PER_TRADE_BP`.
- OpenAI assists with thesis notes; heuristics still produce numbers when AI is offline.
- Live trading is **off by default**. Enable only after testing; consider using Binance testnet or a sub-account with tight limits.
- Frontend lets you pick among `ALLOWED_SYMBOLS` and fire simulated trades at the suggested size.
- State is persisted to `PERSISTENCE_PATH` (default `./data/state.json`) so the bot resumes last strategies/balances after restart.
