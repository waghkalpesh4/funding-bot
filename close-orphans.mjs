// One-off: close orphaned MANTA + OP positions on the funding-bot wallet.
// Works around @b402ai/trader formatPrice bug (ignores 6 - szDecimals rule).
import { readFileSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { homedir } from 'os'

const PKG_DIST = 'C:/Users/waghk/AppData/Roaming/npm/node_modules/@b402ai/trader/dist'
const u = p => pathToFileURL(p).href

const privateKey = JSON.parse(readFileSync(join(homedir(), '.b402', 'wallet.json'), 'utf8')).privateKey
const ethers = await import('ethers')
const { HyperliquidClient } = await import(u(join(PKG_DIST, 'hyperliquid/client.js')))
const { spawnAgent } = await import(u(join(PKG_DIST, 'identity/derivation.js')))

const identity = await spawnAgent(new ethers.Wallet(privateKey), 'hero')
console.log('wallet:', identity.hl.address)
const hl = new HyperliquidClient(identity.hl.privateKey)
await hl.ensureMeta()

// HL perp price rule: <=5 significant figures AND <=(6 - szDecimals) decimals
function fmtPx(price, szDec) {
  const maxDec = 6 - szDec
  const p = Number(price.toPrecision(5))
  const s = p.toFixed(maxDec)
  return String(Number(s)) // strip trailing zeros
}

const state = await hl.getAccountState()
for (const pos of state.positions) {
  if (!['MANTA', 'OP'].includes(pos.asset)) continue
  const mid = await hl.getMidPrice(pos.asset)
  const szDec = hl.getSzDecimals(pos.asset)
  const isCloseBuy = pos.side === 'short'
  const raw = isCloseBuy ? mid * 1.10 : mid * 0.90
  const limitPx = fmtPx(raw, szDec)
  console.log(`${pos.asset}: side=${pos.side} size=${pos.size} mid=${mid} szDec=${szDec} limitPx=${limitPx}`)
  const res = await hl.placeOrder({
    asset: pos.asset,
    isBuy: isCloseBuy,
    limitPx,
    sz: pos.size,
    reduceOnly: true,
    orderType: { limit: { tif: 'Ioc' } },
  })
  console.log(pos.asset, 'close result:', JSON.stringify(res))
}

const after = await hl.getAccountState()
console.log('remaining positions:', JSON.stringify(after.positions))
console.log('equity:', after.equity)
