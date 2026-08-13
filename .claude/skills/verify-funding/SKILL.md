---
name: verify-funding
description: >-
  Runs and interprets verify-funding-model.js, the read-only check for whether Hyperliquid
  pays perp funding as an hourly SNAPSHOT (full payment for holding at the top of the hour)
  or PRO-RATES it by how long the position was held. Use this whenever anyone proposes
  changing the funding-bot's entry-window settings (minHoursToSettle, maxHoursToSettle),
  asks whether entering closer to settlement collects the same funding, asks whether holding
  through more settlements earns more, or asks whether some funding-timing tweak "would be
  profitable" — the honest answer depends entirely on which model Hyperliquid uses, and the
  two models point in opposite directions. Also use it before changing ANY live trading
  parameter that rests on an inference nobody has measured against real account data. If a
  change to entry timing, hold duration, or settlement count is on the table, run this first.
---

# Verify the funding model before retiming entries

## What this settles, and why guessing is expensive

The funding-bot earns almost all of its money from carry, not direction. Over a
representative 63-trade sample the price leg netted **+$0.03** while funding netted
**+$0.42** — the directional exposure is close to a coin flip that averages out, and the
funding is the entire business. That makes "when should we be holding the position?" the
highest-leverage question in the whole system.

It has two possible answers, and they are opposites:

- **SNAPSHOT** — you get the full hourly payment for holding across the top of the hour,
  regardless of whether you held for 55 minutes or 5. Entering later in the hour then
  collects *identical* funding with far less price exposure, so narrowing the entry window
  is close to free risk reduction.
- **PRO-RATA** — the payment scales with how long you held during that hour. Narrowing the
  window now cuts income roughly proportionally, and doing it would actively lose money.

Same change, opposite sign. The public documentation is genuinely ambiguous here (secondary
sources contradict each other, and the primary docs are often unreachable), so the only
trustworthy answer comes from the account's own funding ledger. That is what the script
reads. Do not resolve this from reasoning, docs, or a model's prior — measure it.

## Running it

```bash
node verify-funding-model.js            # last 30 days
node verify-funding-model.js 7          # last 7 days
node verify-funding-model.js --selftest # offline: proves the discriminator works
```

Requirements: `PRIVATE_KEY` env var or `~/.b402/wallet.json`, plus network access to
`api.hyperliquid.xyz`. Sandboxed/CI environments usually block that host — if the run dies
with `HL info 403: Host not in allowlist`, the environment is the problem, not the script.
Run it on the deployment box instead and report that rather than pretending to a result.

The script is read-only by construction: it builds an address-only client that cannot sign,
places no orders, and writes no state. It is safe to run against the live wallet while the
bot is trading. If asked to "check whether it's safe", confirm this from the source rather
than assuring from memory.

Run `--selftest` first when there is any doubt about the tool itself — it feeds synthetic
data for both models through the same discriminator offline and should report 9/9.

## How it decides

Each `userFunding` row carries `usdc`, `szi` and `fundingRate`, related by
`usdc = szi × oraclePrice × fundingRate` — with **no duration term** if payment is a
snapshot. So the script backs out `impliedPx = usdc / (szi × fundingRate)`, compares it to
the 1h candle close, and the ratio is the fraction of a full payment actually received.
Hold durations come from the bot's own trade history in the state file. It then fits the
observed ratios against both models (`|r − 1|` vs `|r − h/60|`) and reports which fits.

## Reading the verdict

Report the verdict plainly, including the fit errors and the model-separation figure. Then
apply exactly what it licenses — and nothing beyond:

| Verdict | What it means | What it licenses |
|---|---|---|
| `SNAPSHOT` | Payments are flat regardless of hold time | Narrowing `maxHoursToSettle` — same income, less exposure |
| `PRO-RATED` | Payments track `heldMinutes/60` | Leave the entry window alone; narrowing would cut income |
| `INCONCLUSIVE` | This data cannot separate the models | **Nothing.** Change no parameter |
| `UNCLEAR` | Fits neither model cleanly | **Nothing.** Show the table and investigate |

## Expect INCONCLUSIVE the first time

This is the outcome most likely to be misread, so handle it carefully.

When every position is held close to a full hour, pro-rata predicts ~0.97 of a full payment
and snapshot predicts 1.00. Those are indistinguishable, and no quantity of additional data
fixes it — the sample simply carries no information about the question. The script detects
this via the `separation` figure and returns INCONCLUSIVE rather than a confident-looking
SNAPSHOT.

The bot's default configuration produces exactly this shape: a wide entry window plus
multi-settlement holds means most positions sit through near-complete hours. So an
INCONCLUSIVE first result is the tool working correctly, not a failure, and not something
to retry with a longer lookback.

The only way out is data with hold times far from 60 minutes — some entries made roughly
5–20 minutes before settlement. Note that uniform hold times are fine *if* they sit far
from a full hour: 40 positions all held ~10 minutes discriminate perfectly well, because
there the two models predict wildly different payments. It is proximity to 60 minutes that
destroys the signal, not lack of variety. Getting that data means a deliberate, bounded
experiment at a narrowed window, which is a decision for the operator to make knowingly.

## The guardrail

This skill exists because the tempting move is to reason your way to an answer and ship it.
Do not change `minHoursToSettle`, `maxHoursToSettle`, `maxSettlements`, or any other live
trading parameter on the strength of inference, a documentation snippet, or a plausible
argument. Real money moves on those numbers, unsupervised, and a wrong sign converts a
risk-reduction into an income cut.

If the verdict is INCONCLUSIVE or UNCLEAR, the correct output is to say so and stop. "I
could not establish this" is a complete and useful answer here. Offer the experiment that
would produce discriminating data, and let the operator decide whether to run it.
