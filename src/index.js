// src/index.js – Orchestrator v3
// Neu: Beobachtungsfenster vor dem Einstieg (Bundle-/Wash-/Dominanz-Erkennung),
// Insider-Konzentrations-Check 60s nach Entry, Wash-Überwachung während der
// Position, selbstlernende Deployer-Blacklist.
const http = require("http");
const cfg = require("./config");
const { startPumpListener } = require("./pump-listener");
const { startGeckoListener, dexPrices } = require("./gecko-listener");
const { checkPump, checkEvm } = require("./safety");
const { holderConcentration } = require("./onchain");
const blacklist = require("./blacklist");
const paper = require("./paper");
const { notify } = require("./telegram");
const { solUsd, bnbUsd } = require("./prices");
const executor = require("./executor");

const boot = Date.now();
const liveIds = new Set();
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
    if (cfg.NOTIFY_PAPER) notify(tradeExitMsg(trade)).catch(() => {});
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
    if (blocked) { checks.gesperrt_creator++; if (cfg.LOG_SIGNALS) log(`GESPERRT ${msg.symbol}: ${blocked}`); return; }

    const check = await checkPump(msg);
    if (!check.ok) { if (/Dev-Buy/.test(check.reason || "")) checks.abgelehnt_devbuy++; return; }

    const sol = await solUsd();
    const mcapUsd = (+msg.marketCapSol || 0) * sol;
    const link = `https://pump.fun/${msg.mint}`;
    const flagTxt = check.flags?.length ? ` ⚠ ${check.flags.join(", ")}` : "";
    if (cfg.LOG_SIGNALS) log(`SIGNAL pump.fun: ${msg.symbol} | Dev ${check.devSol.toFixed(1)} SOL | MCap ~$${Math.round(mcapUsd / 1e3)}k${flagTxt}`);
    if (cfg.NOTIFY_PAPER) notify(`🎯 <b>Fresh Launch: ${msg.symbol}</b>\npump.fun · Dev ${check.devSol.toFixed(1)} SOL · MCap ~$${Math.round(mcapUsd / 1e3)}k${flagTxt}\n${link}`).catch(() => {});

    checks.pump_beobachtung_gestartet++;
    pending.set(msg.mint, { symbol: msg.symbol || "?", link, creator, curve: msg.bondingCurveKey || null, ts: Date.now(), firstTradeTs: null, trades: [] });
    pump.subscribeTrades(msg.mint);
  },

  onTokenTrade(msg) {
    checks.pump_trade_events++;
    if (msg.pool && msg.pool !== "pump") { checks.pump_events_andere_pools = (checks.pump_events_andere_pools || 0) + 1; return; }
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
  if (cfg.NOTIFY_PAPER) notify(tradeExitMsg(trade)).catch(() => {});
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
  if (cfg.LOG_SIGNALS) log(`SIGNAL gecko/${cand.network}: ${cand.symbol} | ${cand.ageMin.toFixed(0)} Min | Liq $${Math.round(cand.liq / 1e3)}k${lp}${flagTxt}`);
  if (cfg.NOTIFY_PAPER) notify(`🎯 <b>Neuer Pool: ${cand.symbol}</b>\n${cand.network.toUpperCase()} · ${cand.ageMin.toFixed(0)} Min alt · Liq $${Math.round(cand.liq / 1e3)}k${lp}${flagTxt}\n${link}`).catch(() => {});

  if (cand.priceUsd && cand.poolAddr) {
    // Reaktionszeit simulieren: 2-8s warten, dann zum FRISCHEN Kurs einsteigen
    const delay = cfg.FRICTION ? cfg.ENTRY_DELAY_MIN_MS + Math.random() * (cfg.ENTRY_DELAY_MAX_MS - cfg.ENTRY_DELAY_MIN_MS) : 0;
    setTimeout(async () => {
      let fill = cand.priceUsd;
      if (delay > 0) {
        const p = await dexPrices(cand.network, [cand.poolAddr]);
        const fresh = p[(cand.poolAddr || "").toLowerCase()];
        if (fresh) fill = fresh;
      }
      const posId = cand.network + ":" + cand.address;
      const pos = paper.openPosition({ id: posId, symbol: cand.symbol, source: "gecko", network: cand.network, entryPrice: fill, priceUnit: "USD", link });
      if (pos) {
        checks.entries_gecko++; gtOpen.set(pos.id, { network: cand.network, poolAddr: cand.poolAddr });
        { const priceUnitUsd = cand.network === "solana" ? await solUsd() : await bnbUsd();
          executor.openReal({ id: posId, chain: cand.network, tokenAddr: cand.address, symbol: cand.symbol, priceUnitUsd })
            .catch(e => console.error("exec.openReal", e.message)); }
      }
    }, delay);
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
    const priceByPool = await dexPrices(net, list.map(x => x.addr));
    for (const x of list) {
      const price = priceByPool[(x.addr || "").toLowerCase()];
      if (price) paper.updatePrice(x.id, price, async trade => {
        gtOpen.delete(x.id);
        if (executor.hasLivePosition(x.id)) {
          const puUsd = x.network === "solana" ? await solUsd() : await bnbUsd();
          executor.closeReal(x.id, puUsd, trade.reason).catch(()=>{});
        }
        if (cfg.NOTIFY_PAPER) notify(tradeExitMsg(trade)).catch(() => {});
      });
    }
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
    live: executor.summary(),
    beobachtung: pending.size,
    ...s
  }, null, 2));
}).listen(cfg.PORT, () => log("Stats-Server auf Port", cfg.PORT));

// ── Telegram-Befehle: /stop (Not-Aus), /go (wieder frei), /weiter (nächster Ein-Trade), /bilanz (Gap-Log-Auswertung), /status ──
let tgOffset = 0;
async function pollCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${tgOffset}&timeout=30`);
    const d = await r.json();
    for (const u of (d.result || [])) {
      tgOffset = u.update_id + 1;
      const text = (u.message?.text || "").trim().toLowerCase();
      if (text === "/stop") { risk.kill("manuell"); notify("🛑 <b>NOT-AUS aktiv</b>\nKeine neuen Live-Käufe mehr. Offene Positionen werden weiter regulär verkauft. Mit /go wieder freigeben.").catch(()=>{}); }
      else if (text === "/go") { risk.reset(); notify("✅ Live-Käufe wieder freigegeben.").catch(()=>{}); }
      else if (text === "/weiter") { const r = executor.resume(); notify(r.enabled ? `▶️ <b>Nächster Trade freigegeben</b>\nEin-Trade-Test neu scharf. Tages-PnL läuft weiter: ${r.pnlUsdToday>=0?"+":""}${r.pnlUsdToday}$ (Limit −$${cfg.DAILY_LOSS_LIMIT_USD})`
        : "⚠️ LIVE_TRADING ist in Railway auf false – /weiter wirkt erst, wenn es an ist.").catch(()=>{}); }
      else if (text === "/bilanz") {
        const gapLog = require("./gap-log");
        const b = gapLog.bilanz();
        if (!b.n) { notify("📊 Noch keine abgeschlossenen Live-Trades im Log.").catch(()=>{}); }
        else {
          notify(`📊 <b>Bilanz (${b.n} Trades)</b>\n` +
            `Rugs: ${b.rugs} (${b.rugRatePct}%)\n` +
            `Ø Ausführungslücke: ${b.avgGapPp != null ? b.avgGapPp + "pp" : "n/a"}\n` +
            `Gesamt-PnL: ${b.totalPnlUsd >= 0 ? "+" : ""}${b.totalPnlUsd}$ (Einsatz gesamt ${b.totalSizeUsd}$)\n` +
            (b.best ? `Bester: ${b.best.symbol} (${b.best.pnl >= 0 ? "+" : ""}${b.best.pnl}$)\n` : "") +
            (b.worst ? `Schlechtester: ${b.worst.symbol} (${b.worst.pnl >= 0 ? "+" : ""}${b.worst.pnl}$)` : "")
          ).catch(()=>{});
        }
      }
      else if (text === "/status") { const s = executor.summary(); notify(`📊 Live: ${s.live?"AN":"aus"}${s.dryRun?" (dry-run)":""} · offen ${s.openLive}\nChains: ${s.chains.join(", ")}\nTrades heute: ${s.realTradesToday} · PnL heute ${s.pnlUsdToday>=0?"+":""}$${s.pnlUsdToday} (Limit −$${s.dailyLossStop})\n${s.haltReason?"⛔ Gestoppt: "+s.haltReason:"✅ aktiv"}\nSOL: <code>${s.solAddress||"—"}</code>\nBSC: <code>${s.bscAddress||"—"}</code>`).catch(()=>{}); }
    }
  } catch {}
  setTimeout(pollCommands, 1000);
}
pollCommands();

process.on("SIGTERM", async () => { await paper.flush(); process.exit(0); });
const solX = require("./exec-solana");
const bscX = require("./exec-bsc");
(async () => {
  solX.init(); bscX.init();
  const solAddr = solX.address(), bscAddr = bscX.address();
  if (solAddr) log("Solana-Wallet geladen:", solAddr); else log("Solana-Wallet: kein Key");
  if (bscAddr) log("BSC-Wallet geladen:", bscAddr); else log("BSC-Wallet: kein Key");
  if (cfg.LIVE_TRADING) {
    const sBal = solAddr ? await solX.solBalanceUsd(await solUsd()).catch(()=>null) : null;
    const bBal = bscAddr ? await bscX.bnbBalanceUsd(await bnbUsd()).catch(()=>null) : null;
    log(`⚠️  LIVE-TRADING AKTIV. Chains: ${cfg.LIVE_CHAINS.join(",")}`);
    log(`   Solana-Guthaben: ${sBal!=null?"$"+sBal.toFixed(2):"—"} | BSC-Guthaben: ${bBal!=null?"$"+bBal.toFixed(2):"—"}`);
    log(`   Positionsgröße SOL $${cfg.POS_USD_SOLANA} / BSC $${cfg.POS_USD_BSC} | Tageslimit -$${Math.abs(cfg.DAILY_LOSS_LIMIT_USD)}`);
    notify(`🟢 <b>Sniper LIVE gestartet</b>\nSOL-Wallet: $${sBal!=null?sBal.toFixed(2):"?"} · BNB-Wallet: $${bBal!=null?bBal.toFixed(2):"?"}\nPos: SOL $${cfg.POS_USD_SOLANA} / BSC $${cfg.POS_USD_BSC} · Tageslimit −$${Math.abs(cfg.DAILY_LOSS_LIMIT_USD)}`).catch(()=>{});
    notify(`⚠️ <b>LIVE-TRADING gestartet</b>\nChains: ${cfg.LIVE_CHAINS.join(", ")}\nSolana: ${sBal!=null?"$"+sBal.toFixed(2):"—"} · BSC: ${bBal!=null?"$"+bBal.toFixed(2):"—"}\nPos: SOL $${cfg.POSITION_USD_SOLANA} / BSC $${cfg.POSITION_USD_BSC} · Tageslimit -$${Math.abs(cfg.DAILY_LOSS_LIMIT_USD)}`).catch(()=>{});
  } else {
    log("KAS-Sniper-Bot gestartet. Paper-Trading aktiv – KEIN echtes Geld (LIVE_TRADING=false).");
  }
})();
