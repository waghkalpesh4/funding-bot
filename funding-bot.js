#!/usr/bin/env node
/**
 * funding-bot.js — Funding Rate Harvester + Dashboard
 * Bot + dashboard in one process. Dashboard: http://localhost:3505
 * Run: node C:\Users\waghk\funding-bot.js
 */

import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { homedir } from 'os'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)

// ── CONFIG (editable from dashboard) ──────────────────────────────────────────
let CFG = {
  dryRun:         false,
  maxPositions:   4,
  positionUsd:    20,
  leverage:       1,
  stopLossPct:      1.5,
  trailingStopPct:      2.0,  // trail 2% below peak (0 = disabled)
  highAprThreshold:     300,  // APR % above which wider trail applies
  trailingStopHighApr:  5.0,  // trail % for high-APR positions
  dynamicSizing:        true, // scale position size with APR
  maxPositionUsd:       60,   // max size when APR >= highAprThreshold
  maxSettlements:           1,  // hourly settlements to collect before exiting (1 = current behaviour)
  highAprMaxSettlements:    3,  // settlements for positions with APR >= highAprThreshold
  aprTrendFilter:        true,  // skip entry if APR has fallen >20% from its 6-scan peak
  regimeFlipCooldownMins:  10,  // mins to wait after crowded_long→neutral before allowing LONGs
  maxHoldHours:     8,
  minFundingApr:    60,       // raised: 30%+ too marginal, focus on 60%+ quality yield
  minHoursToSettle: 0.1,  // don't enter in last 6min before hourly funding tick (slippage risk)
  maxHoursToSettle: 1.0,  // hourly funding — 1.0 effectively means "any time in the hour"
  exitAfterSettleMins: 3,  // exit 3min after settlement — funding collected, pure directional risk after
  trendFilter:      true,  // skip if price trend opposes entry direction
  maxVolatilityPct: 5,     // skip if 1h range > 5% (0 = disabled)
  scanIntervalMs:   60 * 1000, // 1 min — entry scan
  liveRefreshMs:    5 * 1000,  // 5s — SL + price monitoring
  priceChangePct:   1.0,   // emergency exit if price moves this % in one tick (0 = disabled)
}

const PORT       = parseInt(process.env.PORT || '3505')
const STATE_DIR  = process.env.STATE_DIR || join(homedir(), '.b402')
mkdirSync(STATE_DIR, { recursive: true })
const PKG_ROOT   = _require.resolve('@b402ai/trader/package.json').replace(/[\\/]package\.json$/, '')
const PKG_DIST   = join(PKG_ROOT, 'dist')
const STATE_FILE  = join(STATE_DIR, 'funding-bot-state.json')
const CONFIG_FILE = join(STATE_DIR, 'funding-bot-config.json')
const u = p => pathToFileURL(p).href

// Load persisted config on top of defaults
if (existsSync(CONFIG_FILE)) {
  try { Object.assign(CFG, JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))) } catch {}
}

// ── LOAD WALLET + CLIENT ───────────────────────────────────────────────────────
const privateKey = process.env.PRIVATE_KEY ||
  (() => {
    const wf = join(homedir(), '.b402', 'wallet.json')
    if (!existsSync(wf)) throw new Error('Set PRIVATE_KEY env var or provide ~/.b402/wallet.json')
    return JSON.parse(readFileSync(wf, 'utf8')).privateKey
  })()
const ethers                = await import('ethers')
const { HyperliquidClient } = await import(u(join(PKG_DIST, 'hyperliquid/client.js')))
const { spawnAgent }        = await import(u(join(PKG_DIST, 'identity/derivation.js')))

const identity = await spawnAgent(new ethers.Wallet(privateKey), 'hero')
const hl = new HyperliquidClient(CFG.dryRun ? identity.hl.address : identity.hl.privateKey)
await hl.ensureMeta()

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a)

// ── RUNTIME STATE ─────────────────────────────────────────────────────────────
let paused            = false
let scanning          = false
let scanTimer         = null
let lastRates         = {}      // { asset: { apr, volume24h, ts } }
let lastMidPrices     = {}      // { asset: price } updated during scan
let cachedBal         = null    // last fetched balance
let btcFundingRegime  = 'neutral'  // 'crowded_long' | 'neutral' — updated each scan
let crowdedLongRatio  = 0.5        // % of liquid assets with positive funding
let prevRegime        = 'neutral'  // previous regime value for flip detection
let regimeFlipTime    = 0          // timestamp when regime last flipped crowded_long → neutral
let rateHistory       = {}         // { asset: [{apr, ts}] } — rolling 6-scan window
let scanDecisions     = []         // per-asset decisions from last scan
let lastScanAt        = null       // timestamp scan started
const BOOT_TS         = Date.now()

// ── PERSISTENT STATE ──────────────────────────────────────────────────────────
function loadState() {
  if (!existsSync(STATE_FILE)) return { positions: {}, history: [], cooldowns: {}, blacklist: [] }
  const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  if (!s.history) s.history = []
  if (!s.cooldowns) s.cooldowns = {}
  if (!s.blacklist) s.blacklist = []
  // Sync blacklist into EXCLUDED so scan filters it
  for (const a of s.blacklist) EXCLUDED.add(a)
  return s
}
function saveState(s) { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }

// Serialize all state load+mutate+save sequences across scan() and liveRefresh()
// so concurrent awaits can't lose each other's writes.
let _stateLock = Promise.resolve()
function lockState(fn) {
  const prev = _stateLock
  let release
  _stateLock = new Promise(r => { release = r })
  return prev.then(() => fn()).finally(() => release())
}

async function syncPositionsFromHL() {
  try {
    let hlPositions = []
    try {
      const cs = await hl.info.clearinghouseState({ user: identity.hl.address })
      hlPositions = cs?.assetPositions ?? []
    } catch {
      const acc = await hl.getAccountState(identity.hl.address)
      hlPositions = acc?.assetPositions ?? acc?.positions ?? []
    }
    await lockState(async () => {
      const state = loadState()
      let synced = 0
      for (const ap of hlPositions) {
        const pos = ap?.position ?? ap
        if (!pos) continue
        const asset = pos.coin ?? pos.asset
        const szi = parseFloat(pos.szi ?? pos.size ?? '0')
        if (!asset || Math.abs(szi) < 0.0001 || EXCLUDED.has(asset)) continue
        if (!state.positions[asset]) {
          const isBuy = szi > 0
          const entryPx = parseFloat(pos.entryPx ?? pos.entryPrice ?? '0')
          const now = Date.now()
          state.positions[asset] = {
            isBuy, entryPrice: entryPx, openedAt: now,
            fundingAPR: 0, sizeUsd: Math.abs(szi) * entryPx,
            settlesAt: now + hoursUntilNextSettlement() * 3600000,
            peakPrice: entryPx,
          }
          synced++
          log(`[sync] Recovered ${isBuy?'LONG':'SHORT'} ${asset} @ ${entryPx} from Hyperliquid`)
        }
      }
      if (synced > 0) saveState(state)
      log(`[sync] ${hlPositions.length} HL positions checked, ${synced} recovered`)
    })
  } catch (e) { log('[sync] Error:', e.message) }
}

// Hyperliquid pays funding every hour on the hour (UTC)
function hoursUntilNextSettlement() {
  const now = new Date()
  const m = now.getUTCMinutes(), s = now.getUTCSeconds(), ms = now.getUTCMilliseconds()
  const minutesIntoHour = m + s / 60 + ms / 60000
  return (60 - minutesIntoHour) / 60
}

// Excluded assets — never trade these
const EXCLUDED = new Set(['TRUMP','PUMP','LIT'])

// ── FUNDING HELPERS ───────────────────────────────────────────────────────────
// Single bulk call — returns all perps with funding + volume
async function getAllFundingRates() {
  try {
    const [meta, ctxs] = await hl.info.metaAndAssetCtxs()
    return meta.universe.map((a, i) => ({
      asset:    a.name,
      apr:      parseFloat(ctxs[i]?.funding ?? 0) * 24 * 365 * 100,
      volume24h: parseFloat(ctxs[i]?.dayNtlVlm ?? 0),
    })).filter(a => !EXCLUDED.has(a.asset))
  } catch { return [] }
}

// Trend + volatility filter — returns { ok, reason }
async function passesEntryFilters(asset, isBuy, aprAbs = 0) {
  try {
    const now     = Date.now()
    const candles = await hl.info.candleSnapshot({ coin: asset, interval: '1h', startTime: now - 5*3600000, endTime: now })
    if (!candles?.length) return { ok: true, reason: 'no candle data' }

    // Volatility gate: APR-scaled ceiling
    // Base: CFG.maxVolatilityPct. For every 100% APR above 100%, allow +1% extra vol, cap at 3×base.
    if (CFG.maxVolatilityPct > 0) {
      const aprBonus    = Math.max(0, (aprAbs - 100) / 100)   // extra % per 100 APR above 100%
      const volCeiling  = Math.min(CFG.maxVolatilityPct * 3, CFG.maxVolatilityPct + aprBonus)
      const last = candles[candles.length - 1]
      const rangePct = ((parseFloat(last.h) - parseFloat(last.l)) / parseFloat(last.l)) * 100
      if (rangePct > volCeiling)
        return { ok: false, reason: `volatile ${rangePct.toFixed(1)}% 1h range (ceil ${volCeiling.toFixed(1)}% @ APR ${aprAbs.toFixed(0)}%)` }
    }

    // Trend filter: current price vs 4h average close
    if (CFG.trendFilter) {
      const closes   = candles.slice(-4).map(c => parseFloat(c.c))
      const avg4h    = closes.reduce((s, v) => s + v, 0) / closes.length
      const curPrice = closes[closes.length - 1]
      const trendUp  = curPrice > avg4h
      if (isBuy && !trendUp)
        return { ok: false, reason: `trend down (price ${curPrice.toFixed(4)} < 4h avg ${avg4h.toFixed(4)})` }
      if (!isBuy && trendUp)
        return { ok: false, reason: `trend up (price ${curPrice.toFixed(4)} > 4h avg ${avg4h.toFixed(4)})` }
    }

    return { ok: true, reason: 'passed' }
  } catch (e) { return { ok: false, reason: `filter error — skipped: ${e.message}` } }
}

// ── POSITION MANAGEMENT ───────────────────────────────────────────────────────
function calcPositionSize(aprAbs) {
  if (!CFG.dynamicSizing) return CFG.positionUsd
  const t = Math.min(1, Math.max(0, (aprAbs - CFG.minFundingApr) / (CFG.highAprThreshold - CFG.minFundingApr)))
  return Math.round(CFG.positionUsd + t * (CFG.maxPositionUsd - CFG.positionUsd))
}

async function openPosition(asset, isBuy, fundingAPR) {
  const sizeUsd = calcPositionSize(Math.abs(fundingAPR))
  log(`ENTER ${isBuy?'LONG':'SHORT'} ${asset} | funding ${fundingAPR.toFixed(1)}% APR | size $${sizeUsd}`)
  if (CFG.dryRun) {
    const mid = await hl.getMidPrice(asset)
    log(`[DRY RUN] Would ${isBuy?'LONG':'SHORT'} ${asset} at $${mid.toFixed(4)} size $${sizeUsd}`)
    return { dryRun: true, avgPrice: mid, sizeUsd }
  }
  await hl.setLeverage(asset, CFG.leverage, false)
  const mid = await hl.getMidPrice(asset).catch(() => null)
  const result = await hl.placeMarketOrder({ asset, isBuy, sizeUsd, slippageBps: 500 })
  if (!result.success) {
    log(`ORDER FAILED ${asset} (mid=$${mid?.toFixed(6) ?? '?'}):`, result.error)
    if (result.error?.includes('invalid price')) {
      EXCLUDED.add(asset)
      const s = loadState(); s.blacklist = [...new Set([...s.blacklist, asset])]; saveState(s)
      log(`BLACKLISTED ${asset} — persistent invalid price, won't retry`)
    }
    return { failed: true, error: result.error }
  }
  const fillPrice = parseFloat(result?.filled?.avgPx ?? result?.avgPrice ?? 0) || null
  log(`FILLED ${isBuy?'LONG':'SHORT'} ${asset} @ ${fillPrice ? '$'+fillPrice.toFixed(6) : 'unknown'} size $${sizeUsd}`)
  return { ...result, sizeUsd }
}

async function closePosition(asset, reason) {
  log(`EXIT ${asset} — ${reason}`)
  if (CFG.dryRun) {
    const mid = await hl.getMidPrice(asset)
    log(`[DRY RUN] Would close ${asset} at $${mid.toFixed(4)}`)
    return mid
  }
  const result = await hl.closePosition(asset)
  let exitPrice = parseFloat(result?.filled?.avgPx ?? result?.avgPrice ?? '')
  if (!isFinite(exitPrice) || exitPrice <= 0) {
    // fallback to mid price if close result doesn't have valid price
    exitPrice = await hl.getMidPrice(asset).catch(() => null)
  }
  log(`CLOSED ${asset}:`, exitPrice ? `avg $${exitPrice.toFixed(6)}` : result?.error)
  return exitPrice
}

// ── SCAN ──────────────────────────────────────────────────────────────────────
async function scan() {
  if (scanning) { log('Scan already running, skipping'); return }
  if (paused)   { log('Bot paused, skipping scan'); return }
  scanning = true
  try {
  const state = loadState()
  const now   = Date.now()
  lastScanAt  = now

  // Bulk fetch all funding rates (single API call)
  log('Fetching all funding rates...')
  const allRates = await getAllFundingRates()
  for (const r of allRates) {
    lastRates[r.asset] = { apr: r.apr, volume24h: r.volume24h, ts: now }
    if (!rateHistory[r.asset]) rateHistory[r.asset] = []
    rateHistory[r.asset].push({ apr: r.apr, ts: now })
    if (rateHistory[r.asset].length > 6) rateHistory[r.asset].shift()
  }
  log(`Loaded ${allRates.length} assets`)

  // Build decision map for dashboard scanner — all "watchlist" assets (APR >= half threshold or already open)
  const decMap = new Map()
  const watchlistFilter = r => Math.abs(r.apr) >= CFG.minFundingApr * 0.5 && r.volume24h >= 500_000
  for (const r of allRates.filter(watchlistFilter)) {
    let decision = 'PENDING', reason = ''
    if (state.positions[r.asset]) {
      decision = 'HOLDING'; reason = 'Position open'
    } else if (state.cooldowns[r.asset] && state.cooldowns[r.asset] > now) {
      decision = 'COOLDOWN'; reason = `${Math.ceil((state.cooldowns[r.asset] - now) / 60000)}min cooldown`
    } else if (Math.abs(r.apr) < CFG.minFundingApr) {
      decision = 'LOW_APR'; reason = `${Math.abs(r.apr).toFixed(0)}% < ${CFG.minFundingApr}% threshold`
    } else if (r.volume24h < 1_000_000) {
      decision = 'LOW_VOL'; reason = `$${(r.volume24h / 1e6).toFixed(1)}M vol < $1M min`
    }
    decMap.set(r.asset, { asset: r.asset, apr: r.apr, vol: r.volume24h, isBuy: r.apr < 0, decision, reason })
  }

  // Detect funding regime: if ≥65% of liquid assets have positive funding → market crowded long
  // Going LONG (negative funding) in crowded-long market = fighting macro + no yield edge
  const liquidRates = allRates.filter(r => r.volume24h >= 5_000_000)
  crowdedLongRatio  = liquidRates.length > 0
    ? liquidRates.filter(r => r.apr > 0).length / liquidRates.length
    : 0.5
  btcFundingRegime = crowdedLongRatio >= 0.65 ? 'crowded_long' : 'neutral'
  if (prevRegime === 'crowded_long' && btcFundingRegime === 'neutral') {
    regimeFlipTime = now
    log(`Regime flipped crowded_long → neutral — ${CFG.regimeFlipCooldownMins ?? 10}min LONG cooldown starts now`)
  }
  prevRegime = btcFundingRegime
  log(`Funding regime: ${btcFundingRegime} | ${(crowdedLongRatio * 100).toFixed(0)}% of ${liquidRates.length} liquid assets have positive funding`)

  // Scan for new entries
  const openCount = Object.keys(state.positions).length
  const hoursLeft = hoursUntilNextSettlement()
  const _dec = a => decMap.get(a)  // shorthand for decision lookup

  if (openCount < CFG.maxPositions) {
    const maxHrs = CFG.maxHoursToSettle ?? 8
    if (hoursLeft < CFG.minHoursToSettle) {
      log(`Skipping new entries — only ${hoursLeft.toFixed(2)}h to settlement (min ${CFG.minHoursToSettle}h required)`)
      for (const [, d] of decMap) if (d.decision === 'PENDING') { d.decision = 'SKIP'; d.reason = `${hoursLeft.toFixed(2)}h to settle (min ${CFG.minHoursToSettle}h)` }
    } else if (hoursLeft > maxHrs) {
      log(`Skipping new entries — ${hoursLeft.toFixed(2)}h to settlement (entry window: ${CFG.minHoursToSettle}–${maxHrs}h before settlement)`)
      for (const [, d] of decMap) if (d.decision === 'PENDING') { d.decision = 'SKIP'; d.reason = `${hoursLeft.toFixed(2)}h to settle (outside entry window)` }
    } else {
    const opps = allRates
      .filter(r => !state.positions[r.asset])
      .filter(r => !(state.cooldowns[r.asset] && state.cooldowns[r.asset] > now))
      .filter(r => Math.abs(r.apr) >= CFG.minFundingApr && r.volume24h >= 1_000_000)
      .sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr))

    log(`Opportunities (${hoursLeft.toFixed(1)}h to settlement): ${opps.slice(0,5).map(o=>`${o.asset}:${o.apr.toFixed(1)}%`).join(', ') || 'none'}`)

    for (const opp of opps) {
      if (Object.keys(state.positions).length >= CFG.maxPositions) {
        for (const rem of opps) { const d = _dec(rem.asset); if (d?.decision === 'PENDING') { d.decision = 'MAX_POS'; d.reason = 'Max positions reached' } }
        break
      }
      const isBuy  = opp.apr < 0

      // Regime gate: in crowded-long market, skip going LONG on alts
      if (isBuy && btcFundingRegime === 'crowded_long') {
        log(`SKIP ${opp.asset} LONG — regime block: ${(crowdedLongRatio*100).toFixed(0)}% crowded long market, alt longs high risk`)
        const d = _dec(opp.asset); if (d) { d.decision = 'SKIP'; d.reason = `Regime: ${(crowdedLongRatio*100).toFixed(0)}% crowded long market` }
        continue
      }

      // Regime flip cooldown: wait N mins after crowded_long→neutral before LONGs
      const regimeCooldownMs = (CFG.regimeFlipCooldownMins ?? 10) * 60000
      if (isBuy && regimeFlipTime > 0 && (now - regimeFlipTime) < regimeCooldownMs) {
        const minsLeft = ((regimeCooldownMs - (now - regimeFlipTime)) / 60000).toFixed(1)
        log(`SKIP ${opp.asset} LONG — regime flip cooldown: ${minsLeft}min remaining`)
        const d = _dec(opp.asset); if (d) { d.decision = 'SKIP'; d.reason = `Regime flip cooldown: ${minsLeft}min remaining` }
        continue
      }

      // APR trend gate: skip if rate has dropped >20% from its recent peak (yield collapsing pre-entry)
      if (CFG.aprTrendFilter) {
        const hist = rateHistory[opp.asset]
        if (hist && hist.length >= 3) {
          const absAprs = hist.map(h => Math.abs(h.apr))
          const peak    = Math.max(...absAprs)
          const latest  = absAprs[absAprs.length - 1]
          const pctOff  = peak > 0 ? (peak - latest) / peak * 100 : 0
          if (pctOff > 20) {
            log(`SKIP ${opp.asset} — APR trend falling: ${peak.toFixed(0)}% peak → ${latest.toFixed(0)}% now (${pctOff.toFixed(0)}% off peak)`)
            const d = _dec(opp.asset); if (d) { d.decision = 'SKIP'; d.reason = `APR trend falling: ${peak.toFixed(0)}%→${latest.toFixed(0)}% (${pctOff.toFixed(0)}% off peak)` }
            continue
          }
        }
      }

      const filter = await passesEntryFilters(opp.asset, isBuy, Math.abs(opp.apr))
      if (!filter.ok) {
        log(`SKIP ${opp.asset} — ${filter.reason}`)
        const d = _dec(opp.asset); if (d) { d.decision = 'SKIP'; d.reason = filter.reason }
        continue
      }
      const result = await openPosition(opp.asset, isBuy, opp.apr)
      const tNow = Date.now()
      if (!result || result.failed) {
        const d = _dec(opp.asset); if (d) { d.decision = 'FAILED'; d.reason = result?.error || 'Order failed' }
        await lockState(async () => {
          const s = loadState()
          s.cooldowns[opp.asset] = tNow + 30 * 60 * 1000
          saveState(s)
        })
        continue
      }
      const mid = await hl.getMidPrice(opp.asset)
      const settlesAt = tNow + hoursUntilNextSettlement() * 3600000
      const entryPrice = parseFloat(result?.filled?.avgPx ?? result?.avgPrice ?? 0) || mid
      const d = _dec(opp.asset); if (d) { d.decision = 'ENTER'; d.reason = `${isBuy?'LONG':'SHORT'} @ $${entryPrice.toFixed(4)} | $${result.sizeUsd ?? CFG.positionUsd}` }
      await lockState(async () => {
        const s = loadState()
        s.positions[opp.asset] = {
          isBuy, entryPrice, openedAt: tNow, fundingAPR: opp.apr,
          sizeUsd: result.sizeUsd ?? CFG.positionUsd, settlesAt,
          peakPrice: entryPrice, settlementsCollected: 0,
        }
        saveState(s)
        state.positions[opp.asset] = s.positions[opp.asset]  // keep loop view in sync
      })
    }
    } // end else (enough time to settle)
  } else {
    for (const [, d] of decMap) if (d.decision === 'PENDING') { d.decision = 'MAX_POS'; d.reason = 'Max positions reached' }
  }

  // Commit scan decisions (sort by abs APR desc, ENTERs first)
  scanDecisions = [...decMap.values()].sort((a, b) => {
    if (a.decision === 'ENTER' && b.decision !== 'ENTER') return -1
    if (b.decision === 'ENTER' && a.decision !== 'ENTER') return 1
    return Math.abs(b.apr) - Math.abs(a.apr)
  })

  cachedBal = await hl.getAccountState(identity.hl.address).catch(() => null)
  const equity = cachedBal?.equity ?? '?'
  log(`Scan complete | equity $${equity} | open: ${Object.keys(state.positions).length}/${CFG.maxPositions} | next entry-scan in ${CFG.scanIntervalMs/1000}s`)
  log('---')
  } catch (e) {
    log('Scan error:', e.message)
  } finally {
    scanning = false
  }
}

function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = setTimeout(async () => {
    try { await scan() } catch (e) { log('Scan unhandled error:', e.message) }
    scheduleScan()
  }, CFG.scanIntervalMs)
}

// Refresh mid prices every 5s + enforce SL + price-change spike exit
// NOTE: intentionally NOT gated on `scanning` — stop losses must fire even during a slow scan
async function liveRefresh() {
  try {
    await lockState(async () => {
    const state = loadState()
    const now   = Date.now()
    let changed = false

    for (const [asset, pos] of Object.entries(state.positions)) {
      const mid = await hl.getMidPrice(asset).catch(() => null)
      if (!mid) continue

      const prevMid = lastMidPrices[asset]
      lastMidPrices[asset] = mid

      const pricePct   = ((mid - pos.entryPrice) / pos.entryPrice) * 100
      const adversePct = pos.isBuy ? Math.max(0, -pricePct) : Math.max(0, pricePct)
      const heldHours  = (now - pos.openedAt) / 3600000

      // Update trailing peak
      if (pos.isBuy) {
        if (!pos.peakPrice || mid > pos.peakPrice) { pos.peakPrice = mid; changed = true }
      } else {
        if (!pos.peakPrice || mid < pos.peakPrice) { pos.peakPrice = mid; changed = true }
      }

      // Check exits
      let exitReason = null
      if (adversePct >= CFG.stopLossPct) {
        exitReason = `stop-loss ${adversePct.toFixed(2)}%`
      } else if (CFG.priceChangePct > 0 && prevMid) {
        // Emergency exit: sudden adverse price spike in one tick
        const tickMove = ((mid - prevMid) / prevMid) * 100
        const adverseTick = pos.isBuy ? -tickMove : tickMove
        if (adverseTick >= CFG.priceChangePct)
          exitReason = `price-spike ${adverseTick.toFixed(2)}% in one tick`
      }
      if (!exitReason && CFG.trailingStopPct > 0 && pos.peakPrice) {
        const isHighApr   = Math.abs(pos.fundingAPR) >= (CFG.highAprThreshold ?? 300)
        const trailPct    = isHighApr ? (CFG.trailingStopHighApr ?? 5) : CFG.trailingStopPct
        const dropFromPeak = pos.isBuy
          ? (pos.peakPrice - mid) / pos.peakPrice * 100
          : (mid - pos.peakPrice) / pos.peakPrice * 100
        if (dropFromPeak >= trailPct)
          exitReason = `trailing-stop ${dropFromPeak.toFixed(2)}% from peak`
      }
      // Funding deterioration — exit early when yield thesis collapses or flips against us
      if (!exitReason && pos.settlesAt > now && pos.fundingAPR !== 0 && lastRates[asset]) {
        const currentAprSigned = lastRates[asset].apr
        const entryAprSigned   = pos.fundingAPR
        const entryAbs   = Math.abs(entryAprSigned)
        const currentAbs = Math.abs(currentAprSigned)
        const flipped    = Math.sign(currentAprSigned) !== Math.sign(entryAprSigned) && currentAbs > 5
        if (entryAbs >= CFG.minFundingApr && flipped) {
          exitReason = `funding-flip: APR ${entryAprSigned.toFixed(0)}% → ${currentAprSigned.toFixed(0)}% (now paying against us)`
        } else if (entryAbs >= CFG.minFundingApr && currentAbs < entryAbs * 0.40) {
          exitReason = `funding-collapse: APR ${entryAbs.toFixed(0)}% → ${currentAbs.toFixed(0)}% (yield gone, pure directional risk now)`
        }
      }

      if (!exitReason && pos.settlesAt) {
        const minsAfterSettle = (now - pos.settlesAt) / 60000
        const exitMins = CFG.exitAfterSettleMins ?? 3
        if (minsAfterSettle >= exitMins) {
          const isHighApr  = Math.abs(pos.fundingAPR) >= (CFG.highAprThreshold ?? 300)
          const maxSettles = isHighApr ? (CFG.highAprMaxSettlements ?? 3) : (CFG.maxSettlements ?? 1)
          const collected  = (pos.settlementsCollected ?? 0) + 1
          if (collected >= maxSettles) {
            exitReason = `post-settlement exit (${collected}/${maxSettles} settlements collected)`
          } else {
            pos.settlementsCollected = collected
            pos.settlesAt = now + hoursUntilNextSettlement() * 3600000
            changed = true
            log(`[${asset}] Settlement ${collected}/${maxSettles} collected — holding for next in ${(hoursUntilNextSettlement()*60).toFixed(0)}min`)
          }
        }
      }
      if (!exitReason && heldHours >= CFG.maxHoldHours)
        exitReason = `max hold ${heldHours.toFixed(1)}h`

      if (exitReason) {
        const exitPrice = await closePosition(asset, exitReason)
        const pnlUsd    = exitPrice ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * (pos.sizeUsd ?? CFG.positionUsd) * (pos.isBuy ? 1 : -1) : null
        state.history.unshift({ asset, side: pos.isBuy ? 'LONG' : 'SHORT', entryPrice: pos.entryPrice,
          exitPrice, fundingAPR: pos.fundingAPR, openedAt: pos.openedAt, closedAt: now, reason: exitReason, pnlUsd,
          sizeUsd: pos.sizeUsd, settlementsCollected: pos.settlementsCollected ?? 0 })
        if (state.history.length > 100) state.history = state.history.slice(0, 100)
        if (exitReason.startsWith('stop-loss') || exitReason.startsWith('trailing-stop') || exitReason.startsWith('price-spike'))
          state.cooldowns[asset] = now + 2 * 3600000
        delete state.positions[asset]
        changed = true
      }
    }
    if (changed) saveState(state)
    if (Object.keys(state.positions).length > 0)
      cachedBal = await hl.getAccountState(identity.hl.address).catch(() => cachedBal)
    })
  } catch (e) { log('liveRefresh error:', e.message) }
}

// Self-scheduling so config changes to liveRefreshMs take effect without restart
function scheduleLiveRefresh() {
  setTimeout(async () => { await liveRefresh(); scheduleLiveRefresh() }, CFG.liveRefreshMs ?? 5000)
}

// ── API HANDLERS ──────────────────────────────────────────────────────────────
function apiStatus() {
  const state  = loadState()
  const equity = parseFloat(cachedBal?.equity ?? cachedBal?.marginSummary?.accountValue ?? 0)
  const avail  = parseFloat(cachedBal?.availableBalance ?? 0)

  const positions = Object.entries(state.positions).map(([asset, pos]) => {
    const mid        = lastMidPrices[asset] ?? null
    const pricePct   = mid ? ((mid - pos.entryPrice) / pos.entryPrice) * 100 : null
    const adversePct = pricePct !== null ? (pos.isBuy ? Math.max(0, -pricePct) : Math.max(0, pricePct)) : null
    const pnlUsd     = pricePct !== null ? (pricePct / 100) * (pos.sizeUsd ?? CFG.positionUsd) * (pos.isBuy ? 1 : -1) : null
    return { asset, side: pos.isBuy ? 'LONG' : 'SHORT', entryPrice: pos.entryPrice,
      midPrice: mid, fundingAPR: pos.fundingAPR, heldHours: (Date.now() - pos.openedAt) / 3600000,
      adversePct, pnlUsd, openedAt: pos.openedAt,
      settlesAt: pos.settlesAt ?? null, settlementsCollected: pos.settlementsCollected ?? 0 }
  })

  const rates = Object.entries(lastRates)
    .map(([asset, d]) => ({ asset, apr: d.apr, volume24h: d.volume24h, ts: d.ts }))
    .sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr))

  const hoursToSettle = hoursUntilNextSettlement()
  const fullHistory = state.history
  const totalTrades = fullHistory.length
  const totalWins   = fullHistory.filter(t => (t.pnlUsd ?? null) !== null && t.pnlUsd > 0).length
  const totalLosses = fullHistory.filter(t => (t.pnlUsd ?? null) !== null && t.pnlUsd < 0).length
  const totalClosedPnl = fullHistory.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)
  return { equity, avail, positions, openCount: positions.length, history: state.history.slice(0, 50),
    totalTrades, totalWins, totalLosses, totalClosedPnl,
    rates, paused, scanning, cfg: CFG, mode: CFG.dryRun ? 'DRY RUN' : 'LIVE',
    wallet: identity.hl.address, hoursToSettle, scanDecisions, lastScanAt,
    regime: btcFundingRegime, crowdedRatio: crowdedLongRatio, startedAt: BOOT_TS,
    ts: new Date().toISOString() }
}

async function apiClose(asset) {
  const pre = loadState()
  if (!pre.positions[asset]) return { error: 'Position not found' }
  const pos       = pre.positions[asset]
  const mid       = await hl.getMidPrice(asset).catch(() => null)
  const exitPrice = await closePosition(asset, 'manual close from dashboard') ?? mid
  const pricePct  = exitPrice ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 : null
  const pnlUsd    = pricePct !== null ? (pricePct / 100) * (pos.sizeUsd ?? CFG.positionUsd) * (pos.isBuy ? 1 : -1) : null
  await lockState(async () => {
    const state = loadState()
    if (!state.positions[asset]) return
    state.history.unshift({ asset, side: pos.isBuy ? 'LONG' : 'SHORT', entryPrice: pos.entryPrice,
      exitPrice, fundingAPR: pos.fundingAPR, openedAt: pos.openedAt, closedAt: Date.now(),
      reason: 'manual', pnlUsd, sizeUsd: pos.sizeUsd, settlementsCollected: pos.settlementsCollected ?? 0 })
    delete state.positions[asset]
    saveState(state)
  })
  return { ok: true, exitPrice, pnlUsd }
}

// ── DASHBOARD HTML ────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0C0A07">
<title>Funding Bot — Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600;12..96,700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0C0A07;
  --panel:#13100A;
  --panel2:#181309;
  --line:#272013;
  --line2:#3A301C;
  --amber:#FFB454;
  --amber-soft:rgba(255,180,84,0.12);
  --amber-line:rgba(255,180,84,0.35);
  --ink:#EDE6D8;
  --muted:#9A9078;
  --faint:#5C543F;
  --green:#46D68C;
  --green-soft:rgba(70,214,140,0.10);
  --red:#F25C5C;
  --red-soft:rgba(242,92,92,0.10);
  --yellow:#E8C547;
  --yellow-soft:rgba(232,197,71,0.10);
  --z-sticky:20;
}
html{background:var(--bg)}
body{
  background:
    radial-gradient(1100px 380px at 50% -120px, rgba(255,180,84,0.05), transparent 70%),
    var(--bg);
  color:var(--ink);
  font-family:'IBM Plex Mono',monospace;
  font-size:13px;
  line-height:1.5;
  min-height:100vh;
  -webkit-font-smoothing:antialiased;
}
::selection{background:var(--amber);color:#0C0A07}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--line2);border-radius:4px;border:2px solid var(--bg)}
::-webkit-scrollbar-thumb:hover{background:var(--faint)}
:focus-visible{outline:2px solid var(--amber);outline-offset:2px;border-radius:3px}

/* ── HEADER ─────────────────────────────────────────── */
.top{
  position:sticky;top:0;z-index:var(--z-sticky);
  display:flex;align-items:center;gap:14px;
  padding:13px 22px;
  background:rgba(12,10,7,0.88);
  border-bottom:1px solid var(--line);
  backdrop-filter:blur(14px);
}
.brand{
  font-family:'Bricolage Grotesque',sans-serif;
  font-weight:700;font-size:17px;letter-spacing:-0.02em;
  color:var(--ink);white-space:nowrap;
}
.brand em{font-style:normal;color:var(--amber)}
.chip{
  display:inline-flex;align-items:center;gap:7px;
  font-size:10.5px;font-weight:600;letter-spacing:0.08em;
  padding:4px 11px;border-radius:3px;white-space:nowrap;
}
.chip.live{color:var(--green);background:var(--green-soft);border:1px solid rgba(70,214,140,0.3)}
.chip.dry{color:var(--muted);background:rgba(154,144,120,0.08);border:1px solid var(--line2)}
.chip.paused{color:var(--yellow);background:var(--yellow-soft);border:1px solid rgba(232,197,71,0.3)}
.chip.regime-neutral{color:var(--muted);border:1px solid var(--line2);background:transparent}
.chip.regime-crowded{color:var(--yellow);border:1px solid rgba(232,197,71,0.3);background:var(--yellow-soft)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0}
.chip.live .dot{animation:breathe 2.4s ease-in-out infinite}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:0.35}}
.top .updated{margin-left:auto;font-size:11px;color:var(--faint);white-space:nowrap}

/* ── LAYOUT ─────────────────────────────────────────── */
.wrap{
  display:grid;grid-template-columns:minmax(0,1fr) 304px;
  gap:16px;align-items:start;
  max-width:1480px;margin:0 auto;padding:18px 22px 60px;
}
.col{display:flex;flex-direction:column;gap:16px;min-width:0}
.rail{display:flex;flex-direction:column;gap:16px;position:sticky;top:72px}
@media (max-width:1020px){
  .wrap{grid-template-columns:1fr}
  .rail{position:static;order:-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));align-items:stretch}
}

/* ── PANELS ─────────────────────────────────────────── */
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;overflow:hidden}
.panel-head{
  display:flex;align-items:baseline;gap:10px;
  padding:11px 16px;border-bottom:1px solid var(--line);
}
.panel-head h2{
  font-family:'Bricolage Grotesque',sans-serif;
  font-size:13.5px;font-weight:600;letter-spacing:0.01em;color:var(--ink);
}
.panel-head .meta{font-size:10.5px;color:var(--faint)}
.panel-head .right{margin-left:auto;font-size:10.5px;color:var(--faint)}
.count-tag{
  font-size:10px;color:var(--amber);background:var(--amber-soft);
  border:1px solid var(--amber-line);padding:1px 8px;border-radius:10px;
}

/* scan sweep — visible only while scanning */
.sweep{position:relative;height:2px;background:var(--line);overflow:hidden;display:none}
.sweep.on{display:block}
.sweep::after{
  content:'';position:absolute;top:0;left:-30%;width:30%;height:100%;
  background:linear-gradient(90deg,transparent,var(--amber),transparent);
  animation:sweep 1.4s linear infinite;
}
@keyframes sweep{to{left:130%}}

/* ── INSTRUMENT STRIP ───────────────────────────────── */
.strip{
  display:grid;grid-template-columns:repeat(6,1fr);
  background:var(--panel);border:1px solid var(--line);border-radius:6px;
  overflow:hidden;
}
.cell{padding:13px 16px 11px;border-right:1px solid var(--line);min-width:0}
.cell:last-child{border-right:none}
.cell .lbl{font-size:9.5px;letter-spacing:0.14em;color:var(--muted);text-transform:uppercase;margin-bottom:5px}
.cell .val{
  font-size:21px;font-weight:600;letter-spacing:-0.01em;
  font-variant-numeric:tabular-nums;color:var(--ink);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
}
.cell .sub{font-size:10px;color:var(--faint);margin-top:3px;font-variant-numeric:tabular-nums}
.val.pos{color:var(--green)}.val.neg{color:var(--red)}
.flash-up{animation:fup 0.7s ease-out}
.flash-down{animation:fdn 0.7s ease-out}
@keyframes fup{0%{color:var(--green);text-shadow:0 0 12px rgba(70,214,140,0.5)}100%{}}
@keyframes fdn{0%{color:var(--red);text-shadow:0 0 12px rgba(242,92,92,0.5)}100%{}}
@media (max-width:900px){.strip{grid-template-columns:repeat(3,1fr)}.cell:nth-child(3){border-right:none}.cell:nth-child(-n+3){border-bottom:1px solid var(--line)}}

/* ── SETTLEMENT DIAL ────────────────────────────────── */
.dial-panel{padding:18px 16px 16px;text-align:center}
.dial-wrap{position:relative;width:158px;height:158px;margin:0 auto}
.dial-wrap svg{transform:rotate(-90deg)}
.dial-track{fill:none;stroke:var(--line);stroke-width:7}
.dial-prog{
  fill:none;stroke:var(--amber);stroke-width:7;stroke-linecap:round;
  stroke-dasharray:327;transition:stroke-dashoffset 0.5s linear, stroke 0.4s;
}
.dial-prog.danger{stroke:var(--red)}
.dial-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}
.dial-time{font-size:27px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:0.01em;color:var(--ink)}
.dial-cap{font-size:8.5px;letter-spacing:0.18em;color:var(--muted);text-transform:uppercase}
.dial-status{display:inline-flex;align-items:center;gap:7px;margin-top:13px;font-size:10.5px;letter-spacing:0.06em;font-weight:600}
.dial-status.ok{color:var(--green)}
.dial-status.blocked{color:var(--red)}
.dial-note{margin-top:7px;font-size:10px;color:var(--faint)}

/* ── CONTROLS ───────────────────────────────────────── */
.controls{display:flex;flex-direction:column;gap:8px;padding:14px 16px}
.btn{
  font-family:'IBM Plex Mono',monospace;
  display:inline-flex;align-items:center;justify-content:center;gap:8px;
  font-size:11.5px;font-weight:600;letter-spacing:0.05em;
  padding:9px 14px;border-radius:4px;cursor:pointer;
  border:1px solid var(--line2);background:var(--panel2);color:var(--ink);
  transition:border-color 0.15s,background 0.15s,color 0.15s;
  min-height:36px;width:100%;
}
.btn:hover{border-color:var(--amber-line);background:var(--amber-soft);color:var(--amber)}
.btn:disabled{opacity:0.45;cursor:default}
.btn.warn:hover{border-color:rgba(232,197,71,0.4);background:var(--yellow-soft);color:var(--yellow)}
.btn-close{
  font-family:'IBM Plex Mono',monospace;font-size:10.5px;font-weight:600;
  padding:4px 11px;border-radius:3px;cursor:pointer;min-height:26px;
  background:transparent;color:var(--red);border:1px solid rgba(242,92,92,0.35);
  transition:background 0.15s;
}
.btn-close:hover{background:var(--red-soft)}

/* ── CONFIG ─────────────────────────────────────────── */
.cfg-panel{display:none;padding:6px 16px 16px;border-top:1px solid var(--line)}
.cfg-panel.open{display:block}
.cfg-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 12px;margin-top:10px}
.cfg-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.cfg-field label{font-size:9px;letter-spacing:0.1em;text-transform:uppercase;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cfg-field input,.cfg-field select{
  font-family:'IBM Plex Mono',monospace;font-size:12px;
  background:var(--bg);border:1px solid var(--line2);color:var(--ink);
  padding:6px 8px;border-radius:3px;width:100%;
}
.cfg-field input:focus,.cfg-field select:focus{border-color:var(--amber-line);outline:none}
.btn-save{margin-top:12px}

/* ── ACCOUNT ────────────────────────────────────────── */
.acct{padding:13px 16px;display:flex;flex-direction:column;gap:8px}
.acct-row{display:flex;justify-content:space-between;gap:10px;font-size:11px}
.acct-row .k{color:var(--muted)}
.acct-row .v{color:var(--ink);font-variant-numeric:tabular-nums;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── TABLES ─────────────────────────────────────────── */
table{width:100%;border-collapse:collapse}
th{
  padding:8px 14px;text-align:left;
  font-size:9.5px;font-weight:500;letter-spacing:0.12em;text-transform:uppercase;
  color:var(--faint);border-bottom:1px solid var(--line);white-space:nowrap;
}
td{
  padding:10px 14px;border-bottom:1px solid rgba(39,32,19,0.6);
  font-variant-numeric:tabular-nums;vertical-align:middle;
}
tr:last-child td{border-bottom:none}
tbody tr{transition:background 0.12s}
tbody tr:hover{background:rgba(255,180,84,0.035)}
.empty{text-align:center;padding:30px 16px;color:var(--faint);font-size:12px}
.green{color:var(--green)}.red{color:var(--red)}.yellow{color:var(--yellow)}.dim{color:var(--muted)}
.pill{
  display:inline-block;padding:2px 9px;border-radius:3px;
  font-size:10px;font-weight:600;letter-spacing:0.07em;
}
.pill.long{background:var(--green-soft);color:var(--green);border:1px solid rgba(70,214,140,0.3)}
.pill.short{background:var(--red-soft);color:var(--red);border:1px solid rgba(242,92,92,0.3)}
.badge-dec{
  display:inline-block;padding:2px 8px;border-radius:3px;
  font-size:9.5px;font-weight:600;letter-spacing:0.08em;white-space:nowrap;
}
.dec-enter{background:var(--green-soft);color:var(--green);border:1px solid rgba(70,214,140,0.35)}
.dec-hold{background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line)}
.dec-skip{background:var(--red-soft);color:var(--red);border:1px solid rgba(242,92,92,0.3)}
.dec-cool{background:var(--yellow-soft);color:var(--yellow);border:1px solid rgba(232,197,71,0.3)}
.dec-dim{background:rgba(154,144,120,0.07);color:var(--muted);border:1px solid var(--line2)}
.reason{font-size:11px;color:var(--muted)}

/* adverse meter */
.meter{display:inline-flex;align-items:center;gap:7px}
.meter-bg{width:52px;height:4px;background:var(--line);border-radius:2px;overflow:hidden;flex-shrink:0}
.meter-fill{height:100%;border-radius:2px;transition:width 0.4s}

/* apr bar */
.apr-wrap{display:inline-flex;align-items:center;gap:8px}
.apr-bg{width:58px;height:5px;background:var(--line);border-radius:2px;overflow:hidden;flex-shrink:0}
.apr-fill{height:100%;border-radius:2px}

/* ── PAGINATION ─────────────────────────────────────── */
.pagination{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;border-top:1px solid var(--line)}
.page-info{font-size:10.5px;color:var(--faint)}
.page-info b{color:var(--amber);font-weight:600}
.page-btns{display:flex;gap:4px}
.pbtn{
  font-family:'IBM Plex Mono',monospace;
  background:transparent;border:1px solid var(--line2);color:var(--muted);
  padding:3px 10px;border-radius:3px;font-size:10.5px;cursor:pointer;
  transition:border-color 0.12s,color 0.12s;min-height:24px;
}
.pbtn:hover:not(:disabled){border-color:var(--amber-line);color:var(--amber)}
.pbtn:disabled{opacity:0.3;cursor:default}
.pbtn.active{background:var(--amber-soft);border-color:var(--amber-line);color:var(--amber)}

/* chart */
.chart-box{padding:14px 16px;position:relative;height:280px}
#pnlEmpty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:12px}

/* ── TICKER TAPE ────────────────────────────────────── */
.tape{overflow:hidden;border-bottom:1px solid var(--line);background:rgba(19,16,10,0.7);height:30px;display:flex;align-items:center}
.tape-track{display:inline-flex;white-space:nowrap;animation:tape 55s linear infinite;will-change:transform}
.tape:hover .tape-track{animation-play-state:paused}
@keyframes tape{to{transform:translateX(-50%)}}
.tape-item{display:inline-flex;align-items:center;gap:7px;padding:0 18px;font-size:10.5px;letter-spacing:0.04em;color:var(--muted);border-right:1px solid var(--line)}
.tape-item b{color:var(--ink);font-weight:600}

/* ── BRAND SUB ──────────────────────────────────────── */
.brand-blk{display:flex;flex-direction:column;line-height:1.15}
.brand-sub{font-size:8.5px;letter-spacing:0.16em;color:var(--faint);text-transform:uppercase}

/* ── DIVERGING APR BAR ──────────────────────────────── */
.div-bar{position:relative;display:inline-block;width:90px;height:5px;background:var(--line);border-radius:2px;vertical-align:middle;flex-shrink:0}
.div-bar::before{content:'';position:absolute;left:50%;top:-2px;bottom:-2px;width:1px;background:var(--line2)}
.div-fill{position:absolute;top:0;bottom:0;border-radius:2px}

/* ── SCANNER TABS ───────────────────────────────────── */
.tabs{display:flex;gap:4px;margin-left:8px}
.tab{font-family:'IBM Plex Mono',monospace;font-size:9.5px;font-weight:600;letter-spacing:0.08em;padding:2px 9px;border-radius:3px;border:1px solid transparent;background:transparent;color:var(--faint);cursor:pointer;min-height:20px;transition:color 0.12s,border-color 0.12s}
.tab:hover{color:var(--muted)}
.tab.active{color:var(--amber);border-color:var(--amber-line);background:var(--amber-soft)}

/* ── SEARCH ─────────────────────────────────────────── */
.search{font-family:'IBM Plex Mono',monospace;font-size:11px;background:var(--bg);border:1px solid var(--line2);color:var(--ink);padding:4px 10px;border-radius:3px;width:140px;margin-left:auto}
.search:focus{border-color:var(--amber-line);outline:none}
.search::placeholder{color:var(--faint)}

/* ── FRESH ROW STAGGER ──────────────────────────────── */
tbody.fresh tr{animation:rowin 0.3s ease-out backwards;animation-delay:calc(var(--i,0)*28ms)}
@keyframes rowin{from{opacity:0;transform:translateY(4px)}}

/* ── BUTTON POLISH ──────────────────────────────────── */
.btn.primary{background:var(--amber-soft);border-color:var(--amber-line);color:var(--amber)}
.btn.primary:hover{background:rgba(255,180,84,0.22)}
.btn:active{transform:translateY(1px)}

/* ── EQUITY MINI SPARK ──────────────────────────────── */
.cell .mini{display:block;margin-top:5px;height:14px}

/* ── POSITION SETTLE CHIP ───────────────────────────── */
.settle-in{font-size:9px;color:var(--faint);margin-top:2px;letter-spacing:0.05em}
.settle-in.hot{color:var(--amber)}

@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation:none !important;transition:none !important}
}
</style>
</head>
<body>

<header class="top">
  <div class="brand-blk">
    <div class="brand">FUNDING<em>BOT</em></div>
    <div class="brand-sub">hyperliquid funding harvester</div>
  </div>
  <span class="chip live" id="modeBadge"><span class="dot"></span>LIVE</span>
  <span class="chip paused" id="pauseBadge" style="display:none">PAUSED</span>
  <span class="chip regime-neutral" id="regimeChip" style="display:none"></span>
  <span class="updated" id="ts">connecting…</span>
</header>

<div class="tape" aria-hidden="true"><div class="tape-track" id="tapeTrack"></div></div>

<div class="wrap">

  <!-- MAIN COLUMN -->
  <div class="col">

    <!-- Instrument strip -->
    <div class="strip" role="group" aria-label="Account metrics">
      <div class="cell"><div class="lbl">Equity</div><div class="val" id="equity">—</div><span class="mini" id="eqSpark"></span></div>
      <div class="cell"><div class="lbl">Available</div><div class="val" id="avail">—</div></div>
      <div class="cell"><div class="lbl">Open P&amp;L</div><div class="val" id="openPnl">—</div></div>
      <div class="cell">
        <div class="lbl">Realised P&amp;L</div><div class="val" id="closedPnl">—</div>
        <div class="sub"><span class="green"><span id="winCount">0</span>W</span> · <span class="red"><span id="lossCount">0</span>L</span> · <span id="winRate">—</span> WR</div>
      </div>
      <div class="cell"><div class="lbl">Positions</div><div class="val" id="openCount">—</div></div>
      <div class="cell"><div class="lbl">Trades</div><div class="val" id="totalTrades">—</div></div>
    </div>

    <!-- Open Positions -->
    <div class="panel">
      <div class="panel-head"><h2>Open Positions</h2><span class="count-tag" id="posCount" style="display:none"></span></div>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Asset</th><th>Side</th><th>Entry</th><th>Mid</th><th>Trend</th><th>APR</th><th>Held</th><th>Adverse</th><th>P&amp;L</th><th></th></tr></thead>
        <tbody id="posTbody"><tr><td colspan="10" class="empty">No open positions</td></tr></tbody>
      </table>
      </div>
    </div>

    <!-- Scanner Log -->
    <div class="panel">
      <div class="panel-head">
        <h2>Scanner</h2>
        <span class="meta" id="scannerSummary"></span>
        <span class="tabs" role="tablist" aria-label="Scanner filter">
          <button class="tab active" data-filter="all">ALL</button>
          <button class="tab" data-filter="enter">ENTERED</button>
          <button class="tab" data-filter="skip">SKIPPED</button>
          <button class="tab" data-filter="hold">HELD</button>
        </span>
        <span class="right" id="scannerTs">waiting for first scan…</span>
      </div>
      <div class="sweep" id="scanSweep"></div>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Asset</th><th>Side</th><th>APR</th><th>Vol 24h</th><th>Decision</th><th>Reason</th></tr></thead>
        <tbody id="scannerTbody"><tr><td colspan="6" class="empty">Scan results appear after first scan</td></tr></tbody>
      </table>
      </div>
    </div>

    <!-- PnL Chart -->
    <div class="panel">
      <div class="panel-head">
        <h2>P&amp;L Since Inception</h2>
        <span class="meta" id="pnlChartTotal"></span>
        <span class="right"><span class="green">●</span> win&nbsp;&nbsp;<span class="red">●</span> loss</span>
      </div>
      <div class="chart-box">
        <canvas id="pnlChart" aria-label="Cumulative profit and loss chart" role="img"></canvas>
        <div id="pnlEmpty" style="display:none">No closed trades yet — chart appears after first close</div>
      </div>
    </div>

    <!-- Funding Rates -->
    <div class="panel">
      <div class="panel-head"><h2>Funding Rates</h2><span class="count-tag" id="rateCount" style="display:none"></span><input class="search" id="rateSearch" type="search" placeholder="filter asset…" aria-label="Filter assets"></div>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Asset</th><th>APR</th><th>Direction</th><th>Vol 24h</th><th>Signal</th></tr></thead>
        <tbody id="ratesTbody"><tr><td colspan="5" class="empty">Rates load after first scan</td></tr></tbody>
      </table>
      </div>
      <div class="pagination" id="ratesPager" style="display:none">
        <div class="page-info">Page <b id="pgNum">1</b> / <b id="pgTotal">1</b> · <b id="pgShowing">—</b></div>
        <div class="page-btns" id="pgBtns"></div>
      </div>
    </div>

    <!-- Trade History -->
    <div class="panel">
      <div class="panel-head"><h2>Trade History</h2><span class="count-tag" id="histCount" style="display:none"></span></div>
      <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Asset</th><th>Side</th><th>Entry</th><th>Exit</th><th>APR</th><th>Held</th><th>P&amp;L</th><th>Reason</th><th>Closed</th></tr></thead>
        <tbody id="histTbody"><tr><td colspan="9" class="empty">No closed trades yet</td></tr></tbody>
      </table>
      </div>
      <div class="pagination" id="histPager" style="display:none">
        <div class="page-info">Page <b id="hpgNum">1</b> / <b id="hpgTotal">1</b> · <b id="hpgShowing">—</b></div>
        <div class="page-btns" id="hpgBtns"></div>
      </div>
    </div>

  </div>

  <!-- RAIL -->
  <aside class="rail">

    <!-- Settlement dial -->
    <div class="panel dial-panel">
      <div class="dial-wrap">
        <svg width="158" height="158" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="dial-track" cx="60" cy="60" r="52"></circle>
          <circle class="dial-prog" id="dialProg" cx="60" cy="60" r="52" stroke-dashoffset="0"></circle>
        </svg>
        <div class="dial-center">
          <div class="dial-time" id="dialTime">--:--</div>
          <div class="dial-cap">to settlement</div>
        </div>
      </div>
      <div class="dial-status ok" id="dialStatus"><span class="dot"></span><span id="dialStatusTxt">—</span></div>
      <div class="dial-note">funding pays hourly on the hour UTC</div>
    </div>

    <!-- Controls -->
    <div class="panel">
      <div class="panel-head"><h2>Controls</h2><span class="right" id="scanStatus"></span></div>
      <div class="controls">
        <button class="btn primary" onclick="triggerScan()">SCAN NOW</button>
        <button class="btn warn" id="pauseBtn" onclick="togglePause()">PAUSE BOT</button>
        <button class="btn" onclick="toggleCfg()" aria-expanded="false" id="cfgToggle">CONFIG</button>
      </div>
      <div class="cfg-panel" id="cfgPanel">
        <div class="cfg-grid">
          <div class="cfg-field"><label for="cfgApr">Min APR %</label><input id="cfgApr" type="number" step="1"></div>
          <div class="cfg-field"><label for="cfgSettle">Min Hrs to Settle</label><input id="cfgSettle" type="number" step="0.1"></div>
          <div class="cfg-field"><label for="cfgMaxSettle">Max Hrs to Settle</label><input id="cfgMaxSettle" type="number" step="0.1"></div>
          <div class="cfg-field"><label for="cfgExitSettle">Exit After Settle min</label><input id="cfgExitSettle" type="number" step="1"></div>
          <div class="cfg-field"><label for="cfgVol">Max Volatility %</label><input id="cfgVol" type="number" step="0.5"></div>
          <div class="cfg-field"><label for="cfgTrend">Trend Filter</label><select id="cfgTrend"><option value="true">On</option><option value="false">Off</option></select></div>
          <div class="cfg-field"><label for="cfgPos">Position USD</label><input id="cfgPos" type="number" step="1"></div>
          <div class="cfg-field"><label for="cfgMaxPos2">Max Position USD</label><input id="cfgMaxPos2" type="number" step="5"></div>
          <div class="cfg-field"><label for="cfgDynSize">Dynamic Sizing</label><select id="cfgDynSize"><option value="true">On</option><option value="false">Off</option></select></div>
          <div class="cfg-field"><label for="cfgSL">Stop Loss %</label><input id="cfgSL" type="number" step="0.1"></div>
          <div class="cfg-field"><label for="cfgTS">Trailing Stop %</label><input id="cfgTS" type="number" step="0.1"></div>
          <div class="cfg-field"><label for="cfgHighAprThr">High APR Threshold</label><input id="cfgHighAprThr" type="number" step="10"></div>
          <div class="cfg-field"><label for="cfgTSHigh">Trail % High APR</label><input id="cfgTSHigh" type="number" step="0.5"></div>
          <div class="cfg-field"><label for="cfgHold">Max Hold Hrs</label><input id="cfgHold" type="number" step="1"></div>
          <div class="cfg-field"><label for="cfgMaxPos">Max Positions</label><input id="cfgMaxPos" type="number" step="1"></div>
          <div class="cfg-field"><label for="cfgMaxSettle2">Max Settlements</label><input id="cfgMaxSettle2" type="number" step="1"></div>
          <div class="cfg-field"><label for="cfgMaxSettleHigh">Max Settl. High APR</label><input id="cfgMaxSettleHigh" type="number" step="1"></div>
          <div class="cfg-field"><label for="cfgAprTrend">APR Trend Filter</label><select id="cfgAprTrend"><option value="true">On</option><option value="false">Off</option></select></div>
          <div class="cfg-field"><label for="cfgRegimeCooldown">Regime Cooldown min</label><input id="cfgRegimeCooldown" type="number" step="1"></div>
        </div>
        <button class="btn btn-save" onclick="saveConfig()">SAVE CONFIG</button>
      </div>
    </div>

    <!-- Account -->
    <div class="panel">
      <div class="panel-head"><h2>Account</h2></div>
      <div class="acct">
        <div class="acct-row"><span class="k">wallet</span><span class="v" id="acctWallet">—</span></div>
        <div class="acct-row"><span class="k">mode</span><span class="v" id="acctMode">—</span></div>
        <div class="acct-row"><span class="k">uptime</span><span class="v" id="acctUptime">—</span></div>
        <div class="acct-row"><span class="k">scan every</span><span class="v" id="acctScan">—</span></div>
      </div>
    </div>

  </aside>
</div>

<script>
'use strict'
// ── helpers ──────────────────────────────────────────
function $(id){ return document.getElementById(id) }
function fmt(n, d){ if(d===undefined)d=2; return (n!=null && isFinite(n)) ? n.toFixed(d) : '—' }
function fmtUsd(n){ return (n!=null && isFinite(n)) ? ((n>=0?'+':'-')+'$'+Math.abs(n).toFixed(3)) : '—' }
function fmtDate(ts){ return ts ? new Date(ts).toLocaleString() : '—' }
function pnlClass(n){ return n>0?'green':n<0?'red':'' }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }

// value flash + animated count on change
var _lerps = {}
function setVal(id, text, numeric, cls, fmtFn){
  var el = $(id); if(!el) return
  var prev = parseFloat(el.dataset.v)
  el.className = 'val' + (cls ? ' ' + cls : '')
  var changed = numeric!=null && isFinite(prev) && Math.abs(numeric-prev) > 1e-9
  if(changed && fmtFn && !matchMedia('(prefers-reduced-motion: reduce)').matches){
    if(_lerps[id]) cancelAnimationFrame(_lerps[id])
    var t0 = performance.now(), dur = 450
    ;(function step(now){
      var t = Math.min(1, (now-t0)/dur)
      var e = 1 - Math.pow(1-t, 3)
      el.textContent = fmtFn(prev + (numeric-prev)*e)
      if(t < 1) _lerps[id] = requestAnimationFrame(step)
      else el.textContent = text
    })(t0)
  } else {
    el.textContent = text
  }
  if(changed){
    el.classList.remove('flash-up','flash-down')
    void el.offsetWidth
    el.classList.add(numeric>prev ? 'flash-up' : 'flash-down')
  }
  el.dataset.v = numeric
}

// equity history sparkline (client-accumulated)
var eqHist = []
function eqPush(v){
  if(v==null || !isFinite(v) || v<=0) return
  if(eqHist.length && Math.abs(eqHist[eqHist.length-1]-v) < 1e-9) return
  eqHist.push(v)
  if(eqHist.length > 60) eqHist.shift()
}
function renderEqSpark(){
  var el = $('eqSpark'); if(!el) return
  if(eqHist.length < 2){ el.innerHTML=''; return }
  var min = Math.min.apply(null,eqHist), max = Math.max.apply(null,eqHist), rng = (max-min) || 1
  var w = 110, h = 14, pts = []
  for(var i=0;i<eqHist.length;i++){
    pts.push((i/(eqHist.length-1)*w).toFixed(1)+','+(h-1.5-(eqHist[i]-min)/rng*(h-3)).toFixed(1))
  }
  el.innerHTML = '<svg width="110" height="14" viewBox="0 0 110 14" aria-hidden="true"><polyline fill="none" stroke="#FFB454" stroke-width="1.3" stroke-linejoin="round" opacity="0.8" points="'+pts.join(' ')+'"/></svg>'
}

// ── sparklines (client-side mid history per asset) ───
var sparkData = {}
function sparkPush(asset, mid){
  if(mid==null) return
  if(!sparkData[asset]) sparkData[asset] = []
  var a = sparkData[asset]
  if(a.length && a[a.length-1] === mid) return
  a.push(mid)
  if(a.length > 48) a.shift()
}
function sparkSvg(asset, up){
  var a = sparkData[asset] || []
  if(a.length < 2) return '<span class="dim" style="font-size:10px">…</span>'
  var min = Math.min.apply(null,a), max = Math.max.apply(null,a), rng = (max-min) || 1
  var w = 64, h = 20, pts = []
  for(var i=0;i<a.length;i++){
    pts.push((i/(a.length-1)*w).toFixed(1) + ',' + (h - 2 - (a[i]-min)/rng*(h-4)).toFixed(1))
  }
  var col = up ? '#46D68C' : '#F25C5C'
  return '<svg width="64" height="20" viewBox="0 0 64 20" aria-hidden="true"><polyline fill="none" stroke="'+col+'" stroke-width="1.5" stroke-linejoin="round" points="'+pts.join(' ')+'"/></svg>'
}

// ── settlement dial ──────────────────────────────────
var nextSettleMs = null
var lastScanAtVal = null
var CIRC = 327

// clock tick marks around the dial (settlement marker at top, amber)
;(function(){
  var svg = document.querySelector('.dial-wrap svg')
  if(!svg) return
  var NS = 'http://www.w3.org/2000/svg'
  for(var k=0;k<12;k++){
    var a = k*Math.PI/6
    var l = document.createElementNS(NS,'line')
    l.setAttribute('x1', (60+57*Math.cos(a)).toFixed(2)); l.setAttribute('y1', (60+57*Math.sin(a)).toFixed(2))
    l.setAttribute('x2', (60+59.5*Math.cos(a)).toFixed(2)); l.setAttribute('y2', (60+59.5*Math.sin(a)).toFixed(2))
    l.setAttribute('stroke', k===0 ? '#FFB454' : '#3A301C')
    l.setAttribute('stroke-width', k%3===0 ? '1.8' : '1')
    svg.appendChild(l)
  }
})()

function fmtAgo(ms){
  var s = Math.floor(ms/1000)
  if(s < 60) return s + 's ago'
  return Math.floor(s/60) + 'm ' + (s%60) + 's ago'
}

setInterval(function(){
  var now = Date.now()
  if(nextSettleMs){
    var ms = nextSettleMs - now
    if(ms <= 0){ nextSettleMs += 3600000; ms += 3600000 }
    var m = Math.floor(ms/60000), s = Math.floor((ms%60000)/1000)
    $('dialTime').textContent = String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0')
    var frac = ms/3600000
    var prog = $('dialProg')
    prog.style.strokeDashoffset = (CIRC*(1-frac)).toFixed(1)
    var minH = (cfg && cfg.minHoursToSettle) || 0.1
    var blocked = frac < minH
    prog.classList.toggle('danger', blocked)
    $('dialTime').style.color = blocked ? '#F25C5C' : ''
    var st = $('dialStatus')
    st.className = 'dial-status ' + (blocked ? 'blocked' : 'ok')
    $('dialStatusTxt').textContent = blocked ? 'ENTRY BLOCKED — SETTLES SOON' : 'ENTRIES OPEN'
  }
  // per-position settlement countdowns
  document.querySelectorAll('.settle-in').forEach(function(el){
    var t = parseFloat(el.dataset.settle)
    if(!t){ el.textContent=''; return }
    var left = t - now
    if(left > 0){
      var mm = Math.floor(left/60000), ss = Math.floor((left%60000)/1000)
      el.textContent = 'settles ' + String(mm).padStart(2,'0') + ':' + String(ss).padStart(2,'0')
      el.classList.toggle('hot', left < 300000)
    } else {
      el.textContent = 'collecting…'
      el.classList.add('hot')
    }
  })
  // relative scan age
  if(lastScanAtVal) $('scannerTs').textContent = 'scanned ' + fmtAgo(now - lastScanAtVal)
}, 500)

// ── pagination ───────────────────────────────────────
var PAGE_SIZE = 25
var _allRates = [], _page = 1
var _allHist = [], _hpage = 1

function pagerBtns(container, page, total, cb){
  var btns = $(container); btns.innerHTML = ''
  function add(label, pg, disabled, active){
    var b = document.createElement('button')
    b.className = 'pbtn' + (active?' active':'')
    b.textContent = label; b.disabled = disabled
    b.onclick = function(){ cb(pg) }
    btns.appendChild(b)
  }
  add('‹', page-1, page===1, false)
  var lo = Math.max(1, page-3), hi = Math.min(total, lo+6)
  for(var p=lo; p<=hi; p++) add(p, p, false, p===page)
  add('›', page+1, page===total, false)
}

function renderRatesPage(rates, page){
  _allRates = rates; _page = page
  var total = Math.max(1, Math.ceil(rates.length/PAGE_SIZE))
  var start = (page-1)*PAGE_SIZE, slice = rates.slice(start, start+PAGE_SIZE)
  var rows = []
  for(var i=0;i<slice.length;i++){
    var r = slice[i]
    var absApr = Math.abs(r.apr)
    var hot = absApr >= (cfg.minFundingApr||60)
    var col = hot ? (r.apr<0 ? '#46D68C' : '#F25C5C') : '#5C543F'
    var barW = Math.min(44, absApr/300*44).toFixed(1)
    var fillStyle = r.apr < 0
      ? 'right:50%;width:'+barW+'px;background:'+col
      : 'left:50%;width:'+barW+'px;background:'+col
    var aprStr = (r.apr>=0?'+':'') + r.apr.toFixed(1) + '%'
    var vol = r.volume24h>=1e6 ? '$'+(r.volume24h/1e6).toFixed(1)+'M' : '$'+(r.volume24h/1e3).toFixed(0)+'K'
    var dir = r.apr<0 ? '<span class="green">longs paid</span>' : '<span class="red">shorts paid</span>'
    var sig = hot ? (r.apr<0 ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>') : '<span class="dim">—</span>'
    rows.push('<tr><td><b>'+esc(r.asset)+'</b></td>'
      + '<td><span class="apr-wrap"><span class="div-bar"><span class="div-fill" style="'+fillStyle+'"></span></span>'
      + '<span class="'+(r.apr<0?'green':'red')+'" style="font-size:11px">'+aprStr+'</span></span></td>'
      + '<td style="font-size:11px">'+dir+'</td>'
      + '<td class="dim" style="font-size:11px">'+vol+'</td>'
      + '<td>'+sig+'</td></tr>')
  }
  $('ratesTbody').innerHTML = rows.join('')
  $('ratesPager').style.display = rates.length > PAGE_SIZE ? 'flex' : 'none'
  $('pgNum').textContent = page; $('pgTotal').textContent = total
  $('pgShowing').textContent = (start+1) + '–' + Math.min(start+PAGE_SIZE, rates.length)
  pagerBtns('pgBtns', page, total, function(pg){ renderRatesPage(_allRates, pg) })
}

function renderHistPage(hist, page){
  _allHist = hist; _hpage = page
  var total = Math.max(1, Math.ceil(hist.length/PAGE_SIZE))
  if(page > total) page = total
  var start = (page-1)*PAGE_SIZE, slice = hist.slice(start, start+PAGE_SIZE)
  var rows = []
  for(var i=0;i<slice.length;i++){
    var t = slice[i]
    var held = (t.closedAt && t.openedAt) ? fmt((t.closedAt-t.openedAt)/3600000,1)+'h' : '—'
    var apr = (t.fundingAPR>=0?'+':'') + fmt(t.fundingAPR,1) + '%'
    rows.push('<tr><td><b>'+esc(t.asset)+'</b></td>'
      + '<td><span class="pill '+t.side.toLowerCase()+'">'+t.side+'</span></td>'
      + '<td>'+fmt(t.entryPrice,4)+'</td>'
      + '<td>'+fmt(t.exitPrice,4)+'</td>'
      + '<td>'+apr+'</td>'
      + '<td>'+held+'</td>'
      + '<td class="'+pnlClass(t.pnlUsd)+'">'+fmtUsd(t.pnlUsd)+'</td>'
      + '<td class="reason">'+esc(t.reason||'—')+'</td>'
      + '<td class="dim" style="font-size:11px">'+fmtDate(t.closedAt)+'</td></tr>')
  }
  $('histTbody').innerHTML = rows.join('')
  $('histPager').style.display = hist.length > PAGE_SIZE ? 'flex' : 'none'
  $('hpgNum').textContent = page; $('hpgTotal').textContent = total
  $('hpgShowing').textContent = (start+1) + '–' + Math.min(start+PAGE_SIZE, hist.length)
  pagerBtns('hpgBtns', page, total, function(pg){ renderHistPage(_allHist, pg) })
}

// ── pnl chart ────────────────────────────────────────
var _pnlChart = null
function buildPnlChart(history){
  var sorted = history.filter(function(t){ return t.closedAt && t.pnlUsd != null })
    .sort(function(a,b){ return a.closedAt - b.closedAt })
  var emptyEl = $('pnlEmpty'), canvasEl = $('pnlChart')
  if(!sorted.length){ emptyEl.style.display='flex'; canvasEl.style.display='none'; return }
  emptyEl.style.display='none'; canvasEl.style.display='block'

  var cum = 0
  var lineData = [{x:new Date(sorted[0].closedAt-1), y:0}]
  var winPts = [], lossPts = []
  sorted.forEach(function(t){
    cum += t.pnlUsd
    var pt = {x:new Date(t.closedAt), y:parseFloat(cum.toFixed(5)), trade:t}
    lineData.push(pt)
    ;(t.pnlUsd >= 0 ? winPts : lossPts).push(pt)
  })

  var tot = $('pnlChartTotal')
  tot.textContent = (cum>=0?'+':'') + '$' + cum.toFixed(4)
  tot.style.color = cum>=0 ? '#46D68C' : '#F25C5C'

  var ctx = canvasEl.getContext('2d')
  var grad = ctx.createLinearGradient(0,0,0,250)
  if(cum>=0){ grad.addColorStop(0,'rgba(70,214,140,0.18)'); grad.addColorStop(1,'rgba(70,214,140,0.01)') }
  else { grad.addColorStop(0,'rgba(242,92,92,0.18)'); grad.addColorStop(1,'rgba(242,92,92,0.01)') }

  if(_pnlChart){ _pnlChart.destroy(); _pnlChart = null }
  _pnlChart = new Chart(ctx, {
    data:{ datasets:[
      { type:'line', label:'Equity', data:lineData,
        borderColor: cum>=0 ? '#46D68C' : '#F25C5C',
        backgroundColor: grad, tension:0.3, fill:true,
        pointRadius:0, pointHoverRadius:0, borderWidth:2, order:3 },
      { type:'scatter', label:'Win', data:winPts,
        backgroundColor:'#46D68C', borderColor:'#0C0A07', borderWidth:1.5,
        pointRadius:4.5, pointHoverRadius:7, order:1 },
      { type:'scatter', label:'Loss', data:lossPts,
        backgroundColor:'#F25C5C', borderColor:'#0C0A07', borderWidth:1.5,
        pointRadius:4.5, pointHoverRadius:7, order:2 }
    ]},
    options:{
      responsive:true, maintainAspectRatio:false,
      interaction:{mode:'nearest',intersect:false,axis:'x'},
      plugins:{
        legend:{display:false},
        tooltip:{
          backgroundColor:'#181309', titleColor:'#EDE6D8', bodyColor:'#9A9078',
          borderColor:'#3A301C', borderWidth:1, padding:10,
          titleFont:{family:"'IBM Plex Mono',monospace",size:12},
          bodyFont:{family:"'IBM Plex Mono',monospace",size:11},
          callbacks:{
            title:function(items){
              var d = items[0].dataset.data[items[0].dataIndex]
              return d.trade ? d.trade.asset + ' · ' + d.trade.side : 'Start'
            },
            label:function(item){
              var d = item.dataset.data[item.dataIndex]
              if(!d.trade) return 'PnL: $0.00'
              var t = d.trade, sign = t.pnlUsd>=0?'+':''
              return [
                'trade: ' + sign + '$' + t.pnlUsd.toFixed(4),
                'total: $' + item.parsed.y.toFixed(4),
                'apr: ' + (t.fundingAPR>=0?'+':'') + (t.fundingAPR||0).toFixed(1) + '%',
                'exit: ' + (t.reason||'—'),
                new Date(t.closedAt).toLocaleString()
              ]
            }
          }
        }
      },
      scales:{
        x:{ type:'time',
          time:{tooltipFormat:'MMM d HH:mm',displayFormats:{hour:'MMM d HH:mm',day:'MMM d',minute:'HH:mm'}},
          grid:{color:'rgba(237,230,216,0.05)'},
          ticks:{color:'#5C543F',font:{family:"'IBM Plex Mono',monospace",size:10},maxTicksLimit:8} },
        y:{ grid:{color:'rgba(237,230,216,0.05)'},
          ticks:{color:'#5C543F',font:{family:"'IBM Plex Mono',monospace",size:10},
            callback:function(v){return '$'+Number(v).toFixed(3)}},
          afterDataLimits:function(scale){
            var pad = Math.abs(scale.max-scale.min)*0.1 || 0.01
            scale.max += pad; scale.min -= pad
          } }
      }
    }
  })
}

// ── refresh ──────────────────────────────────────────
var cfg = {}
var DEC = {
  ENTER:   {cls:'dec-enter', label:'ENTER'},
  HOLDING: {cls:'dec-hold',  label:'HOLDING'},
  SKIP:    {cls:'dec-skip',  label:'SKIP'},
  FAILED:  {cls:'dec-skip',  label:'FAILED'},
  COOLDOWN:{cls:'dec-cool',  label:'COOLDOWN'},
  LOW_APR: {cls:'dec-dim',   label:'LOW APR'},
  LOW_VOL: {cls:'dec-dim',   label:'LOW VOL'},
  MAX_POS: {cls:'dec-dim',   label:'MAX POS'},
  PENDING: {cls:'dec-dim',   label:'PENDING'}
}

// ── ticker tape ──────────────────────────────────────
var tapeSig = ''
function renderTape(rates){
  var top = rates.slice(0, 18)
  if(!top.length) return
  var sig = top.map(function(r){ return r.asset + Math.round(r.apr) }).join('|')
  if(sig === tapeSig) return
  tapeSig = sig
  var items = top.map(function(r){
    var c = r.apr < 0 ? 'green' : 'red'
    return '<span class="tape-item"><b>'+esc(r.asset)+'</b><span class="'+c+'">'+(r.apr>=0?'+':'')+r.apr.toFixed(1)+'%</span></span>'
  }).join('')
  $('tapeTrack').innerHTML = items + items
}

// ── scanner (filterable) ─────────────────────────────
var scanCache = [], scanFilter = 'all', scanRenderedAt = null
function matchesFilter(s){
  if(scanFilter==='all') return true
  if(scanFilter==='enter') return s.decision==='ENTER'
  if(scanFilter==='hold') return s.decision==='HOLDING'
  return s.decision!=='ENTER' && s.decision!=='HOLDING'
}
function renderScanner(animate){
  var list = scanCache.filter(matchesFilter)
  var tb = $('scannerTbody')
  if(!scanCache.length){
    tb.innerHTML = '<tr><td colspan="6" class="empty">Scan results appear after first scan</td></tr>'
    return
  }
  if(!list.length){
    tb.innerHTML = '<tr><td colspan="6" class="empty">No assets match this filter</td></tr>'
    return
  }
  tb.innerHTML = list.map(function(s, i){
    var aprStr = (s.apr>=0?'+':'') + s.apr.toFixed(1) + '%'
    var side = s.isBuy ? '<span class="pill long">LONG</span>' : '<span class="pill short">SHORT</span>'
    var vol = s.vol>=1e6 ? '$'+(s.vol/1e6).toFixed(1)+'M' : '$'+(s.vol/1e3).toFixed(0)+'K'
    var dec = DEC[s.decision] || {cls:'dec-dim', label:s.decision}
    return '<tr style="--i:'+i+'"><td><b>'+esc(s.asset)+'</b></td>'
      + '<td>'+side+'</td>'
      + '<td class="'+(s.apr<0?'green':'red')+'" style="font-size:11px">'+aprStr+'</td>'
      + '<td class="dim" style="font-size:11px">'+vol+'</td>'
      + '<td><span class="badge-dec '+dec.cls+'">'+dec.label+'</span></td>'
      + '<td class="reason">'+esc(s.reason||'—')+'</td></tr>'
  }).join('')
  if(animate){
    tb.classList.add('fresh')
    setTimeout(function(){ tb.classList.remove('fresh') }, 900)
  }
}

async function refresh(){
  try{
    var d = await fetch('/api/status').then(function(r){return r.json()})
    cfg = d.cfg

    $('ts').textContent = 'updated ' + new Date(d.ts).toLocaleTimeString()

    var mb = $('modeBadge')
    mb.innerHTML = (d.mode==='LIVE' ? '<span class="dot"></span>' : '') + d.mode
    mb.className = 'chip ' + (d.mode==='LIVE' ? 'live' : 'dry')
    $('pauseBadge').style.display = d.paused ? 'inline-flex' : 'none'
    $('pauseBtn').textContent = d.paused ? 'RESUME BOT' : 'PAUSE BOT'
    $('scanStatus').textContent = d.scanning ? 'scanning…' : ''
    $('scanSweep').classList.toggle('on', !!d.scanning)

    // regime chip
    var rg = $('regimeChip')
    if(d.regime){
      rg.style.display = 'inline-flex'
      var pct = Math.round((d.crowdedRatio||0)*100)
      if(d.regime==='crowded_long'){ rg.className='chip regime-crowded'; rg.textContent='CROWDED LONG · '+pct+'%' }
      else { rg.className='chip regime-neutral'; rg.textContent='REGIME NEUTRAL · '+pct+'% LONG-PAID' }
    }

    // instrument strip
    setVal('equity', '$'+fmt(d.equity), d.equity, '', function(v){return '$'+v.toFixed(2)})
    setVal('avail', '$'+fmt(d.avail), d.avail, '', function(v){return '$'+v.toFixed(2)})
    eqPush(d.equity); renderEqSpark()
    var openPnl = d.positions.reduce(function(s,p){return s+(p.pnlUsd||0)},0)
    setVal('openPnl', fmtUsd(openPnl), openPnl, openPnl>0?'pos':openPnl<0?'neg':'', fmtUsd)
    var closedPnl = d.totalClosedPnl != null ? d.totalClosedPnl : d.history.reduce(function(s,t){return s+(t.pnlUsd||0)},0)
    setVal('closedPnl', fmtUsd(closedPnl), closedPnl, closedPnl>0?'pos':closedPnl<0?'neg':'', fmtUsd)
    var wins = d.totalWins||0, losses = d.totalLosses||0
    $('winCount').textContent = wins; $('lossCount').textContent = losses
    $('winRate').textContent = (wins+losses) ? Math.round(wins/(wins+losses)*100)+'%' : '—'
    setVal('openCount', d.openCount + '/' + d.cfg.maxPositions, d.openCount)
    setVal('totalTrades', String(d.totalTrades != null ? d.totalTrades : d.history.length), d.totalTrades)

    // dial sync
    nextSettleMs = Date.now() + d.hoursToSettle*3600000

    // account
    var w = d.wallet || ''
    $('acctWallet').textContent = w ? w.slice(0,6)+'…'+w.slice(-4) : '—'
    $('acctWallet').title = w
    $('acctMode').textContent = d.mode
    if(d.startedAt){
      var up = Date.now() - d.startedAt
      var uh = Math.floor(up/3600000), um = Math.floor((up%3600000)/60000)
      $('acctUptime').textContent = uh > 0 ? uh+'h '+um+'m' : um+'m'
    }
    $('acctScan').textContent = Math.round(d.cfg.scanIntervalMs/1000) + 's'

    // config inputs (don't clobber while panel open)
    if(!$('cfgPanel').classList.contains('open')){
      $('cfgApr').value = d.cfg.minFundingApr
      $('cfgSettle').value = d.cfg.minHoursToSettle
      $('cfgMaxSettle').value = d.cfg.maxHoursToSettle != null ? d.cfg.maxHoursToSettle : 1.0
      $('cfgExitSettle').value = d.cfg.exitAfterSettleMins != null ? d.cfg.exitAfterSettleMins : 3
      $('cfgVol').value = d.cfg.maxVolatilityPct
      $('cfgTrend').value = d.cfg.trendFilter ? 'true' : 'false'
      $('cfgPos').value = d.cfg.positionUsd
      $('cfgMaxPos2').value = d.cfg.maxPositionUsd != null ? d.cfg.maxPositionUsd : 60
      $('cfgDynSize').value = d.cfg.dynamicSizing ? 'true' : 'false'
      $('cfgSL').value = d.cfg.stopLossPct
      $('cfgTS').value = d.cfg.trailingStopPct
      $('cfgHighAprThr').value = d.cfg.highAprThreshold != null ? d.cfg.highAprThreshold : 300
      $('cfgTSHigh').value = d.cfg.trailingStopHighApr != null ? d.cfg.trailingStopHighApr : 5
      $('cfgHold').value = d.cfg.maxHoldHours
      $('cfgMaxPos').value = d.cfg.maxPositions
      $('cfgMaxSettle2').value = d.cfg.maxSettlements != null ? d.cfg.maxSettlements : 1
      $('cfgMaxSettleHigh').value = d.cfg.highAprMaxSettlements != null ? d.cfg.highAprMaxSettlements : 3
      $('cfgAprTrend').value = d.cfg.aprTrendFilter ? 'true' : 'false'
      $('cfgRegimeCooldown').value = d.cfg.regimeFlipCooldownMins != null ? d.cfg.regimeFlipCooldownMins : 10
    }

    // positions
    d.positions.forEach(function(p){ sparkPush(p.asset, p.midPrice) })
    var pc = $('posCount')
    pc.textContent = d.positions.length ? d.positions.length + ' open' : ''
    pc.style.display = d.positions.length ? 'inline-block' : 'none'
    if(!d.positions.length){
      $('posTbody').innerHTML = '<tr><td colspan="10" class="empty">No open positions — scanner runs every ' + Math.round(d.cfg.scanIntervalMs/60000) + ' min</td></tr>'
    } else {
      $('posTbody').innerHTML = d.positions.map(function(p){
        var adv = p.adversePct != null ? fmt(p.adversePct)+'%' : '—'
        var advFrac = p.adversePct != null ? Math.min(1, Math.max(0, p.adversePct/(cfg.stopLossPct||1.5))) : 0
        var advCol = advFrac > 0.66 ? '#F25C5C' : advFrac > 0.4 ? '#E8C547' : '#46D68C'
        var held = fmt(p.heldHours,1)+'h'
        var apr = (p.fundingAPR>=0?'+':'') + fmt(p.fundingAPR,1) + '%'
        return '<tr><td><b>'+esc(p.asset)+'</b></td>'
          + '<td><span class="pill '+p.side.toLowerCase()+'">'+p.side+'</span></td>'
          + '<td>'+fmt(p.entryPrice,4)+'</td>'
          + '<td>'+fmt(p.midPrice,4)+'</td>'
          + '<td>'+sparkSvg(p.asset, (p.pnlUsd||0) >= 0)+'</td>'
          + '<td class="'+(p.fundingAPR<0?'green':'red')+'">'+apr+'</td>'
          + '<td>'+held+'<div class="settle-in" data-settle="'+(p.settlesAt||'')+'"></div></td>'
          + '<td><span class="meter"><span class="meter-bg"><span class="meter-fill" style="width:'+(advFrac*52).toFixed(0)+'px;background:'+advCol+'"></span></span>'
          + '<span style="font-size:11px;color:'+advCol+'">'+adv+'</span></span></td>'
          + '<td class="'+pnlClass(p.pnlUsd)+'">'+fmtUsd(p.pnlUsd)+'</td>'
          + '<td><button class="btn-close" data-asset="'+esc(p.asset)+'">CLOSE</button></td></tr>'
      }).join('')
    }

    // scanner
    if(d.scanDecisions && d.scanDecisions.length){
      var enters = 0, holding = 0, skips = 0
      d.scanDecisions.forEach(function(x){
        if(x.decision==='ENTER') enters++
        else if(x.decision==='HOLDING') holding++
        else skips++
      })
      $('scannerSummary').textContent = d.scanDecisions.length+' assets · '+enters+' entered · '+skips+' skipped'+(holding?' · '+holding+' held':'')
      scanCache = d.scanDecisions
      var newScan = d.lastScanAt && d.lastScanAt !== lastScanAtVal
      lastScanAtVal = d.lastScanAt || lastScanAtVal
      renderScanner(newScan)
    }

    // rates (with search filter)
    ratesRaw = d.rates
    var rc = $('rateCount')
    rc.textContent = d.rates.length ? d.rates.length+' assets' : ''
    rc.style.display = d.rates.length ? 'inline-block' : 'none'
    if(d.rates.length){
      renderTape(d.rates)
      var fr = filteredRates()
      renderRatesPage(fr, Math.min(_page, Math.max(1, Math.ceil(fr.length/PAGE_SIZE))))
    }

    // chart
    buildPnlChart(d.history)

    // history
    var hc = $('histCount')
    var totalH = d.totalTrades != null ? d.totalTrades : d.history.length
    hc.textContent = totalH ? totalH+' trades' : ''
    hc.style.display = totalH ? 'inline-block' : 'none'
    if(d.history.length) renderHistPage(d.history, _hpage)
  } catch(e){
    $('ts').textContent = 'error: ' + e.message
  }
}

// ── actions ──────────────────────────────────────────
document.addEventListener('click', async function(e){
  var btn = e.target.closest('[data-asset]')
  if(!btn) return
  var asset = btn.dataset.asset
  if(!confirm('Close ' + asset + ' position now?')) return
  btn.disabled = true; btn.textContent = '…'
  var r = await fetch('/api/close/' + encodeURIComponent(asset), {method:'POST'}).then(function(x){return x.json()})
  if(r.error) alert('Error: ' + r.error)
  refresh()
})

async function triggerScan(){
  $('scanStatus').textContent = 'triggering…'
  $('scanSweep').classList.add('on')
  await fetch('/api/scan', {method:'POST'})
  setTimeout(refresh, 1200)
}

async function togglePause(){
  await fetch('/api/pause', {method:'POST'})
  refresh()
}

function toggleCfg(){
  var p = $('cfgPanel')
  p.classList.toggle('open')
  $('cfgToggle').setAttribute('aria-expanded', p.classList.contains('open') ? 'true' : 'false')
}

async function saveConfig(){
  var body = {
    minFundingApr:        parseFloat($('cfgApr').value),
    minHoursToSettle:     parseFloat($('cfgSettle').value),
    maxHoursToSettle:     parseFloat($('cfgMaxSettle').value),
    exitAfterSettleMins:  parseFloat($('cfgExitSettle').value),
    maxVolatilityPct:     parseFloat($('cfgVol').value),
    trendFilter:          $('cfgTrend').value === 'true',
    positionUsd:          parseFloat($('cfgPos').value),
    maxPositionUsd:       parseFloat($('cfgMaxPos2').value),
    dynamicSizing:        $('cfgDynSize').value === 'true',
    stopLossPct:          parseFloat($('cfgSL').value),
    trailingStopPct:      parseFloat($('cfgTS').value),
    highAprThreshold:     parseFloat($('cfgHighAprThr').value),
    trailingStopHighApr:  parseFloat($('cfgTSHigh').value),
    maxHoldHours:         parseFloat($('cfgHold').value),
    maxPositions:         parseInt($('cfgMaxPos').value),
    maxSettlements:       parseInt($('cfgMaxSettle2').value),
    highAprMaxSettlements:parseInt($('cfgMaxSettleHigh').value),
    aprTrendFilter:       $('cfgAprTrend').value === 'true',
    regimeFlipCooldownMins: parseFloat($('cfgRegimeCooldown').value)
  }
  await fetch('/api/config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)})
  toggleCfg()
  refresh()
}

// ── rates search ─────────────────────────────────────
var ratesRaw = [], rateQuery = ''
function filteredRates(){
  if(!rateQuery) return ratesRaw
  return ratesRaw.filter(function(r){ return r.asset.toUpperCase().indexOf(rateQuery) !== -1 })
}
$('rateSearch').addEventListener('input', function(){
  rateQuery = this.value.trim().toUpperCase()
  renderRatesPage(filteredRates(), 1)
})

// ── scanner tab wiring ───────────────────────────────
document.querySelectorAll('.tab').forEach(function(t){
  t.addEventListener('click', function(){
    document.querySelectorAll('.tab').forEach(function(x){ x.classList.remove('active') })
    t.classList.add('active')
    scanFilter = t.dataset.filter
    renderScanner(true)
  })
})

refresh()
setInterval(refresh, 15000)
</script>
</body>
</html>`

// ── HTTP SERVER ────────────────────────────────────────────────────────────────
createServer(async (req, res) => {
  try {
  log(`HTTP ${req.method} ${req.url}`)
  const url    = req.url
  const method = req.method

  const json = (data, code=200) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify(data))
  }

  if (url === '/health') { res.writeHead(200); res.end('ok'); return }

  if (method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(HTML)
  }

  if (method === 'GET' && url === '/api/status') {
    return json(await apiStatus())
  }

  if (method === 'POST' && url.startsWith('/api/close/')) {
    const asset = url.split('/api/close/')[1]
    return json(await apiClose(asset))
  }

  if (method === 'POST' && url === '/api/scan') {
    scan().catch(e => log('Scan error:', e.message))
    return json({ ok: true, message: 'Scan triggered' })
  }

  if (method === 'POST' && url === '/api/pause') {
    paused = !paused
    log(paused ? 'Bot PAUSED' : 'Bot RESUMED')
    return json({ ok: true, paused })
  }

  if (method === 'POST' && url === '/api/config') {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
      try {
        const updates = JSON.parse(body)
        Object.assign(CFG, updates)
        writeFileSync(CONFIG_FILE, JSON.stringify(CFG, null, 2))
        log('Config updated + saved:', updates)
        json({ ok: true, cfg: CFG })
      } catch { json({ error: 'Invalid JSON' }, 400) }
    })
    return
  }

  res.writeHead(404); res.end()
  } catch (e) {
    log('HTTP handler error:', e.message)
    try { res.writeHead(500); res.end('Internal Server Error') } catch {}
  }
}).listen(PORT, '0.0.0.0', () => {
  log(`Dashboard: http://0.0.0.0:${PORT}`)
})

// ── BOOT ──────────────────────────────────────────────────────────────────────
log(`=== Funding Bot Starting ===`)
log(`Mode: ${CFG.dryRun ? 'DRY RUN' : 'LIVE'} | Wallet: ${identity.hl.address}`)
log(`$${CFG.positionUsd}/pos | ${CFG.leverage}x | SL ${CFG.stopLossPct}% | max ${CFG.maxHoldHours}h | threshold ${CFG.minFundingApr}% APR`)

await syncPositionsFromHL()
await scan()
scheduleScan()
scheduleLiveRefresh()
