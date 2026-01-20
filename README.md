# Binance AI Bot

Autonomous Binance trading assistant with an OpenAI-driven strategy layer and a React dashboard. Generates short, medium, and long-horizon plans while accounting for Binance fees and configurable risk caps.

## Features
- Fastify API with Binance Spot client, OpenAI strategy reinforcement, and simple scheduler to keep strategies fresh.
- Heuristic risk engine that sizes positions by risk-per-trade and estimates maker/taker fees.
- React + Vite dashboard for live market stats, AI notes, balances, and quick simulated trades.
- Dockerfiles + `docker-compose` for Linux deployment; GitHub Actions CI for lint/test/build.

## Quick start (local)
1) Copy env: `cp .env.example .env` and fill `BINANCE_API_KEY/SECRET` (use restricted keys) and `OPENAI_API_KEY`. Keep `TRADING_ENABLED=false` until ready.
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

`VITE_API_URL` can be overridden to point the frontend at a remote API. In Compose it defaults to `http://api:8788`.

## CI/CD
`.github/workflows/ci.yml` runs `npm ci`, lint, tests, and builds for both workspaces on push/PR to `main`.

## API
- `GET /health` — status + lastUpdated
- `GET /strategy` — current market snapshot, balances, strategies, and risk settings
- `POST /strategy/refresh` — force refresh now
- `POST /trade/execute` — `{ side, quantity, price?, type? }`; simulated unless `TRADING_ENABLED=true`

## Notes and safety
- The bot estimates Binance spot fees (0.1% maker/taker) and limits size via `MAX_POSITION_SIZE_USDT` + `RISK_PER_TRADE_BP`.
- OpenAI assists with thesis notes; heuristics still produce numbers when AI is offline.
- Live trading is **off by default**. Enable only after testing; consider using Binance testnet or a sub-account with tight limits.
