#!/usr/bin/env node
/**
 * funding-bot.js — Funding Rate Harvester + Dashboard
 * Bot + dashboard in one process. Dashboard: http://localhost:3505
 * Run: node C:\Users\waghk\funding-bot.js
 */

import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { pathToFileURL, fileURLToPath } from 'url'
import { homedir } from 'os'
import { createRequire } from 'module'

const _require = createRequire(import.meta.url)

// ── CONFIG (editable from dashboard) ──────────────────────────────────────────
let CFG = {
  dryRun:         false,
  maxPositions:   2,
  positionUsd:    20,
  leverage:       1,
  stopLossPct:      1.5,
  trailingStopPct:      2.0,  // trail 2% below peak (0 = disabled)
  highAprThreshold:     300,  // APR % above which wider trail applies
  trailingStopHighApr:  5.0,  // trail % for high-APR positions
  dynamicSizing:        true, // scale position size with APR
  maxPositionUsd:       60,   // max size when APR >= highAprThreshold
  maxHoldHours:     8,
  minFundingApr:    30,
  minHoursToSettle: 0.1,  // don't enter in last 6min (slippage risk)
  maxHoursToSettle: 1.0,  // only enter within 1h of settlement (tight timing window)
  exitAfterSettleMins: 15, // auto-exit this many minutes after settlement
  trendFilter:      true,  // skip if price trend opposes entry direction
  maxVolatilityPct: 5,     // skip if 1h range > 5% (0 = disabled)
  scanIntervalMs:   60 * 1000, // 1 min — entry scan (funding rates don't change intra-period)
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
let paused       = false
let scanning     = false
let scanTimer    = null
let lastRates    = {}   // { asset: { apr, volume24h, ts } }
let lastMidPrices = {} // { asset: price } updated during scan
let cachedBal    = null // last fetched balance

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

// Funding settles at 00:00, 08:00, 16:00 UTC every day
function hoursUntilNextSettlement() {
  const now = new Date()
  const h = now.getUTCHours(), m = now.getUTCMinutes(), s = now.getUTCSeconds()
  const minuteOfDay = h * 60 + m + s / 60
  const settlements = [0, 8 * 60, 16 * 60, 24 * 60]
  for (const t of settlements) {
    if (t > minuteOfDay) return (t - minuteOfDay) / 60
  }
  return 0
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
  } catch { return { ok: true, reason: 'filter error — allowed' } }
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
  const exitPrice = parseFloat(result?.filled?.avgPx ?? result?.avgPrice ?? 0) || null
  log(`CLOSED ${asset}:`, exitPrice ? `avg $${exitPrice}` : result?.error)
  return exitPrice
}

// ── SCAN ──────────────────────────────────────────────────────────────────────
async function scan() {
  if (scanning) { log('Scan already running, skipping'); return }
  if (paused)   { log('Bot paused, skipping scan'); return }
  scanning = true
  const state = loadState()
  const now   = Date.now()

  // Bulk fetch all funding rates (single API call)
  log('Fetching all funding rates...')
  const allRates = await getAllFundingRates()
  for (const r of allRates) lastRates[r.asset] = { apr: r.apr, volume24h: r.volume24h, ts: now }
  log(`Loaded ${allRates.length} assets`)

  // Scan for new entries
  const openCount = Object.keys(state.positions).length
  const hoursLeft = hoursUntilNextSettlement()
  if (openCount < CFG.maxPositions) {
    const maxHrs = CFG.maxHoursToSettle ?? 8
    if (hoursLeft < CFG.minHoursToSettle) {
      log(`Skipping new entries — only ${hoursLeft.toFixed(2)}h to settlement (min ${CFG.minHoursToSettle}h required)`)
    } else if (hoursLeft > maxHrs) {
      log(`Skipping new entries — ${hoursLeft.toFixed(2)}h to settlement (entry window: ${CFG.minHoursToSettle}–${maxHrs}h before settlement)`)
    } else {
    const opps = allRates
      .filter(r => !state.positions[r.asset])
      .filter(r => !(state.cooldowns[r.asset] && state.cooldowns[r.asset] > now))
      .filter(r => Math.abs(r.apr) >= CFG.minFundingApr && r.volume24h >= 1_000_000)
      .sort((a, b) => Math.abs(b.apr) - Math.abs(a.apr))

    log(`Opportunities (${hoursLeft.toFixed(1)}h to settlement): ${opps.slice(0,5).map(o=>`${o.asset}:${o.apr.toFixed(1)}%`).join(', ') || 'none'}`)

    for (const opp of opps) {
      if (Object.keys(state.positions).length >= CFG.maxPositions) break
      const isBuy  = opp.apr < 0
      const filter = await passesEntryFilters(opp.asset, isBuy, Math.abs(opp.apr))
      if (!filter.ok) { log(`SKIP ${opp.asset} — ${filter.reason}`); continue }
      const result = await openPosition(opp.asset, isBuy, opp.apr)
      if (!result || result.failed) {
        // Cool down failed asset for 30 min to prevent retry spam on fast scan
        state.cooldowns[opp.asset] = now + 30 * 60 * 1000
        saveState(state)
        continue
      }
      const mid = await hl.getMidPrice(opp.asset)
      const settlesAt = now + hoursLeft * 3600000
      state.positions[opp.asset] = { isBuy, entryPrice: parseFloat(result?.filled?.avgPx ?? result?.avgPrice ?? 0) || mid, openedAt: now, fundingAPR: opp.apr, sizeUsd: result.sizeUsd ?? CFG.positionUsd, settlesAt }
      saveState(state)
    }
    } // end else (enough time to settle)
  }

  cachedBal = await hl.getAccountState(identity.hl.address).catch(() => null)
  const equity = cachedBal?.equity ?? '?'
  log(`Scan complete | equity $${equity} | open: ${Object.keys(state.positions).length}/${CFG.maxPositions} | next entry-scan in ${CFG.scanIntervalMs/1000}s`)
  log('---')
  scanning = false
}

function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer)
  scanTimer = setTimeout(async () => { await scan(); scheduleScan() }, CFG.scanIntervalMs)
}

// Refresh mid prices every 5s + enforce SL + price-change spike exit
// NOTE: intentionally NOT gated on `scanning` — stop losses must fire even during a slow scan
async function liveRefresh() {
  try {
    const state = loadState()
    const now   = Date.now()
    let changed = false

    for (const [asset, pos] of Object.entries(state.positions)) {
      const mid = await hl.getMidPrice(asset).catch(() => null)
      if (!mid) continue

      const prevMid = lastMidPrices[asset]
      lastMidPrices[asset] = mid

      const pricePct   = ((mid - pos.entryPrice) / pos.entryPrice) * 100
      const adversePct = pos.isBuy ? -pricePct : pricePct
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
      if (!exitReason && pos.settlesAt) {
        const minsAfterSettle = (now - pos.settlesAt) / 60000
        const exitMins = CFG.exitAfterSettleMins ?? 15
        if (minsAfterSettle >= exitMins)
          exitReason = `post-settlement exit (+${minsAfterSettle.toFixed(0)}min after funding)`
      }
      if (!exitReason && heldHours >= CFG.maxHoldHours)
        exitReason = `max hold ${heldHours.toFixed(1)}h`

      if (exitReason) {
        const exitPrice = await closePosition(asset, exitReason)
        const pnlUsd    = exitPrice ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * (pos.sizeUsd ?? CFG.positionUsd) * (pos.isBuy ? 1 : -1) : null
        state.history.unshift({ asset, side: pos.isBuy ? 'LONG' : 'SHORT', entryPrice: pos.entryPrice,
          exitPrice, fundingAPR: pos.fundingAPR, openedAt: pos.openedAt, closedAt: now, reason: exitReason, pnlUsd })
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
  } catch (e) { log('liveRefresh error:', e.message) }
}
setInterval(liveRefresh, CFG.liveRefreshMs ?? 5000)

// ── API HANDLERS ──────────────────────────────────────────────────────────────
function apiStatus() {
  const state  = loadState()
  const equity = parseFloat(cachedBal?.equity ?? cachedBal?.marginSummary?.accountValue ?? 0)
  const avail  = parseFloat(cachedBal?.availableBalance ?? 0)

  const positions = Object.entries(state.positions).map(([asset, pos]) => {
    const mid        = lastMidPrices[asset] ?? null
    const pricePct   = mid ? ((mid - pos.entryPrice) / pos.entryPrice) * 100 : null
    const adversePct = pricePct !== null ? (pos.isBuy ? -pricePct : pricePct) : null
    const pnlUsd     = pricePct !== null ? (pricePct / 100) * (pos.sizeUsd ?? CFG.positionUsd) * (pos.isBuy ? 1 : -1) : null
    return { asset, side: pos.isBuy ? 'LONG' : 'SHORT', entryPrice: pos.entryPrice,
      midPrice: mid, fundingAPR: pos.fundingAPR, heldHours: (Date.now() - pos.openedAt) / 3600000,
      adversePct, pnlUsd, openedAt: pos.openedAt }
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
    wallet: identity.hl.address, hoursToSettle, ts: new Date().toISOString() }
}

async function apiClose(asset) {
  const state = loadState()
  if (!state.positions[asset]) return { error: 'Position not found' }
  const pos       = state.positions[asset]
  const mid       = await hl.getMidPrice(asset).catch(() => null)
  const exitPrice = await closePosition(asset, 'manual close from dashboard') ?? mid
  const pricePct  = exitPrice ? ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100 : null
  const pnlUsd    = pricePct !== null ? (pricePct / 100) * (pos.sizeUsd ?? CFG.positionUsd) * (pos.isBuy ? 1 : -1) : null
  state.history.unshift({ asset, side: pos.isBuy ? 'LONG' : 'SHORT', entryPrice: pos.entryPrice,
    exitPrice, fundingAPR: pos.fundingAPR, openedAt: pos.openedAt, closedAt: Date.now(),
    reason: 'manual', pnlUsd })
  delete state.positions[asset]
  saveState(state)
  return { ok: true, exitPrice, pnlUsd }
}

// ── DASHBOARD HTML ────────────────────────────────────────────────────────────
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Funding Bot</title>
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;600;700;900&family=Share+Tech+Mono&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#020209;--bg2:#04040f;--border:#0d0d2e;--border2:#1a1a4a;--accent:#00f5ff;--accent2:#7c3aed;--green:#00ff88;--red:#ff2d55;--yellow:#ffd60a;--text:#c8d6ff;--muted:#3a3a6a;--card:rgba(4,4,20,0.3)}
body{background:var(--bg);color:var(--text);font-family:'Share Tech Mono',monospace;font-size:13px;min-height:100vh;overflow-x:hidden}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,245,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,245,255,0.03) 1px,transparent 1px);background-size:60px 60px;animation:gridMove 20s linear infinite;pointer-events:none;z-index:1}
body::after{content:'';position:fixed;inset:0;background:radial-gradient(ellipse at 50% 0%,rgba(124,58,237,0.12) 0%,transparent 60%),radial-gradient(ellipse at 100% 100%,rgba(0,245,255,0.08) 0%,transparent 50%);pointer-events:none;z-index:1}
@keyframes gridMove{0%{background-position:0 0}100%{background-position:60px 60px}}
#bgCanvas{position:fixed;inset:0;z-index:0;pointer-events:none}
/* SCROLLBAR */
::-webkit-scrollbar{width:3px;height:3px}::-webkit-scrollbar-track{background:rgba(0,0,0,0.2)}::-webkit-scrollbar-thumb{background:linear-gradient(180deg,#00f5ff,#7c3aed);border-radius:2px}
/* HEADER */
.header{position:sticky;top:0;z-index:100;background:rgba(2,2,9,0.92);border-bottom:1px solid var(--border2);padding:14px 24px;display:flex;align-items:center;gap:16px;backdrop-filter:blur(20px)}
.header h1{font-family:'Orbitron',monospace;font-size:16px;font-weight:700;color:var(--accent);letter-spacing:3px;animation:hglow 3s ease-in-out infinite}
@keyframes hglow{0%,100%{text-shadow:0 0 16px rgba(0,245,255,0.5)}50%{text-shadow:0 0 30px rgba(0,245,255,0.9),0 0 60px rgba(0,245,255,0.3)}}
.badge{padding:3px 12px;border-radius:20px;font-size:11px;font-weight:600;letter-spacing:1px;display:inline-flex;align-items:center;gap:6px}
.badge.live{background:rgba(0,255,136,0.08);color:var(--green);border:1px solid rgba(0,255,136,0.3)}
.badge.dry{background:rgba(58,58,106,0.3);color:#888;border:1px solid var(--border2)}
.badge.paused{background:rgba(255,214,10,0.08);color:var(--yellow);border:1px solid rgba(255,214,10,0.3)}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 8px var(--green);animation:pdot 1.8s ease-in-out infinite}
@keyframes pdot{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.5);opacity:0.5}}
.ts{margin-left:auto;color:var(--muted);font-size:11px}
/* BODY */
.body{position:relative;z-index:10;padding:20px 24px;display:flex;flex-direction:column;gap:16px}
/* CARDS */
.cards{display:flex;gap:12px;flex-wrap:wrap}
.card{background:var(--card);border:1px solid var(--border2);border-radius:8px;padding:14px 18px;min-width:130px;flex:1;position:relative;overflow:hidden;transition:transform .15s,border-color .2s,box-shadow .2s;cursor:default;transform-style:preserve-3d;backdrop-filter:blur(12px)}
.card:hover{border-color:rgba(0,245,255,0.3);box-shadow:0 8px 32px rgba(0,0,0,0.6),0 0 20px rgba(0,245,255,0.06)}
.card::before{content:'';position:absolute;top:0;left:-100%;width:60%;height:100%;background:linear-gradient(90deg,transparent,rgba(0,245,255,0.04),transparent);transition:left .5s ease;pointer-events:none}
.card:hover::before{left:140%}
.card::after{content:'';position:absolute;bottom:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--accent),transparent);transform:scaleX(0);transition:transform .3s}
.card:hover::after{transform:scaleX(1)}
.lbl{font-size:11px;text-transform:uppercase;color:#7aa8d4;margin-bottom:6px;letter-spacing:1.5px}
.val{font-family:'Orbitron',monospace;font-size:20px;font-weight:700;color:var(--text);transition:text-shadow .2s}
.val.green{color:var(--green)}.val.red{color:var(--red)}.val.yellow{color:var(--yellow)}
.card:hover .val.green{text-shadow:0 0 14px rgba(0,255,136,0.6)}
.card:hover .val.red{text-shadow:0 0 14px rgba(255,45,85,0.6)}
/* SECTION */
.section{position:relative;z-index:10;background:var(--card);border:1px solid var(--border2);border-radius:8px;overflow:hidden;backdrop-filter:blur(8px);transition:border-color .2s}
.section:hover{border-color:rgba(0,245,255,0.15)}
.section-head{padding:10px 16px;border-bottom:1px solid var(--border2);font-size:13px;text-transform:uppercase;color:var(--accent);letter-spacing:2px;display:flex;align-items:center;gap:8px;font-family:'Orbitron',monospace;text-shadow:0 0 10px rgba(0,245,255,0.35)}
.section-head span:first-child{flex:1}
.rate-count{font-family:'Orbitron',monospace;font-size:10px;color:var(--accent);background:rgba(0,245,255,0.06);border:1px solid rgba(0,245,255,0.2);padding:1px 10px;border-radius:20px}
/* TABLES */
table{width:100%;border-collapse:collapse}
th{padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:var(--muted);letter-spacing:1px;border-bottom:1px solid var(--border);font-weight:500}
td{padding:9px 10px;border-bottom:1px solid rgba(13,13,46,0.8);transition:background .15s;color:var(--text)}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(0,245,255,0.03)}
.pill{display:inline-block;padding:2px 9px;border-radius:4px;font-size:11px;font-weight:600;letter-spacing:.5px}
.pill.long{background:rgba(0,255,136,0.1);color:var(--green);border:1px solid rgba(0,255,136,0.3)}
.pill.short{background:rgba(255,45,85,0.1);color:var(--red);border:1px solid rgba(255,45,85,0.3)}
.green{color:var(--green)}.red{color:var(--red)}.yellow{color:var(--yellow)}.dim{color:var(--muted)}
tr:hover .green{text-shadow:0 0 8px rgba(0,255,136,0.4)}
tr:hover .red{text-shadow:0 0 8px rgba(255,45,85,0.4)}
/* BUTTONS */
.btn{border:none;border-radius:5px;padding:4px 12px;font-size:11px;cursor:pointer;font-weight:600;transition:all .15s;font-family:'Share Tech Mono',monospace}
.btn-close{background:rgba(255,45,85,0.1);color:var(--red);border:1px solid rgba(255,45,85,0.3)}.btn-close:hover{background:rgba(255,45,85,0.2);box-shadow:0 0 10px rgba(255,45,85,0.2)}
.btn-scan{background:rgba(0,255,136,0.08);color:var(--green);border:1px solid rgba(0,255,136,0.3);padding:6px 16px}.btn-scan:hover{background:rgba(0,255,136,0.15);box-shadow:0 0 14px rgba(0,255,136,0.2)}
.btn-pause{background:rgba(255,214,10,0.08);color:var(--yellow);border:1px solid rgba(255,214,10,0.3);padding:6px 16px}.btn-pause:hover{background:rgba(255,214,10,0.15)}
.btn-cfg{background:rgba(58,58,106,0.3);color:#888;border:1px solid var(--border2);padding:6px 14px}.btn-cfg:hover{background:rgba(58,58,106,0.5)}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;padding:12px 16px}
.empty{text-align:center;padding:28px;color:var(--muted)}
.cfg-panel{padding:14px 16px;border-top:1px solid var(--border);display:none;gap:16px;flex-wrap:wrap}
.cfg-panel.open{display:flex}
.cfg-field{display:flex;flex-direction:column;gap:4px}
.cfg-field label{font-size:10px;text-transform:uppercase;color:var(--muted)}
.cfg-field input,.cfg-field select{background:rgba(4,4,20,0.9);border:1px solid var(--border2);color:var(--text);padding:5px 8px;border-radius:4px;width:90px;font-size:12px;font-family:'Share Tech Mono',monospace}
.btn-save{background:rgba(0,245,255,0.08);color:var(--accent);border:1px solid rgba(0,245,255,0.3);padding:5px 14px;align-self:flex-end}
/* APR BAR */
.apr-wrap{display:inline-flex;align-items:center;gap:7px}
.apr-bar-bg{width:64px;height:7px;background:rgba(255,255,255,0.04);border-radius:3px;overflow:hidden;flex-shrink:0}
.apr-bar{height:100%;border-radius:3px;position:relative;overflow:hidden}
.apr-bar::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent);animation:abar 2.2s ease-in-out infinite}
@keyframes abar{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}
/* PAGINATION */
.pagination{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-top:1px solid var(--border);background:rgba(0,0,0,0.2)}
.page-info{font-size:11px;color:var(--muted)}
.page-info b{color:var(--accent);font-family:'Orbitron',monospace}
.page-btns{display:flex;gap:5px}
.pbtn{background:rgba(4,4,20,0.6);border:1px solid var(--border2);color:var(--muted);padding:3px 11px;border-radius:4px;font-size:11px;cursor:pointer;transition:all .15s}
.pbtn:hover:not(:disabled){border-color:var(--accent);color:var(--accent);box-shadow:0 0 8px rgba(0,245,255,0.1)}
.pbtn:disabled{opacity:.3;cursor:default}
.pbtn.active{background:rgba(0,245,255,0.08);border-color:rgba(0,245,255,0.4);color:var(--accent)}
/* SPACED ROWS */
.spaced-rows tr td{padding:13px 10px}
.spaced-rows tr{border-bottom:1px solid rgba(0,245,255,0.04)}
</style>
</head>
<body>
<canvas id="bgCanvas"></canvas>
<canvas id="pnlStars" style="position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:999"></canvas>
<div class="header">
  <h1>Funding Bot</h1>
  <span class="badge live" id="modeBadge"><span class="live-dot"></span>LIVE</span>
  <span class="badge" id="pauseBadge" style="display:none">PAUSED</span>
  <span class="ts" id="ts">—</span>
</div>
<div class="body">
  <div class="cards">
    <div class="card"><div class="lbl">Equity</div><div class="val" id="equity">—</div></div>
    <div class="card"><div class="lbl">Available</div><div class="val" id="avail">—</div></div>
    <div class="card"><div class="lbl">Positions</div><div class="val" id="openCount">—</div></div>
    <div class="card" id="openPnlCard"><div class="lbl">Open P&amp;L</div><div class="val" id="openPnl">—</div></div>
    <div class="card">
      <div class="lbl">Realised PnL</div>
      <div class="val" id="closedPnl">—</div>
      <div style="display:flex;gap:10px;margin-top:6px;font-size:11px">
        <span style="color:var(--green)">▲ <span id="winCount">0</span>W</span>
        <span style="color:var(--red)">▼ <span id="lossCount">0</span>L</span>
        <span style="color:#7aa8d4"><span id="winRate">—</span> WR</span>
      </div>
    </div>
    <div class="card"><div class="lbl">Total Trades</div><div class="val" id="totalTrades">—</div></div>
    <div class="card"><div class="lbl">Next Settlement</div><div class="val" id="settleCountdown">—</div><div style="font-size:10px;margin-top:4px" id="settleStatus"></div></div>
  </div>

  <!-- PnL Chart -->
  <div class="section">
    <div class="section-head" style="display:flex;align-items:center">
      <span>PnL Since Inception</span>
      <span id="pnlChartTotal" style="font-family:'Orbitron',monospace;font-size:11px;margin-left:8px"></span>
      <span style="margin-left:auto;display:flex;gap:10px;align-items:center">
        <span style="font-size:10px;color:#64748b">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#16a34a;margin-right:4px;vertical-align:middle"></span>Win
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#dc2626;margin:0 4px 0 10px;vertical-align:middle"></span>Loss
        </span>
      </span>
    </div>
    <div style="padding:16px;position:relative;height:300px">
      <canvas id="pnlChart"></canvas>
      <div id="pnlEmpty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:13px;display:none">No closed trades yet — chart will appear after first trade closes</div>
    </div>
  </div>

  <!-- Controls -->
  <div class="section">
    <div class="section-head"><span>Controls</span></div>
    <div class="controls">
      <button class="btn btn-scan" onclick="triggerScan()">⟳ Scan Now</button>
      <button class="btn btn-pause" id="pauseBtn" onclick="togglePause()">⏸ Pause Bot</button>
      <button class="btn btn-cfg" onclick="toggleCfg()">⚙ Config</button>
      <span id="scanStatus" style="color:var(--muted);font-size:11px;margin-left:4px"></span>
    </div>
    <div class="cfg-panel" id="cfgPanel">
      <div class="cfg-field"><label>Min APR %</label><input id="cfgApr" type="number" step="1"></div>
      <div class="cfg-field"><label>Min Hrs to Settle</label><input id="cfgSettle" type="number" step="0.1"></div>
      <div class="cfg-field"><label>Max Hrs to Settle</label><input id="cfgMaxSettle" type="number" step="0.1"></div>
      <div class="cfg-field"><label>Exit After Settle (min)</label><input id="cfgExitSettle" type="number" step="5"></div>
      <div class="cfg-field"><label>Max Volatility %</label><input id="cfgVol" type="number" step="0.5"></div>
      <div class="cfg-field"><label>Trend Filter</label><select id="cfgTrend" style="background:#0a0a0a;border:1px solid #2a2a2a;color:#d4d4d4;padding:5px 8px;border-radius:4px;font-size:12px"><option value="true">On</option><option value="false">Off</option></select></div>
      <div class="cfg-field"><label>Position USD (base)</label><input id="cfgPos" type="number" step="1"></div>
      <div class="cfg-field"><label>Max Position USD</label><input id="cfgMaxPos2" type="number" step="5"></div>
      <div class="cfg-field"><label>Dynamic Sizing</label><select id="cfgDynSize" style="background:#0a0a0a;border:1px solid #2a2a2a;color:#d4d4d4;padding:5px 8px;border-radius:4px;font-size:12px"><option value="true">On</option><option value="false">Off</option></select></div>
      <div class="cfg-field"><label>Stop Loss %</label><input id="cfgSL" type="number" step="0.1"></div>
      <div class="cfg-field"><label>Trailing Stop %</label><input id="cfgTS" type="number" step="0.1"></div>
      <div class="cfg-field"><label>High APR Threshold %</label><input id="cfgHighAprThr" type="number" step="10"></div>
      <div class="cfg-field"><label>Trail % (High APR)</label><input id="cfgTSHigh" type="number" step="0.5"></div>
      <div class="cfg-field"><label>Max Hold Hrs</label><input id="cfgHold" type="number" step="1"></div>
      <div class="cfg-field"><label>Max Positions</label><input id="cfgMaxPos" type="number" step="1"></div>
      <button class="btn btn-save" onclick="saveConfig()">Save</button>
    </div>
  </div>

  <!-- Open Positions -->
  <div class="section">
    <div class="section-head"><span>Open Positions</span><span id="posCount" class="rate-count" style="display:none"></span></div>
    <table>
      <thead><tr><th>Asset</th><th>Side</th><th>Entry</th><th>Mid</th><th>Funding APR</th><th>Held</th><th>Adverse</th><th>P&L</th><th></th></tr></thead>
      <tbody id="posTbody"><tr><td colspan="9" class="empty dim">No open positions</td></tr></tbody>
    </table>
  </div>

  <!-- Funding Rates (paginated) -->
  <div class="section">
    <div class="section-head"><span>Live Funding Rates</span><span id="rateCount" class="rate-count" style="display:none"></span></div>
    <table>
      <thead><tr><th style="width:80px">Asset</th><th style="width:160px">APR</th><th style="width:110px">Direction</th><th style="width:85px">Vol 24h</th><th>Signal</th></tr></thead>
      <tbody id="ratesTbody" class="spaced-rows"><tr><td colspan="5" class="empty dim">Rates load after first scan</td></tr></tbody>
    </table>
    <div class="pagination" id="ratesPager" style="display:none">
      <div class="page-info">Page <b id="pgNum">1</b> of <b id="pgTotal">1</b> · <b id="pgShowing">—</b> entries</div>
      <div class="page-btns" id="pgBtns"></div>
    </div>
  </div>

  <!-- Trade History -->
  <div class="section">
    <div class="section-head"><span>Trade History</span><span id="histCount" class="rate-count" style="display:none"></span></div>
    <table>
      <thead><tr><th>Asset</th><th>Side</th><th>Entry</th><th>Exit</th><th>Funding APR</th><th>Held</th><th>P&L</th><th>Reason</th><th>Closed</th></tr></thead>
      <tbody id="histTbody" class="spaced-rows"><tr><td colspan="9" class="empty dim">No closed trades yet</td></tr></tbody>
    </table>
    <div class="pagination" id="histPager" style="display:none">
      <div class="page-info">Page <b id="hpgNum">1</b> of <b id="hpgTotal">1</b> · <b id="hpgShowing">—</b> entries</div>
      <div class="page-btns" id="hpgBtns"></div>
    </div>
  </div>
</div>

<script>
// ── VIVID PARTICLE BACKGROUND ─────────────────────────────────────────────────
(function(){
  const cv = document.getElementById('bgCanvas')
  const cx = cv.getContext('2d')
  let W, H, pts=[], orbs=[], shooters=[], t=0
  const rsz=()=>{W=cv.width=innerWidth;H=cv.height=innerHeight}
  rsz(); window.addEventListener('resize',rsz)
  const OCOLS=[[0,245,255],[124,58,237],[0,255,136],[255,45,85],[255,214,10],[124,58,237]]
  for(let i=0;i<8;i++) orbs.push({x:Math.random()*1400,y:Math.random()*900,r:200+Math.random()*280,vx:(Math.random()-.5)*.18,vy:(Math.random()-.5)*.14,c:OCOLS[i%OCOLS.length],ph:Math.random()*Math.PI*2,sp:0.0004+Math.random()*0.0003})
  const PCOLS=['0,245,255','124,58,237','0,255,136','255,45,85','255,214,10','200,214,255']
  const mkP=()=>({x:Math.random()*W,y:Math.random()*H,r:Math.random()*1.8+.4,vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,a:Math.random()*.7+.2,c:PCOLS[Math.floor(Math.random()*PCOLS.length)],tw:Math.random()*Math.PI*2,ts:.02+Math.random()*.03})
  for(let i=0;i<180;i++) pts.push(mkP())
  const mkS=()=>({x:-50,y:Math.random()*H*.6,vx:6+Math.random()*4,vy:1+Math.random()*2,life:1,tail:[]})
  setInterval(()=>{if(shooters.length<3)shooters.push(mkS())},3000)
  ;(function draw(ts=0){
    t=ts*.001
    cx.fillStyle='rgba(2,2,9,0.2)'; cx.fillRect(0,0,W,H)
    orbs.forEach(o=>{
      o.x+=o.vx; o.y+=o.vy
      if(o.x<-o.r)o.x=W+o.r; if(o.x>W+o.r)o.x=-o.r; if(o.y<-o.r)o.y=H+o.r; if(o.y>H+o.r)o.y=-o.r
      const p=.08+Math.sin(t*o.sp*1000+o.ph)*.05
      const g=cx.createRadialGradient(o.x,o.y,0,o.x,o.y,o.r)
      g.addColorStop(0,\`rgba(\${o.c},\${p})\`); g.addColorStop(.5,\`rgba(\${o.c},\${p*.3})\`); g.addColorStop(1,\`rgba(\${o.c},0)\`)
      cx.fillStyle=g; cx.beginPath(); cx.arc(o.x,o.y,o.r,0,Math.PI*2); cx.fill()
    })
    cx.strokeStyle='rgba(0,245,255,0.03)'; cx.lineWidth=.5
    for(let x=0;x<W;x+=80){cx.beginPath();cx.moveTo(x,0);cx.lineTo(x,H);cx.stroke()}
    for(let y=0;y<H;y+=80){cx.beginPath();cx.moveTo(0,y);cx.lineTo(W,y);cx.stroke()}
    pts.forEach(p=>{
      p.x+=p.vx; p.y+=p.vy
      if(p.x<0)p.x=W; if(p.x>W)p.x=0; if(p.y<0)p.y=H; if(p.y>H)p.y=0
      p.tw+=p.ts; const a=p.a*(.6+.4*Math.sin(p.tw))
      cx.beginPath(); cx.arc(p.x,p.y,p.r,0,Math.PI*2); cx.fillStyle=\`rgba(\${p.c},\${a})\`; cx.fill()
      cx.beginPath();cx.arc(p.x,p.y,p.r*4,0,Math.PI*2);cx.fillStyle=\`rgba(\${p.c},\${a*.18})\`;cx.fill()
      if(p.a>.3){cx.beginPath();cx.arc(p.x,p.y,p.r*9,0,Math.PI*2);cx.fillStyle=\`rgba(\${p.c},\${a*.06})\`;cx.fill()}
    })
    for(let i=0;i<pts.length;i++) for(let j=i+1;j<pts.length;j++){
      const dx=pts[i].x-pts[j].x,dy=pts[i].y-pts[j].y,d=Math.sqrt(dx*dx+dy*dy)
      if(d<90){cx.beginPath();cx.strokeStyle=\`rgba(0,245,255,\${.1*(1-d/90)})\`;cx.lineWidth=.5;cx.moveTo(pts[i].x,pts[i].y);cx.lineTo(pts[j].x,pts[j].y);cx.stroke()}
    }
    shooters=shooters.filter(s=>s.x<W+100)
    shooters.forEach(s=>{
      s.tail.push({x:s.x,y:s.y}); if(s.tail.length>18)s.tail.shift()
      s.x+=s.vx; s.y+=s.vy; s.life-=.012
      s.tail.forEach((pt,i)=>{const a=(i/s.tail.length)*.65*s.life;cx.beginPath();cx.arc(pt.x,pt.y,.8,0,Math.PI*2);cx.fillStyle=\`rgba(255,255,255,\${a})\`;cx.fill()})
      cx.beginPath();cx.arc(s.x,s.y,1.5,0,Math.PI*2);cx.fillStyle=\`rgba(255,255,255,\${s.life})\`;cx.fill()
    })
    requestAnimationFrame(draw)
  })()
  // 3D tilt on cards
  document.querySelectorAll('.card').forEach(c=>{
    c.addEventListener('mousemove',e=>{const r=c.getBoundingClientRect(),dx=(e.clientX-r.left-r.width/2)/(r.width/2),dy=(e.clientY-r.top-r.height/2)/(r.height/2);c.style.transform=\`perspective(400px) rotateY(\${dx*5}deg) rotateX(\${-dy*4}deg) translateZ(4px)\`})
    c.addEventListener('mouseleave',()=>{c.style.transform=''})
  })
})()

// ── PNL STAR PARTICLES ────────────────────────────────────────────────────────
;(function(){
  const cv=document.getElementById('pnlStars')
  const card=document.getElementById('openPnlCard')
  if(!cv||!card)return
  const cx=cv.getContext('2d')
  let stars=[],_pnl=0
  const rsz=()=>{cv.width=innerWidth;cv.height=innerHeight}
  rsz();window.addEventListener('resize',rsz)

  function drawStar(x,y,r,rot){
    cx.beginPath()
    for(let i=0;i<5;i++){
      const a=rot+i*4*Math.PI/5-Math.PI/2,ia=rot+(i*4+2)*Math.PI/5-Math.PI/2
      i===0?cx.moveTo(x+r*Math.cos(a),y+r*Math.sin(a)):cx.lineTo(x+r*Math.cos(a),y+r*Math.sin(a))
      cx.lineTo(x+r*.4*Math.cos(ia),y+r*.4*Math.sin(ia))
    }
    cx.closePath()
  }

  function spawn(){
    if(!_pnl)return
    const rc=card.getBoundingClientRect()
    const intensity=Math.min(Math.abs(_pnl)/2,5)   // scale 0–5
    const up=_pnl>0,col=up?'0,255,136':'255,45,85'
    const spd=1.5+intensity*.8
    const n=Math.ceil(1+intensity*.6)
    for(let i=0;i<n;i++){
      const x=rc.left+rc.width*.05+Math.random()*rc.width*.9
      const y=up?rc.bottom-Math.random()*rc.height*.4:rc.top+Math.random()*rc.height*.4
      stars.push({
        x,y,
        vx:(Math.random()-.5)*1.4,
        vy:up?-(spd+Math.random()*spd*.6):(spd+Math.random()*spd*.6),
        a:0.9+Math.random()*.1,
        r:4+Math.random()*(3+intensity*.4),
        col,rot:Math.random()*Math.PI*2,rs:(Math.random()-.5)*.12,
        rc        // store card rect at spawn time
      })
    }
  }

  setInterval(()=>{if(_pnl!==0)spawn()},320)

  ;(function loop(){
    cx.clearRect(0,0,cv.width,cv.height)
    const rc=card.getBoundingClientRect()
    stars=stars.filter(s=>s.a>.02)
    stars.forEach(s=>{
      s.x+=s.vx;s.y+=s.vy;s.rot+=s.rs
      // fade faster the further outside the card boundary
      const outsideY=_pnl>0?Math.max(0,rc.top-s.y):Math.max(0,s.y-rc.bottom)
      const outsideX=Math.max(0,rc.left-s.x,s.x-rc.right)
      const outside=Math.max(outsideY,outsideX)
      s.a-=0.008+outside*0.003
      cx.save();cx.globalAlpha=Math.max(0,s.a)
      cx.shadowColor=\`rgba(\${s.col},0.95)\`;cx.shadowBlur=12
      cx.fillStyle=\`rgba(\${s.col},1)\`
      drawStar(s.x,s.y,s.r,s.rot);cx.fill()
      cx.restore()
    })
    requestAnimationFrame(loop)
  })()

  window._pnlStarsUpdate=v=>{_pnl=v}
})()

// ── PAGINATION STATE ──────────────────────────────────────────────────────────
const PAGE_SIZE = 25
let _allRates = [], _page = 1
let _allHist = [], _hpage = 1
function renderRatesPage(rates, page) {
  _allRates = rates; _page = page
  const total = Math.ceil(rates.length / PAGE_SIZE)
  const start = (page-1)*PAGE_SIZE, slice = rates.slice(start, start+PAGE_SIZE)
  const rtb = document.getElementById('ratesTbody')
  rtb.innerHTML = slice.map(r => {
    const absApr=Math.abs(r.apr), barW=Math.min(absApr*1.5,64)
    const color=absApr>=cfg.minFundingApr?(r.apr<0?'#22c55e':'#ef4444'):'#333'
    const signal=absApr>=cfg.minFundingApr?(r.apr<0?'<span class="green">▲ LONG</span>':'<span class="red">▼ SHORT</span>'):'<span class="dim">—</span>'
    const vol=r.volume24h>=1e6?'\$'+(r.volume24h/1e6).toFixed(1)+'M':'\$'+(r.volume24h/1e3).toFixed(0)+'K'
    const aprStr=(r.apr>=0?'+':'')+r.apr.toFixed(1)+'%'
    const dir=r.apr<0?'Longs paid':'Shorts paid'
    return '<tr><td><b>'+r.asset+'</b></td>'+
      '<td><div class="apr-wrap"><div class="apr-bar-bg"><div class="apr-bar" style="width:'+barW+'px;background:'+color+';box-shadow:0 0 5px '+color+'80"></div></div>'+
      '<span class="'+(r.apr<0?'green':r.apr>0?'red':'')+'" style="font-size:11px">'+aprStr+'</span></div></td>'+
      '<td class="'+(r.apr<0?'green':'red')+'" style="font-size:11px">'+dir+'</td>'+
      '<td class="dim" style="font-size:11px">'+vol+'</td>'+
      '<td>'+signal+'</td></tr>'
  }).join('')
  // Update pager
  const pager = document.getElementById('ratesPager')
  pager.style.display = rates.length > PAGE_SIZE ? 'flex' : 'none'
  document.getElementById('pgNum').textContent = page
  document.getElementById('pgTotal').textContent = total
  document.getElementById('pgShowing').textContent = (start+1)+'–'+Math.min(start+PAGE_SIZE,rates.length)
  const btns = document.getElementById('pgBtns')
  btns.innerHTML = ''
  const addBtn=(label,pg,disabled,active)=>{const b=document.createElement('button');b.className='pbtn'+(active?' active':'');b.textContent=label;b.disabled=disabled;b.onclick=()=>renderRatesPage(_allRates,pg);btns.appendChild(b)}
  addBtn('‹',page-1,page===1,false)
  for(let p=1;p<=total;p++) addBtn(p,p,false,p===page)
  addBtn('›',page+1,page===total,false)
}

function renderHistPage(hist, page) {
  _allHist = hist; _hpage = page
  const total = Math.ceil(hist.length / PAGE_SIZE)
  const start = (page-1)*PAGE_SIZE, slice = hist.slice(start, start+PAGE_SIZE)
  const htb = document.getElementById('histTbody')
  htb.innerHTML = slice.map(t => {
    const held = t.closedAt && t.openedAt ? fmt((t.closedAt - t.openedAt)/3600000, 1) + 'h' : '—'
    const apr  = (t.fundingAPR >= 0 ? '+' : '') + fmt(t.fundingAPR) + '%'
    return '<tr><td><b>' + t.asset + '</b></td>' +
      '<td><span class="pill ' + t.side.toLowerCase() + '">' + t.side + '</span></td>' +
      '<td>' + fmt(t.entryPrice, 4) + '</td>' +
      '<td>' + fmt(t.exitPrice, 4) + '</td>' +
      '<td>' + apr + '</td>' +
      '<td>' + held + '</td>' +
      '<td class="' + pnlClass(t.pnlUsd) + '">' + fmtUsd(t.pnlUsd) + '</td>' +
      '<td class="dim">' + (t.reason||'—') + '</td>' +
      '<td class="dim">' + fmtDate(t.closedAt) + '</td></tr>'
  }).join('')
  const pager = document.getElementById('histPager')
  pager.style.display = hist.length > PAGE_SIZE ? 'flex' : 'none'
  document.getElementById('hpgNum').textContent = page
  document.getElementById('hpgTotal').textContent = total
  document.getElementById('hpgShowing').textContent = (start+1)+'–'+Math.min(start+PAGE_SIZE,hist.length)
  const btns = document.getElementById('hpgBtns')
  btns.innerHTML = ''
  const addBtn=(label,pg,disabled,active)=>{const b=document.createElement('button');b.className='pbtn'+(active?' active':'');b.textContent=label;b.disabled=disabled;b.onclick=()=>renderHistPage(_allHist,pg);btns.appendChild(b)}
  addBtn('‹',page-1,page===1,false)
  for(let p=1;p<=total;p++) addBtn(p,p,false,p===page)
  addBtn('›',page+1,page===total,false)
}

// ── PNL CHART ─────────────────────────────────────────────────────────────────
let _pnlChart = null

function buildPnlChart(history) {
  const sorted = [...history].filter(t => t.closedAt && t.pnlUsd != null).sort((a,b) => a.closedAt - b.closedAt)
  const emptyEl = document.getElementById('pnlEmpty')
  const canvasEl = document.getElementById('pnlChart')
  if (!sorted.length) {
    emptyEl.style.display = 'flex'; canvasEl.style.display = 'none'
    return
  }
  emptyEl.style.display = 'none'; canvasEl.style.display = 'block'

  // Build cumulative points starting at 0
  let cum = 0
  const lineData = [{x: new Date(sorted[0].closedAt - 1), y: 0}]
  const winPts = [], lossPts = []
  sorted.forEach(t => {
    cum += t.pnlUsd
    const pt = {x: new Date(t.closedAt), y: parseFloat(cum.toFixed(5)), trade: t}
    lineData.push(pt)
    ;(t.pnlUsd >= 0 ? winPts : lossPts).push(pt)
  })

  // Update header total
  const tot = document.getElementById('pnlChartTotal')
  tot.textContent = (cum >= 0 ? '+' : '') + '\$' + cum.toFixed(4)
  tot.style.color = cum >= 0 ? '#16a34a' : '#dc2626'

  const ctx = canvasEl.getContext('2d')

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, 260)
  if (cum >= 0) {
    grad.addColorStop(0, 'rgba(22,163,74,0.22)')
    grad.addColorStop(1, 'rgba(22,163,74,0.01)')
  } else {
    grad.addColorStop(0, 'rgba(220,38,38,0.22)')
    grad.addColorStop(1, 'rgba(220,38,38,0.01)')
  }

  if (_pnlChart) { _pnlChart.destroy(); _pnlChart = null }

  _pnlChart = new Chart(ctx, {
    data: {
      datasets: [
        {
          type: 'line',
          label: 'Equity',
          data: lineData,
          borderColor: cum >= 0 ? '#16a34a' : '#dc2626',
          backgroundColor: grad,
          tension: 0.35,
          fill: true,
          pointRadius: 0,
          pointHoverRadius: 0,
          borderWidth: 2.5,
          order: 3
        },
        {
          type: 'scatter',
          label: 'Win',
          data: winPts,
          backgroundColor: 'rgba(22,163,74,0.9)',
          borderColor: '#fff',
          borderWidth: 1.5,
          pointRadius: 5,
          pointHoverRadius: 8,
          order: 1
        },
        {
          type: 'scatter',
          label: 'Loss',
          data: lossPts,
          backgroundColor: 'rgba(220,38,38,0.9)',
          borderColor: '#fff',
          borderWidth: 1.5,
          pointRadius: 5,
          pointHoverRadius: 8,
          order: 2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false, axis: 'x' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(255,255,255,0.95)',
          titleColor: '#0f172a',
          bodyColor: '#334155',
          borderColor: 'rgba(0,0,0,0.08)',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            title(items) {
              const d = items[0].dataset.data[items[0].dataIndex]
              if (d.trade) return d.trade.asset + ' · ' + d.trade.side
              return 'Start'
            },
            label(item) {
              const d = item.dataset.data[item.dataIndex]
              if (!d.trade) return 'PnL: $0.00'
              const t = d.trade
              const sign = t.pnlUsd >= 0 ? '+' : ''
              return [
                'Trade PnL: ' + sign + '\$' + t.pnlUsd.toFixed(4),
                'Running Total: \$' + item.parsed.y.toFixed(4),
                'APR: ' + (t.fundingAPR >= 0 ? '+' : '') + (t.fundingAPR||0).toFixed(1) + '%',
                'Exit: ' + (t.reason || '—'),
                new Date(t.closedAt).toLocaleString()
              ]
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'MMM d HH:mm', displayFormats: { hour: 'MMM d HH:mm', day: 'MMM d', minute: 'HH:mm' } },
          grid: { color: 'rgba(0,0,0,0.05)', drawBorder: false },
          ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 8 }
        },
        y: {
          grid: { color: 'rgba(0,0,0,0.05)', drawBorder: false },
          ticks: { color: '#64748b', font: { size: 10 }, callback: v => '\$' + v.toFixed(3) },
          afterDataLimits(scale) {
            const pad = Math.abs(scale.max - scale.min) * 0.1 || 0.01
            scale.max += pad; scale.min -= pad
          }
        }
      }
    }
  })
}

// ── DATA REFRESH ──────────────────────────────────────────────────────────────
let cfg = {}
let nextSettleMs = null

function fmt(n, d=2) { return n != null ? n.toFixed(d) : '—' }
function fmtUsd(n)   { return n != null ? (n>=0?'+':'')+'\$'+Math.abs(n).toFixed(3) : '—' }
function fmtDate(ts) { return ts ? new Date(ts).toLocaleString() : '—' }
function pnlClass(n) { return n>0?'green':n<0?'red':'' }

async function refresh() {
  try {
    const d = await fetch('/api/status').then(r=>r.json())
    cfg = d.cfg

    document.getElementById('ts').textContent = 'Updated ' + new Date(d.ts).toLocaleTimeString()
    const mb = document.getElementById('modeBadge')
    mb.innerHTML = (d.mode==='LIVE'?'<span class="live-dot"></span>':'')+d.mode
    mb.className = 'badge ' + (d.mode==='LIVE'?'live':'dry')
    document.getElementById('pauseBadge').style.display = d.paused ? 'inline-block' : 'none'
    document.getElementById('pauseBtn').textContent = d.paused ? '▶ Resume Bot' : '⏸ Pause Bot'
    document.getElementById('scanStatus').textContent = d.scanning ? '⟳ Scanning…' : ''

    document.getElementById('equity').textContent = '\$' + fmt(d.equity)
    document.getElementById('avail').textContent  = '\$' + fmt(d.avail)
    document.getElementById('openCount').textContent = d.openCount + '/' + d.cfg.maxPositions

    const openPnl = d.positions.reduce((s,p) => s + (p.pnlUsd||0), 0)
    const el = document.getElementById('openPnl')
    el.textContent = fmtUsd(openPnl); el.className = 'val ' + pnlClass(openPnl)
    if(window._pnlStarsUpdate) window._pnlStarsUpdate(openPnl)

    const closedPnl = d.totalClosedPnl ?? d.history.reduce((s,t) => s + (t.pnlUsd||0), 0)
    const cel = document.getElementById('closedPnl')
    cel.textContent = fmtUsd(closedPnl); cel.className = 'val ' + pnlClass(closedPnl)
    const wins   = d.totalWins   ?? d.history.filter(t=>(t.pnlUsd||0)>0).length
    const losses = d.totalLosses ?? d.history.filter(t=>(t.pnlUsd||0)<0).length
    document.getElementById('winCount').textContent = wins
    document.getElementById('lossCount').textContent = losses
    const wDenom = wins + losses
    document.getElementById('winRate').textContent = wDenom ? Math.round(wins/wDenom*100)+'%' : '—'

    document.getElementById('totalTrades').textContent = d.totalTrades ?? d.history.length

    nextSettleMs = Date.now() + d.hoursToSettle * 3600000
    const canEnter = d.hoursToSettle >= d.cfg.minHoursToSettle
    const sEl = document.getElementById('settleStatus')
    sEl.textContent = canEnter ? '✓ Entries allowed' : '✗ Too close to settle'
    sEl.style.color  = canEnter ? '#22c55e' : '#eab308'

    document.getElementById('cfgApr').value     = d.cfg.minFundingApr
    document.getElementById('cfgSettle').value      = d.cfg.minHoursToSettle
    document.getElementById('cfgMaxSettle').value   = d.cfg.maxHoursToSettle ?? 1.0
    document.getElementById('cfgExitSettle').value  = d.cfg.exitAfterSettleMins ?? 15
    document.getElementById('cfgVol').value     = d.cfg.maxVolatilityPct
    document.getElementById('cfgTrend').value   = d.cfg.trendFilter ? 'true' : 'false'
    document.getElementById('cfgPos').value         = d.cfg.positionUsd
    document.getElementById('cfgMaxPos2').value     = d.cfg.maxPositionUsd ?? 60
    document.getElementById('cfgDynSize').value     = d.cfg.dynamicSizing ? 'true' : 'false'
    document.getElementById('cfgSL').value     = d.cfg.stopLossPct
    document.getElementById('cfgTS').value         = d.cfg.trailingStopPct
    document.getElementById('cfgHighAprThr').value  = d.cfg.highAprThreshold ?? 300
    document.getElementById('cfgTSHigh').value      = d.cfg.trailingStopHighApr ?? 5
    document.getElementById('cfgHold').value        = d.cfg.maxHoldHours
    document.getElementById('cfgMaxPos').value = d.cfg.maxPositions

    // Positions
    const ptb = document.getElementById('posTbody')
    const pc = document.getElementById('posCount')
    pc.textContent = d.positions.length ? d.positions.length + ' open' : ''
    pc.style.display = d.positions.length ? 'inline-block' : 'none'
    if (!d.positions.length) {
      ptb.innerHTML = '<tr><td colspan="9" class="empty dim">No open positions — bot scanning every ' + Math.round(d.cfg.scanIntervalMs/60000) + ' min</td></tr>'
    } else {
      ptb.innerHTML = d.positions.map(p => {
        const adv = p.adversePct != null ? fmt(p.adversePct) + '%' : '—'
        const advC = p.adversePct > 1 ? 'red' : p.adversePct > 0.5 ? 'yellow' : 'green'
        const held = fmt(p.heldHours, 1) + 'h'
        const apr  = (p.fundingAPR >= 0 ? '+' : '') + fmt(p.fundingAPR) + '%'
        return '<tr><td><b>' + p.asset + '</b></td>' +
          '<td><span class="pill ' + p.side.toLowerCase() + '">' + p.side + '</span></td>' +
          '<td>' + fmt(p.entryPrice, 4) + '</td>' +
          '<td>' + fmt(p.midPrice, 4) + '</td>' +
          '<td class="' + (p.fundingAPR < 0 ? 'green' : 'red') + '">' + apr + '</td>' +
          '<td>' + held + '</td>' +
          '<td class="' + advC + '">' + adv + '</td>' +
          '<td class="' + pnlClass(p.pnlUsd) + '">' + fmtUsd(p.pnlUsd) + '</td>' +
          '<td><button class="btn btn-close" data-asset="' + p.asset + '">Close</button></td></tr>'
      }).join('')
    }

    // Rates (paginated)
    const rc = document.getElementById('rateCount')
    rc.textContent = d.rates.length ? d.rates.length + ' assets' : ''
    rc.style.display = d.rates.length ? 'inline-block' : 'none'
    if (!d.rates.length) {
      document.getElementById('ratesTbody').innerHTML = '<tr><td colspan="5" class="empty dim">Rates load after first scan</td></tr>'
      document.getElementById('ratesPager').style.display = 'none'
    } else {
      renderRatesPage(d.rates, 1)
    }

    // PnL Chart
    buildPnlChart(d.history)

    // History (paginated)
    const hc = document.getElementById('histCount')
    const totalH = d.totalTrades ?? d.history.length
    hc.textContent = totalH ? totalH + ' trades' : ''
    hc.style.display = totalH ? 'inline-block' : 'none'
    if (!d.history.length) {
      document.getElementById('histTbody').innerHTML = '<tr><td colspan="9" class="empty dim">No closed trades yet</td></tr>'
      document.getElementById('histPager').style.display = 'none'
    } else {
      renderHistPage(d.history, _hpage)
    }
  } catch(e) {
    document.getElementById('ts').textContent = 'Error: ' + e.message
  }
}

document.addEventListener('click', async function(e) {
  const btn = e.target.closest('[data-asset]')
  if (!btn) return
  const asset = btn.dataset.asset
  if (!confirm('Close ' + asset + ' position now?')) return
  const r = await fetch('/api/close/' + asset, { method: 'POST' }).then(x=>x.json())
  if (r.error) alert('Error: ' + r.error)
  else refresh()
})

async function triggerScan() {
  document.getElementById('scanStatus').textContent = '⟳ Triggering scan…'
  await fetch('/api/scan', { method: 'POST' })
  refresh()
}

async function togglePause() {
  await fetch('/api/pause', { method: 'POST' })
  refresh()
}

function toggleCfg() {
  document.getElementById('cfgPanel').classList.toggle('open')
}

async function saveConfig() {
  const body = {
    minFundingApr:        parseFloat(document.getElementById('cfgApr').value),
    minHoursToSettle:     parseFloat(document.getElementById('cfgSettle').value),
    maxHoursToSettle:     parseFloat(document.getElementById('cfgMaxSettle').value),
    exitAfterSettleMins:  parseFloat(document.getElementById('cfgExitSettle').value),
    maxVolatilityPct:   parseFloat(document.getElementById('cfgVol').value),
    trendFilter:        document.getElementById('cfgTrend').value === 'true',
    positionUsd:      parseFloat(document.getElementById('cfgPos').value),
    maxPositionUsd:   parseFloat(document.getElementById('cfgMaxPos2').value),
    dynamicSizing:    document.getElementById('cfgDynSize').value === 'true',
    stopLossPct:     parseFloat(document.getElementById('cfgSL').value),
    trailingStopPct:        parseFloat(document.getElementById('cfgTS').value),
    highAprThreshold:       parseFloat(document.getElementById('cfgHighAprThr').value),
    trailingStopHighApr:    parseFloat(document.getElementById('cfgTSHigh').value),
    maxHoldHours:           parseFloat(document.getElementById('cfgHold').value),
    maxPositions:    parseInt(document.getElementById('cfgMaxPos').value),
  }
  await fetch('/api/config', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
  document.getElementById('cfgPanel').classList.remove('open')
  refresh()
}

setInterval(() => {
  if (!nextSettleMs) return
  const ms=Math.max(0,nextSettleMs-Date.now())
  const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000)
  const str=h>0?h+'h '+String(m).padStart(2,'0')+'m':String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s'
  const el=document.getElementById('settleCountdown'); if(el)el.textContent=str
}, 1000)

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
    res.writeHead(200, { 'Content-Type': 'text/html' })
    try {
      const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
      const m = src.match(/const HTML = `([\s\S]*?)`\n\/\/ ── HTTP/)
      return res.end(m ? m[1] : HTML)
    } catch { return res.end(HTML) }
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

await scan()
scheduleScan()
