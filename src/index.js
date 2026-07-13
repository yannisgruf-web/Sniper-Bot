// src/index.js – verdrahtet alles:
// PumpPortal (Sekunden) + GeckoTerminal (Minuten) -> Safety -> Push + Paper-Trade -> Stats
const http = require("http");
const cfg = require("./config");
const { startPumpListener } = require("./pump-listener");
const { startGeckoListener, poolPriceUsd } = require("./gecko-listener");
const { checkPump, checkEvm } = require("./safety");
const paper = require("./paper");
const { sendPush } = require("./push");
const { solUsd } = require("./sol-price");

const boot = Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let pumpStatus = "startet…";

// ── Pump.fun-Pfad (Solana, sekundenschnell) ─────────────────────────────
const pump = startPumpListener({
  onStatus: s => { pumpStatus = s; log("PumpPortal:", s); },

  async onNewToken(msg) {
    paper.stats.signals++;
    const check = await checkPump(msg);
    if (!check.ok) return; // still verwerfen – 95% fliegen hier raus

    const vSol = +msg.vSolInBondingCurve || 0, vTok = +msg.vTokensInBondingCurve || 0;
    const priceSol = vTok > 0 ? vSol / vTok : null;
    if (!priceSol) return;

    const sol = await solUsd();
    const mcapUsd = (+msg.marketCapSol || 0) * sol;
    const link = `https://pump.fun/${msg.mint}`;
    const flagTxt = check.flags?.length ? ` ⚠ ${check.flags.join(", ")}` : "";

    log(`SIGNAL pump.fun: ${msg.symbol} | Dev-Buy ${check.devSol.toFixed(1)} SOL | MCap ~$${Math.round(mcapUsd / 1e3)}k${flagTxt}`);
    sendPush(
      `🎯 Fresh Launch: ${msg.symbol}`,
      `pump.fun · Dev ${check.devSol.toFixed(1)} SOL · MCap ~$${Math.round(mcapUsd / 1e3)}k${flagTxt}`,
      link
    ).catch(() => {});

    const pos = paper.openPosition({
      id: msg.mint, symbol: msg.symbol || "?", source: "pump.fun",
      entryPrice: priceSol, priceUnit: "SOL", link
    });
    if (pos) pump.subscribeTrades(msg.mint);
  },

  onTokenTrade(msg) {
    const vSol = +msg.vSolInBondingCurve || 0, vTok = +msg.vTokensInBondingCurve || 0;
    const price = vTok > 0 ? vSol / vTok : null;
    if (!price) return;
    paper.updatePrice(msg.mint, price, trade => {
      pump.unsubscribeTrades(msg.mint);
      sendPush(
        trade.pnlPct >= 0 ? `✅ Paper +${trade.pnlPct}%: ${trade.symbol}` : `❌ Paper ${trade.pnlPct}%: ${trade.symbol}`,
        `${trade.reason} nach ${trade.holdMin} Min · fiktiv ${trade.pnlUsd >= 0 ? "+" : ""}$${trade.pnlUsd}`,
        trade.link || "/"
      ).catch(() => {});
    });
  }
});

// ── GeckoTerminal-Pfad (EVM + Solana-DEX, Minuten-Latenz) ───────────────
const gtOpen = new Map(); // id -> {network, poolAddr}
startGeckoListener(async cand => {
  paper.stats.signals++;
  let check;
  if (cand.network === "solana") {
    check = { ok: true, flags: ["Solana-DEX: nur Basis-Check"] };
  } else {
    check = await checkEvm(cand.network, cand.address);
    if (!check.ok) return;
  }
  const link = `https://dexscreener.com/${cand.network}/${cand.poolAddr || cand.address}`;
  const lp = check.lpLockedPct != null ? ` · LP ${check.lpLockedPct.toFixed(0)}%` : "";
  const flagTxt = check.flags?.length ? ` ⚠ ${check.flags.join(", ")}` : "";

  log(`SIGNAL gecko/${cand.network}: ${cand.symbol} | ${cand.ageMin.toFixed(0)} Min alt | Liq $${Math.round(cand.liq / 1e3)}k${lp}${flagTxt}`);
  sendPush(
    `🎯 Neuer Pool: ${cand.symbol}`,
    `${cand.network.toUpperCase()} · ${cand.ageMin.toFixed(0)} Min alt · Liq $${Math.round(cand.liq / 1e3)}k${lp}${flagTxt}`,
    link
  ).catch(() => {});

  if (cand.priceUsd && cand.poolAddr) {
    const pos = paper.openPosition({
      id: cand.network + ":" + cand.address, symbol: cand.symbol, source: "gecko",
      network: cand.network, entryPrice: cand.priceUsd, priceUnit: "USD", link
    });
    if (pos) gtOpen.set(pos.id, { network: cand.network, poolAddr: cand.poolAddr });
  }
});

// Preis-Polling für offene GT-Positionen
setInterval(async () => {
  for (const [id, ref] of gtOpen) {
    if (!paper.open.has(id)) { gtOpen.delete(id); continue; }
    const price = await poolPriceUsd(ref.network, ref.poolAddr);
    if (price) paper.updatePrice(id, price, trade => {
      gtOpen.delete(id);
      sendPush(
        trade.pnlPct >= 0 ? `✅ Paper +${trade.pnlPct}%: ${trade.symbol}` : `❌ Paper ${trade.pnlPct}%: ${trade.symbol}`,
        `${trade.reason} nach ${trade.holdMin} Min · fiktiv ${trade.pnlUsd >= 0 ? "+" : ""}$${trade.pnlUsd}`,
        trade.link || "/"
      ).catch(() => {});
    });
  }
}, cfg.PRICE_POLL_SEC * 1000);

// ── Stats-HTTP (Railway-URL, geschützt per ?t=STATS_TOKEN) ──────────────
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
    ...s
  }, null, 2));
}).listen(cfg.PORT, () => log("Stats-Server auf Port", cfg.PORT));

// Sauber beenden (Railway-Redeploys): offene Trades noch wegschreiben
process.on("SIGTERM", async () => { await paper.flush(); process.exit(0); });

log("KAS-Sniper-Bot gestartet. Paper-Trading aktiv – KEIN echtes Geld.");
