// src/paper.js – simulierte Trades. KEIN echtes Geld. Entry beim Signal,
// Exit bei Take-Profit / Stop-Loss / Zeitlimit. Ergebnisse -> Netlify Blobs.
const cfg = require("./config");
const storage = require("./storage");

const open = new Map();   // id -> Position
let closedBuffer = [];

const stats = { signals: 0, opened: 0, closed: 0, wins: 0, losses: 0, sumPnlPct: 0 };

function canOpen() { return open.size < cfg.MAX_OPEN_POSITIONS; }

function openPosition(p) {
  // p: { id, symbol, source, network, entryPrice, priceUnit, link }
  if (open.has(p.id) || !canOpen() || !p.entryPrice) return null;
  const pos = { ...p, openedAt: Date.now(), high: p.entryPrice, lastPrice: p.entryPrice, tradeCount: 0, sizeUsd: cfg.POSITION_USD };
  open.set(p.id, pos);
  stats.opened++;
  console.log(`[PAPER OPEN] ${p.symbol} (${p.source}) @ ${p.entryPrice} ${p.priceUnit}`);
  return pos;
}

function updatePrice(id, price, onClose) {
  const p = open.get(id);
  if (!p || !price) return;
  p.lastPrice = price; p.tradeCount++;
  if (price > p.high) p.high = price;
  const pnl = (price - p.entryPrice) / p.entryPrice * 100;
  const ageMin = (Date.now() - p.openedAt) / 60e3;
  let reason = null;
  if (pnl >= cfg.TAKE_PROFIT_PCT) reason = "take-profit";
  else if (pnl <= cfg.STOP_LOSS_PCT) reason = "stop-loss";
  else if (ageMin >= cfg.TIME_LIMIT_MIN) reason = "zeitlimit";
  if (reason) closePosition(id, price, reason, onClose);
}

function closePosition(id, exitPrice, reason, onClose) {
  const p = open.get(id);
  if (!p) return;
  open.delete(id);
  const pnlPct = (exitPrice - p.entryPrice) / p.entryPrice * 100;
  const trade = {
    symbol: p.symbol, source: p.source, network: p.network || "solana",
    entry: p.entryPrice, exit: exitPrice, unit: p.priceUnit,
    pnlPct: +pnlPct.toFixed(1), pnlUsd: +(cfg.POSITION_USD * pnlPct / 100).toFixed(2),
    reason, openedAt: new Date(p.openedAt).toISOString(), closedAt: new Date().toISOString(),
    holdMin: +((Date.now() - p.openedAt) / 60e3).toFixed(1), link: p.link || null
  };
  stats.closed++; stats.sumPnlPct += pnlPct;
  if (pnlPct > 0) stats.wins++; else stats.losses++;
  closedBuffer.push(trade);
  console.log(`[PAPER CLOSE] ${trade.symbol} ${trade.pnlPct}% (${reason}) nach ${trade.holdMin} Min`);
  onClose?.(trade);
}

// Sweep: Zeitlimit-Kontrolle unabhängig von Preis-Updates (tote Tokens!)
let sweepClose = null; // wird von index.js gesetzt (für Benachrichtigung)
function onSweepClose(fn) { sweepClose = fn; }
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of open) {
    if ((now - p.openedAt) / 60e3 < cfg.TIME_LIMIT_MIN) continue;
    if (p.tradeCount === 0) {
      // kein einziger Käufer nach Entry -> real nicht verkäuflich, Kurssturz beim Exit
      closePosition(id, p.entryPrice * 0.1, "illiquide (keine Käufer)", sweepClose);
    } else {
      closePosition(id, p.lastPrice, "zeitlimit", sweepClose);
    }
  }
}, 15e3);

// Persistenz: alle 2 Min gesammelte Trades in ./data/trades.json schreiben
async function flush() {
  if (!closedBuffer.length) return;
  const buf = closedBuffer; closedBuffer = [];
  const prev = storage.load();
  prev.trades = [...(prev.trades || []), ...buf].slice(-500);
  prev.updated = new Date().toISOString();
  storage.save(prev);
}
setInterval(() => flush().catch(e => console.error("flush", e.message)), 120e3);

function summary() {
  return {
    ...stats,
    openNow: open.size,
    winRate: stats.closed ? +(stats.wins / stats.closed * 100).toFixed(1) : null,
    avgPnlPct: stats.closed ? +(stats.sumPnlPct / stats.closed).toFixed(1) : null,
    openPositions: [...open.values()].map(p => ({
      symbol: p.symbol, source: p.source,
      pnlNow: p.lastPrice ? +(((p.lastPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(1) : 0,
      trades: p.tradeCount,
      ageMin: +((Date.now() - p.openedAt) / 60e3).toFixed(1)
    }))
  };
}

module.exports = { openPosition, updatePrice, closePosition, canOpen, summary, stats, open, flush, onSweepClose };
