#!/usr/bin/env node
/**
 * verify-funding-model.js — does Hyperliquid pay funding as an hourly SNAPSHOT
 * or PRO-RATED by how long the position was held during that hour?
 *
 * READ-ONLY. Places no orders, writes no state, mutates nothing. Safe to run
 * against the live wallet while the bot is running.
 *
 * Why it matters: if funding is a snapshot (you hold at the top of the hour, you
 * get the whole payment), then entering late in the hour collects the same income
 * with far less price exposure — narrowing the entry window is close to free. If
 * it is pro-rated, narrowing the window cuts income roughly proportionally and is
 * actively harmful. The two answers point opposite directions, so measure first.
 *
 * The test: each userFunding row carries usdc (what you were actually paid), szi
 * (signed position size) and fundingRate. Those are related by
 *
 *     usdc = szi * oraclePrice * fundingRate
 *
 * with NO duration term if payment is a snapshot. So back out the implied price
 *
 *     impliedPx = usdc / (szi * fundingRate)
 *
 * and compare it against the real price that hour (1h candle close). The ratio
 * impliedPx / actualPx is the fraction of a full payment that was received:
 *
 *     ratio ~ 1.00 regardless of hold time      -> SNAPSHOT
 *     ratio tracks (minutes held / 60)          -> PRO-RATED
 *
 * Hold durations come from the bot's own trade history in the state file, so the
 * discriminating power depends on having trades with a spread of hold times. The
 * script says so explicitly when the spread is too narrow to call.
 *
 * Run:  node verify-funding-model.js [lookbackDays]
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { homedir } from 'os'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)

const LOOKBACK_DAYS = parseFloat(process.argv[2] || '30')
const STATE_DIR  = process.env.STATE_DIR || join(homedir(), '.b402')
const PKG_ROOT   = _require.resolve('@b402ai/trader/package.json').replace(/[\\/]package\.json$/, '')
const PKG_DIST   = join(PKG_ROOT, 'dist')
const STATE_FILE = join(STATE_DIR, 'funding-bot-state.json')
const u = p => pathToFileURL(p).href

// ── ANALYSIS ──────────────────────────────────────────────────────────────────
const mean = a => a.reduce((s, v) => s + v, 0) / a.length

// Given reconstructed payments, decide which funding model the data supports.
// ratio = fraction of a full payment actually received; heldMin = minutes the
// position had been open when the payment landed.
function analyse(samples) {
  const ratios = samples.map(s => s.ratio)
  const meanRatio = mean(ratios)
  const sd = Math.sqrt(mean(ratios.map(r => (r - meanRatio) ** 2)))

  const timed = samples.filter(s => s.heldMin != null)
  let lo = null, hi = null, errSnap = null, errPro = null, separation = null
  if (timed.length >= 5) {
    const hs = timed.map(s => s.heldMin)
    lo = Math.min(...hs); hi = Math.max(...hs)
    // Fit the data against both models directly rather than looking for a
    // correlation — correlation misreads a sample where every hold is similar.
    errSnap = mean(timed.map(s => Math.abs(s.ratio - 1)))            // snapshot predicts 1.0
    errPro  = mean(timed.map(s => Math.abs(s.ratio - s.heldMin / 60))) // pro-rata predicts h/60
    // How far apart the two predictions actually are on THIS sample. Near zero
    // when every position was held close to a full hour, because then pro-rating
    // and snapshot predict nearly the same payment and no data can separate them.
    separation = mean(timed.map(s => Math.abs(1 - s.heldMin / 60)))
  }

  let verdict
  if (timed.length < 5)            verdict = 'INCONCLUSIVE'  // no hold times to fit against
  else if (separation < 0.15)      verdict = 'INCONCLUSIVE'  // models coincide on this sample
  else if (errSnap < errPro / 2)   verdict = 'SNAPSHOT'
  else if (errPro < errSnap / 2)   verdict = 'PRO-RATED'
  else                             verdict = 'UNCLEAR'

  return { n: samples.length, meanRatio, sd, timed: timed.length,
           errSnap, errPro, separation, lo, hi, verdict }
}

function printReport(samples) {
  const a = analyse(samples)
  console.log('\n  mean fraction-of-full-payment: ' + a.meanRatio.toFixed(3) + '  (sd ' + a.sd.toFixed(3) + ')')
  if (a.timed >= 5) {
    console.log('  hold times: ' + a.lo.toFixed(0) + '–' + a.hi.toFixed(0) + ' min across ' + a.timed + ' payments')
    console.log('  fit error vs snapshot (predicts 1.00): ' + a.errSnap.toFixed(3))
    console.log('  fit error vs pro-rata (predicts h/60): ' + a.errPro.toFixed(3))
    console.log('  model separation on this sample:       ' + a.separation.toFixed(3)
      + (a.separation < 0.15 ? '   <- too small to tell the models apart' : ''))
  }
  console.log('\n' + '─'.repeat(76))
  if (a.verdict === 'SNAPSHOT') {
    console.log('VERDICT: SNAPSHOT — full payment regardless of how long the position was held.')
    console.log('Holding across the top of the hour earns the whole payment, so entering later')
    console.log('in the hour collects the same funding with less price exposure.')
    console.log('=> Narrowing maxHoursToSettle is safe: same income, less risk.')
  } else if (a.verdict === 'PRO-RATED') {
    console.log('VERDICT: PRO-RATED — payment scales with time held during the hour.')
    console.log('Payments fit h/60 far better than a flat full payment.')
    console.log('=> Do NOT narrow the entry window; it would cut funding income proportionally.')
  } else if (a.verdict === 'INCONCLUSIVE') {
    console.log('VERDICT: INCONCLUSIVE — this data cannot separate the two models.')
    if (a.timed < 5) {
      console.log('Too few payments could be matched to a known hold time.')
    } else {
      console.log('Positions were all held close to a full hour, so pro-rating and snapshot')
      console.log('predict nearly the same payment. Nothing here favours either one.')
    }
    console.log('=> Do not change the entry window on this basis. Re-run once some positions')
    console.log('   have been opened well inside the hour (say 5-20 min before settlement).')
  } else {
    console.log('VERDICT: UNCLEAR — neither model fits cleanly '
      + '(snapshot err ' + a.errSnap.toFixed(3) + ', pro-rata err ' + a.errPro.toFixed(3) + ').')
    console.log('=> Inspect the table above before changing any entry-window setting.')
  }
  console.log('─'.repeat(76))
  return a
}

// ── SELF-TEST ─────────────────────────────────────────────────────────────────
// Proves the discriminator separates the two models before it is trusted on real
// money. Runs offline: no wallet, no network. `node verify-funding-model.js --selftest`
if (process.argv.includes('--selftest')) {
  const noise = i => ((i * 2654435761) % 1000) / 1000 - 0.5   // deterministic jitter
  const held  = i => 4 + (i * 7) % 56                          // 4..59 min spread
  const mk = (n, ratioFn) => Array.from({ length: n }, (_, i) => ({
    ratio: ratioFn(held(i), noise(i)), heldMin: held(i),
  }))

  const fixed = (n, h, ratioFn) => Array.from({ length: n }, (_, i) => ({
    ratio: ratioFn(h, noise(i)), heldMin: h + noise(i),
  }))

  const cases = [
    ['snapshot, clean',          mk(40, (h, z) => 1 + z * 0.02),      'SNAPSHOT'],
    ['snapshot, noisy price',    mk(40, (h, z) => 1 + z * 0.15),      'SNAPSHOT'],
    ['pro-rated by hold time',   mk(40, (h, z) => h / 60 + z * 0.02), 'PRO-RATED'],
    // The trap: hold times all near a full hour make the models agree, so no
    // amount of data separates them. Must NOT come back SNAPSHOT.
    ['all held ~58min, full pay', fixed(40, 58, (h, z) => 1 + z * 0.02),      'INCONCLUSIVE'],
    ['all held ~58min, pro-rata', fixed(40, 58, (h, z) => h / 60 + z * 0.02), 'INCONCLUSIVE'],
    // Uniform hold times are fine when they sit far from 60min — the two models
    // predict very different payments there, so a short uniform hold still tells us.
    ['all held ~10min, full pay', fixed(40, 10, (h, z) => 1 + z * 0.02),      'SNAPSHOT'],
    ['all held ~10min, pro-rata', fixed(40, 10, (h, z) => h / 60 + z * 0.02), 'PRO-RATED'],
    ['too few samples',          mk(3,  (h, z) => h / 60 + z * 0.02), 'INCONCLUSIVE'],
    ['fits neither model',       mk(40, (h, z) => 0.55 + z * 0.05),   'UNCLEAR'],
  ]

  let pass = 0
  console.log('\nself-test — does the discriminator separate the models?\n')
  for (const [name, samples, want] of cases) {
    const got = analyse(samples).verdict
    const ok = got === want
    if (ok) pass++
    console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(26) + ' expected ' + want.padEnd(13) + ' got ' + got)
  }
  console.log('\n  ' + pass + '/' + cases.length + ' passed\n')
  process.exit(pass === cases.length ? 0 : 1)
}

const privateKey = process.env.PRIVATE_KEY ||
  (() => {
    const wf = join(homedir(), '.b402', 'wallet.json')
    if (!existsSync(wf)) throw new Error('Set PRIVATE_KEY env var or provide ~/.b402/wallet.json')
    return JSON.parse(readFileSync(wf, 'utf8')).privateKey
  })()

const ethers                = await import('ethers')
const { HyperliquidClient } = await import(u(join(PKG_DIST, 'hyperliquid/client.js')))
const { spawnAgent }        = await import(u(join(PKG_DIST, 'identity/derivation.js')))

// Address-only client — cannot sign, so this script structurally cannot trade.
const identity = await spawnAgent(new ethers.Wallet(privateKey), 'hero')
const hl = new HyperliquidClient(identity.hl.address)
await hl.ensureMeta()

const now = Date.now()
const since = now - LOOKBACK_DAYS * 24 * 3600 * 1000
const fmtPx = n => !isFinite(n) ? '—' : Math.abs(n) >= 1000 ? n.toFixed(2) : Math.abs(n) >= 1 ? n.toFixed(4) : n.toPrecision(6)

console.log(`\nHyperliquid funding model check — wallet ${identity.hl.address}`)
console.log(`Window: last ${LOOKBACK_DAYS}d (read-only, no orders placed)\n`)

// ── 1. funding ledger ─────────────────────────────────────────────────────────
const rows = await hl.info.userFunding({ user: identity.hl.address, startTime: since, endTime: now })
if (!rows?.length) {
  console.log('No funding payments in this window. Let the bot collect a few settlements, then re-run.')
  process.exit(0)
}
console.log(`Funding payments found: ${rows.length}`)

// ── 2. hold durations from the bot's own trade history ────────────────────────
// A payment at time T belongs to whichever trade in `coin` was open across T.
const history = existsSync(STATE_FILE)
  ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')).history ?? [])
  : []
if (!history.length) console.log('WARNING: no trade history in state file — hold times unavailable.\n')

function heldMinutesAt(coin, t) {
  const tr = history.find(h => h.asset === coin && h.openedAt <= t && (h.closedAt ?? Infinity) >= t)
  if (!tr) return null
  const mins = (t - tr.openedAt) / 60000
  // only the portion inside the settlement hour can matter for pro-rating
  return Math.max(0, Math.min(60, mins))
}

// ── 3. reference price per (coin, hour) from 1h candles ───────────────────────
const priceCache = new Map()
async function priceAt(coin, t) {
  const hour = Math.floor(t / 3600000) * 3600000
  const key = coin + ':' + hour
  if (priceCache.has(key)) return priceCache.get(key)
  let px = null
  try {
    const c = await hl.info.candleSnapshot({ coin, interval: '1h', startTime: hour - 3600000, endTime: hour + 3600000 })
    // prefer the candle covering the settlement instant
    const hit = (c ?? []).find(x => Number(x.t) <= hour && hour <= Number(x.T ?? Number(x.t) + 3600000)) ?? (c ?? [])[0]
    px = hit ? parseFloat(hit.c) : null
  } catch { px = null }
  priceCache.set(key, px)
  return px
}

// ── 4. build the sample ───────────────────────────────────────────────────────
const samples = []
for (const r of rows) {
  const d = r?.delta ?? {}
  const usdc = parseFloat(d.usdc ?? 'NaN')
  const szi  = parseFloat(d.szi ?? 'NaN')
  const rate = parseFloat(d.fundingRate ?? 'NaN')
  const coin = d.coin
  const t    = Number(r.time)
  if (!coin || !isFinite(usdc) || !isFinite(szi) || !isFinite(rate) || szi === 0 || rate === 0) continue

  const impliedPx = Math.abs(usdc / (szi * rate))
  const actualPx  = await priceAt(coin, t)
  if (!actualPx) continue

  samples.push({
    t, coin, usdc, szi, rate,
    impliedPx, actualPx,
    ratio: impliedPx / actualPx,
    heldMin: heldMinutesAt(coin, t),
  })
}

if (!samples.length) {
  console.log('Could not reconstruct any payment (missing szi/fundingRate or price data). Nothing to conclude.')
  process.exit(0)
}

// ── 5. report ─────────────────────────────────────────────────────────────────
console.log(`Reconstructed ${samples.length} of ${rows.length} payments\n`)
console.log('  time              coin      usdc       held    fraction-of-full-payment')
console.log('  ' + '─'.repeat(72))
for (const s of samples.slice(0, 40)) {
  const held = s.heldMin == null ? '  ?  ' : (s.heldMin.toFixed(0) + 'm').padStart(5)
  console.log('  ' + new Date(s.t).toISOString().slice(0, 16).replace('T', ' ')
    + '  ' + s.coin.padEnd(8)
    + (s.usdc >= 0 ? '+' : '') + s.usdc.toFixed(6).padStart(10)
    + '  ' + held
    + '    ' + s.ratio.toFixed(3)
    + '   (implied px ' + fmtPx(s.impliedPx) + ' vs actual ' + fmtPx(s.actualPx) + ')')
}
if (samples.length > 40) console.log(`  … ${samples.length - 40} more`)

printReport(samples)
console.log('\n(read-only: no orders placed, no state written)\n')
