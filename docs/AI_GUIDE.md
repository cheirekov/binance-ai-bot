# AI guide

The bot can run **with or without** AI.

The important rule is: **AI does not bypass safety gates**.

## AI pillars

1. **Strategist / Insight**
   - Adds short human-readable rationale to strategy output.
   - Controlled by `AI_STRATEGY_MODEL` (or `AI_MODEL`).

2. **Policy**
   - Proposes actions like OPEN/CLOSE/HOLD and bounded tuning.
   - Controlled by `AI_POLICY_MODEL` (or `AI_MODEL`).

3. **Coach (slow loop)**
   - Periodically reviews compact summaries and proposes bounded changes.
   - Controlled by `AI_COACH_*` settings.

## AI Mode

- `AI_MODE=off`
  - No LLM calls.

- `AI_MODE=advisory`
  - AI creates suggestions, but the engine does not open new positions based on AI.

- `AI_MODE=gated-live`
  - AI can propose actions.
  - The engine executes only if: trading is enabled, symbol is trade-allowed, governor allows entries, and autonomy profile allows it.

## Autonomy profiles

`AI_AUTONOMY_PROFILE` controls what the coach/policy may auto-apply.

- `safe` (default): suggest-only; never relax risk automatically
- `standard`: may auto-apply risk tightening; may auto-blacklist
- `pro`: may relax risk only within envelope and only with explicit operator allow + governor NORMAL
- `aggressive`: like pro, but can take faster actions (still bounded)

## Token/cost control

Use these to control token usage:

- `AI_POLICY_MIN_INTERVAL_SECONDS`
- `AI_POLICY_MAX_CALLS_PER_DAY`
- `AI_POLICY_MAX_CANDIDATES`

## Recommended settings

Beginner:

```env
AI_MODE=off
AI_AUTONOMY_PROFILE=safe
```

Advisory AI:

```env
AI_MODE=advisory
AI_AUTONOMY_PROFILE=safe
```

Gated live (still keep TRADING_ENABLED=false while testing):

```env
AI_MODE=gated-live
AI_AUTONOMY_PROFILE=safe
AI_POLICY_ALLOW_RISK_RELAXATION=false
```
