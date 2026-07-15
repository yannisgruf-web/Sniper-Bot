// src/index.js – Orchestrator v3
// Neu: Beobachtungsfenster vor dem Einstieg (Bundle-/Wash-/Dominanz-Erkennung),
// Insider-Konzentrations-Check 60s nach Entry, Wash-Überwachung während der
// Position, selbstlernende Deployer-Blacklist.
const http = require("http");
const cfg = require("./config");
const { startPumpListener } = require("./pump-listener");
const { startGeckoListener } = require("./gecko-listener");
const { checkPump, checkEvm } = require("./safety");
const { holderConcentration } = require("./onchain");
const blacklist = require("./blacklist");
const paper = require("./paper");
const { notify } = require("./telegram");
const { solUsd } = require("./sol-price");

const boot = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pumpStatus = "startet…";

// Zusätzliche Prüf-Statistik (im Stats-JSON sichtbar)
const checks = {
  abgelehnt_bundle: 0, abgelehnt_wash: 0, abgelehnt_dominanz: 0,
  gesperrt_creator: 0, abgelehnt_devbuy: 0, abgelehnt_relaunch: 0,
  exit_wash: 0, exit_insider: 0,
  entries_pump: 0, entries_gecko: 0,
  // Diagnose pump.fun-Trichter:
  pump_beobachtung_gestartet: 0, pump_trade_events: 0,
  pump_zu_wenig_kaeufer: 0, pump_slots_voll: 0
};

// Relaunch-Erkennung: gleiches Symbol mehrfach in kurzer Zeit = Copycat-Scam
const symbolSeen = new Map(); // SYMBOL -> [ts,...]
function isRelaunch(sym) {
  const key = (sym || "").toUpperCase().trim();
  if (!key || key === "?") return false;
  const cut = Date.now() - 6 * 3600e3;
  const arr = (symbolSeen.get(key) || []).filter(t => t > cut);
  arr.push(Date.now());
  symbolSeen.set(key, arr);
  return arr.length >= 2; // schon mal gesehen in 6h -> Relaunch
}

// Beobachtungsfenster: erst schauen, dann einsteigen
const OBS_TRADES = 6;      // Entscheidung nach 6 Trades …
const OBS_MS = 8000;       // … oder spätestens 8s nach dem ersten Trade
const pending = new Map(); // mint -> { symbol, link, creator, curve, ts, firstTradeTs, trades: [] }
const meta = new Map();    // mint (offene Position) -> { creator, curve, buyers:Set, buys:0 }

function tradeExitMsg(trade) {
  return `${trade.pnlPct >= 0 ? "✅" : "❌"} <b>Paper ${trade.pnlPct >= 0 ? "+" : ""}${trade.pnlPct}%: ${trade.symbol}</b>\n${trade.reason} nach ${trade.holdMin} Min · fiktiv ${trade.pnlUsd >= 0 ? "+" : ""}$${trade.pnlUsd}${trade.link ? "\n" + trade.link : ""}`;
}
function onPumpClose(mint) {
  return trade => {
    pump.unsubscribeTrades(mint);
    const m = meta.get(mint); meta.delete(mint);
    // Blacklist lernt: illiquide oder >60% Verlust = Rug des Erstellers
    if (m?.creator && (trade.pnlPct <= -60 || /illiquide/.test(trade.reason))) blacklist.recordRug(m.creator);
    notify(tradeExitMsg(trade)).catch(() => {});
  };
}

// Entscheidung nach dem Beobachtungsfenster
function decide(mint) {
  const p = pending.get(mint);
  if (!p || !p.trades.length) return;
  pending.delete(mint);

  const buys = p.trades.filter(t => t.kind === "buy");
  if (buys.length < 2) { checks.pump_zu_wenig_kaeufer++; pump.unsubscribeTrades(mint); paper.stats.noEntry = (paper.stats.noEntry || 0) + 1; return; }

  // 1. Bundle-Verdacht: >=4 Käufe binnen 3s nach Launch (Jito-Bundles landen sofort)
  const in3s = buys.filter(b => b.t - p.ts < 3000).length;
  if (in3s >= 4) { checks.abgelehnt_bundle++; pump.unsubscribeTrades(mint); log(`ABGELEHNT ${p.symbol}: Bundle-Verdacht (${in3s} Käufe in 3s)`); return; }

  // 2. Wash-Verdacht: zu wenige einzigartige Käufer-Wallets
  const uniq = new Set(buys.map(b => b.buyer)).size;
  if (buys.length >= 4 && uniq / buys.length < 0.5) { checks.abgelehnt_wash++; pump.unsubscribeTrades(mint); log(`ABGELEHNT ${p.symbol}: Wash (${uniq}/${buys.length} unique)`); return; }

  // 3. Dominanter Käufer: eine Wallet stellt >60% des Kaufvolumens
  const volBy = {};
  let volSum = 0;
  for (const b of buys) { volBy[b.buyer] = (volBy[b.buyer] || 0) + b.sol; volSum += b.sol; }
  const topShare = volSum > 0 ? Math.max(...Object.values(volBy)) / volSum : 0;
  if (buys.length >= 3 && topShare > 0.6) { checks.abgelehnt_dominanz++; pump.unsubscribeTrades(mint); log(`ABGELEHNT ${p.symbol}: dominanter Käufer (${(topShare * 100).toFixed(0)}%)`); return; }

  // Einstieg zum letzten beobachteten Kurs
  const last = p.trades[p.trades.length - 1];
  const pos = paper.openPosition({ id: mint, symbol: p.symbol, source: "pump.fun", entryPrice: last.price, priceUnit: "SOL", link: p.link });
  if (!pos) { checks.pump_slots_voll++; pump.unsubscribeTrades(mint); return; }
  checks.entries_pump++;
  meta.set(mint, { creator: p.creator, curve: p.curve, buyers: new Set(buys.map(b => b.buyer)), buys: buys.length });
  log(`ENTRY ${p.symbol} @ ${last.price.toExponential(3)} SOL (${uniq} unique Käufer, Top-Share ${(topShare * 100).toFixed(0)}%)`);

  // Insider-Check 60s nach Entry: Top-10-Konzentration on-chain
  setTimeout(async () => {
    if (!paper.open.has(mint)) return;
    const conc = await holderConcentration(mint, p.curve).catch(() => null);
    if (conc != null && conc > 50) {
      checks.exit_insider++;
      const pos2 = paper.open.get(mint);
      paper.closePosition(mint, pos2.lastPrice, `insider-konzentration (Top10 ${conc.toFixed(0)}%)`, onPumpClose(mint));
    }
  }, 60e3);
}

// Fenster-Timeout: Entscheidungen erzwingen, verwaiste Pendings aufräumen
setInterval(() => {
  const now = Date.now();
  for (const [mint, p] of pending) {
    if (p.firstTradeTs && now - p.firstTradeTs > OBS_MS) decide(mint);
    else if (now - p.ts > 120e3) { pending.delete(mint); pump.unsubscribeTrades(mint); paper.stats.noEntry = (paper.stats.noEntry || 0) + 1; }
  }
}, 2000);

// ── Pump.fun-Pfad ────────────────────────────────────────────────────────
const pump = startPumpListener({
  onStatus: s => { pumpStatus = s; log("PumpPortal:", s); },

  async onNewToken(msg) {
    paper.stats.signals++;
    const creator = msg.traderPublicKey || null;
    blacklist.recordLaunch(creator);
    const blocked = blacklist.isBlocked(creator);
    if (blocked) { checks.gesperrt_creator++; log(`GESPERRT ${msg.symbol}: ${blocked}`); return; }

    const check = await checkPump(msg);
    if (!check.ok) { if (/Dev-Buy/.test(check.reason || "")) checks.abgelehnt_devbuy++; return; }

    const sol = await solUsd();
    const mcapUsd = (+msg.marketCapSol || 0) * sol;
    const link = `https://pump.fun/${msg.mint}`;
    const flagTxt = check.flags?.length ? ` ⚠ ${check.flags.join(", ")}` : "";
    log(`SIGNAL pump.fun: ${msg.symbol} | Dev ${check.devSol.toFixed(1)} SOL | MCap ~$${Math.round(mcapUsd / 1e3)}k${flagTxt}`);
    notify(`🎯 <b>Fresh Launch: ${msg.symbol}</b>\npump.fun · Dev ${check.devSol.toFixed(1)} SOL · MCap ~$${Math.round(mcapUsd / 1e3)}k${flagTxt}\n${link}`).catch(() => {});

    checks.pump_beobachtung_gestartet++;
    pending.set(msg.mint, { symbol: msg.symbol || "?", link, creator, curve: msg.bondingCurveKey || null, ts: Date.now(), firstTradeTs: null, trades: [] });
    pump.subscribeTrades(msg.mint);
  },

  onTokenTrade(msg) {
    if (msg.pool && msg.pool !== "pump") return; // migrierte Tokens: andere Kurs-Semantik
    checks.pump_trade_events++;
    const vSol = +msg.vSolInBondingCurve || 0, vTok = +msg.vTokensInBondingCurve || 0;
    const price = vTok > 0 ? vSol / vTok : null;
    if (!price) return;

    const p = pending.get(msg.mint);
    if (p) {
      if (!p.firstTradeTs) p.firstTradeTs = Date.now();
      p.trades.push({ t: Date.now(), kind: msg.txType, buyer: msg.traderPublicKey || "?", sol: +msg.solAmount || 0, price });
      if (p.trades.length >= OBS_TRADES) decide(msg.mint);
      return;
    }

    // Laufende Position: Wash-Überwachung + normale Preis-Updates
    const m = meta.get(msg.mint);
    if (m && msg.txType === "buy") {
      m.buys++; m.buyers.add(msg.traderPublicKey || "?");
      if (m.buys >= 20 && m.buyers.size / m.buys < 0.25) {
        checks.exit_wash++;
        const pos = paper.open.get(msg.mint);
        if (pos) paper.closePosition(msg.mint, price, "wash-trading erkannt", onPumpClose(msg.mint));
        return;
      }
    }
    paper.updatePrice(msg.mint, price, onPumpClose(msg.mint));
  }
});

// Sweep-Exits (Zeitlimit/illiquide) melden, Abos aufräumen, Blacklist füttern
paper.onSweepClose(trade => {
  notify(tradeExitMsg(trade)).catch(() => {});
});

// ── GeckoTerminal-Pfad (EVM + Solana-DEX) ────────────────────────────────
const gtOpen = new Map();
startGeckoListener(async cand => {
  paper.stats.signals++;
  if (isRelaunch(cand.symbol)) { checks.abgelehnt_relaunch++; return; }
  let check;
  if (cand.network === "solana") check = { ok: true, flags: ["Solana-DEX: nur Basis-Check"] };
  else { check = await checkEvm(cand.network, cand.address); if (!check.ok) return; }

  const link = `https://dexscreener.com/${cand.network}/${cand.poolAddr || cand.address}`;
  const lp = check.lpLockedPct != null ? ` · LP ${check.lpLockedPct.toFixed(0)}%` : "";
  const flagTxt = check.flags?.length ? ` ⚠ ${check.flags.join(", ")}` : "";
  log(`SIGNAL gecko/${cand.network}: ${cand.symbol} | ${cand.ageMin.toFixed(0)} Min | Liq $${Math.round(cand.liq / 1e3)}k${lp}${flagTxt}`);
  notify(`🎯 <b>Neuer Pool: ${cand.symbol}</b>\n${cand.network.toUpperCase()} · ${cand.ageMin.toFixed(0)} Min alt · Liq $${Math.round(cand.liq / 1e3)}k${lp}${flagTxt}\n${link}`).catch(() => {});

  if (cand.priceUsd && cand.poolAddr) {
    const pos = paper.openPosition({ id: cand.network + ":" + cand.address, symbol: cand.symbol, source: "gecko", network: cand.network, entryPrice: cand.priceUsd, priceUnit: "USD", link });
    if (pos) { checks.entries_gecko++; gtOpen.set(pos.id, { network: cand.network, poolAddr: cand.poolAddr }); }
  }
});

setInterval(async () => {
  // Sammel-Abfrage: 1 Request pro Chain statt 1 pro Position (GeckoTerminal-Rate-Limit!)
  const byNet = {};
  for (const [id, ref] of gtOpen) {
    if (!paper.open.has(id)) { gtOpen.delete(id); continue; }
    (byNet[ref.network] = byNet[ref.network] || []).push({ id, addr: ref.poolAddr });
  }
  for (const [net, list] of Object.entries(byNet)) {
    try {
      const addrs = list.map(x => x.addr).join(",");
      const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/${net}/pools/multi/${addrs}`,
        { headers: { accept: "application/json" } });
      if (!r.ok) { console.error("gecko multi", net, r.status); continue; }
      const d = await r.json();
      const priceByPool = {};
      for (const pd of (d.data || []))
        priceByPool[(pd.attributes?.address || "").toLowerCase()] = +pd.attributes?.base_token_price_usd || null;
      for (const x of list) {
        const price = priceByPool[(x.addr || "").toLowerCase()];
        if (price) paper.updatePrice(x.id, price, trade => { gtOpen.delete(x.id); notify(tradeExitMsg(trade)).catch(() => {}); });
      }
    } catch (e) { console.error("gecko multi", net, e.message); }
  }
}, cfg.PRICE_POLL_SEC * 1000);

// ── Stats-HTTP ───────────────────────────────────────────────────────────
http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (cfg.STATS_TOKEN && url.searchParams.get("t") !== cfg.STATS_TOKEN) {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "unauthorized – ?t=STATS_TOKEN anhängen" }));
  }
  const s = paper.summary();
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    status: "läuft", pumpPortal: pumpStatus,
    uptimeMin: +((Date.now() - boot) / 60e3).toFixed(0),
    config: { tp: cfg.TAKE_PROFIT_PCT + "%", sl: cfg.STOP_LOSS_PCT + "%", zeitlimit: cfg.TIME_LIMIT_MIN + " Min", position: "$" + cfg.POSITION_USD },
    pruefungen: checks,
    beobachtung: pending.size,
    ...s
  }, null, 2));
}).listen(cfg.PORT, () => log("Stats-Server auf Port", cfg.PORT));

process.on("SIGTERM", async () => { await paper.flush(); process.exit(0); });
log("KAS-Sniper-Bot v3 gestartet. Paper-Trading aktiv – KEIN echtes Geld.");
