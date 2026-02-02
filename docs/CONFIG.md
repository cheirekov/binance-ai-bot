# Configuration (v2.4 “Pro Universe”)

This document is the single source of truth for configuring the bot via `.env`.

## Safety rules (non-negotiable)

- **Never put real funds at risk by accident**: default config is conservative.
- **Hard gates are always enforced in code**:
  - `TRADING_ENABLED=false` means simulated orders only.
  - Risk Governor `HALT` blocks new risk and blocks conversions/unwind actions.
  - `DAILY_LOSS_CAP_PCT` blocks new risk and conversions/unwind when breached.
  - Exchange filters (minQty/minNotional/stepSize) must be respected by all order placement.
- **Secrets are never printed**. Do not log or share `.env`.

---

## Getting started (Docker only)

1) Create env:
```bash
cp .env.spot.basic.example .env
```

2) Fill:
- `BINANCE_API_KEY`
- `BINANCE_API_SECRET`

3) Start:
```bash
docker-compose up --build
```

Endpoints:
- API: `http://localhost:8788`
- UI: `http://localhost:4173`

---

## Basic config (recommended)

### Exchange / API
- `BINANCE_API_KEY` / `BINANCE_API_SECRET`  
  Restricted key recommended (spot trading + read-only as needed).

- `TRADE_VENUE=spot|futures`  
  Spot is the default and recommended.

### Safety switches
- `TRADING_ENABLED=true|false` (**default false**)  
  Must be `true` for real orders.

- `AUTO_TRADE_ENABLED=true|false` (**default false**)  
  Enables automated portfolio trading tick.

### Home vs quote (important)
- `HOME_ASSET`  
  Your “accounting currency” used for equity / risk caps / mark-to-market (examples: `USDC`, `EUR`).

- `QUOTE_ASSETS`  
  Controls discovery and eligible symbols for **new entries**.

---

## Universe discovery (full exchange, multi-quote)

### `QUOTE_ASSETS=AUTO` (recommended)
When `QUOTE_ASSETS=AUTO`, the bot considers **all quote assets** present on the exchange, then filters:

- Removes stable-stable markets
- Removes leverage tokens
- Removes `EXCLUDED_ASSETS`
- Requires a quote→home conversion rate to exist (direct or 2-hop via bridges)

This enables discovery across quotes like `BTC`, `ETH`, `BNB`, `EUR`, `BRL`, `JPY`, etc. as long as quote→home is resolvable.

### Fixed `QUOTE_ASSETS=...`
Example:
- `QUOTE_ASSETS=USDC,EUR,BTC`

### Exclusions (no hardcoded bans)
- `EXCLUDED_ASSETS=` (**default empty**)  
  Global exclusion list (applies to discovery and to rate/conversion routing).  
  Example (EU): `EXCLUDED_ASSETS=USDT`

- `TRADE_DENYLIST=`  
  Always excluded symbols even if discovered or manually listed.

- `TRADE_UNIVERSE=`  
  Optional explicit allow-list; when set, discovery is bypassed and only those symbols are eligible for new entries.

---

## Quote→Home rate engine (2-hop)

Used for:
- Discovery normalization (volume, scoring)
- Mark-to-market reporting for non-home quotes

### Rate routing env
- `BRIDGE_ASSETS=BTC,ETH,BNB,USDT,USDC,EUR` (default)  
  Intermediate assets allowed for 2-hop routing.

---

## Conversions (fund non-home quotes safely)

Required when:
- You trade a symbol whose **quote** is not `HOME_ASSET`
- Example: `HOME_ASSET=USDC` but trading `BNBETH` requires holding `ETH`

### Enable/disable
- `CONVERSION_ENABLED=true|false` (**default false**)  
  Conservative default: conversions are opt-in.

### Conversion execution mode
- `CONVERT_MODE=limit_ttl|market` (**default `limit_ttl`**)  
  - `limit_ttl`: small limit orders with TTL, cancel if not filled (recommended)
  - `market`: requires explicit opt-in; higher slippage risk

### Conversion controls
- `CONVERT_TTL_SECONDS=15` (default)
- `CONVERT_MAX_RETRIES=2` (default)
- `CONVERT_SLIPPAGE_BPS=15` (default)

---

## Quote pools (reduce fee churn)

Quote pools help avoid repeated small conversions by keeping a small reserve in key quote assets.

- `QUOTE_POOL_TARGETS="BTC:0.10,ETH:0.10,BNB:0.05"`  
  Target % of equity in each asset (accepts `0.10` or `10`).

- `QUOTE_POOL_REBALANCE_BPS=80` (default)  
  Only top-up when below target by more than this threshold.

**Rules**:
- Pools are **top-up only** (no selling pools back to HOME).
- Pools are blocked during `HALT`, emergency stop, or breached daily loss cap.

---

## Grid trading (spot)

- `GRID_ENABLED=true|false` (default false)
- `GRID_SYMBOLS=` optional pinned list
- `GRID_AUTO_DISCOVER=true|false`

Grid safety:
- In bad regime, bot pauses **new BUYs** for that symbol, keeps SELLs active.
- Uses quote→home rates for reporting when quote != home.
- Buys may trigger conversions to fund the quote asset when needed (when conversions are enabled).

---

## Unwanted inventory unwind (optional)

Safe “cleanup” that avoids dumping inventory by default.

- `UNWIND_ENABLED=true|false` (**default false**)
- `UNWIND_MODE=ladder|market` (**default `ladder`**)
- `UNWIND_LADDER_PCTS="0.5,1.0,2.0"` (default)
- `UNWIND_REQUOTE_MINUTES=30` (default)
- `UNWIND_EXCLUDED_ASSETS="BTC,ETH,BNB,USDT,USDC,EUR"` (default)

Rules:
- Runs only in `NORMAL/CAUTION`
- Never runs during `HALT`, emergency stop, or breached daily loss cap

---

## Risk & profitability knobs (after-fees minded)

- `MAX_POSITION_SIZE_USDT=200`
- `RISK_PER_TRADE_BP=50`
- `DAILY_LOSS_CAP_PCT=3`
- `MAX_VOLATILITY_PCT=18`
- `MIN_QUOTE_VOLUME=5000000`
- `MIN_QUOTE_VOLUME_MODE=fixed|adaptive`

---

## AI controls (cost-aware)

### Modes
- `AI_MODE=off|advisory|gated-live`

### Blocked-call policy (token hygiene)
- `AI_POLICY_CALL_WHEN_BLOCKED=never|hourly|always` (**default `never`**)  
  “Blocked” means `HALT`, emergency stop, or daily loss cap breached.

### Tuning viability guard
- `MIN_UNIVERSE_CANDIDATES=20` (default)  
  If AI proposes tightening and the simulated filtered universe drops below this, the tightening is rejected.

---

## Persistence (best-effort)

- `PERSISTENCE_PATH=./data/state.json`
- `PERSIST_TO_SQLITE=false`
- `SQLITE_PATH=/app/data/bot.sqlite`

SQLite failures must never block trading.

---

## Templates

- `.env.spot.basic.example` — minimal, conservative
- `.env.spot.advanced.example` — all knobs
- `.env.reference.example` — exhaustive reference format