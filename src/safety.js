// src/safety.js – Sekunden-Checks. Ehrlich: bei Coins, die Minuten alt sind,
// hat GoPlus oft NOCH KEINE Daten. Dann gilt "ungeprüft" (Flag), nicht "sicher".
const cfg = require("./config");
const BURN = new Set(["0x0000000000000000000000000000000000000000","0x000000000000000000000000000000000000dead"]);

async function fetchJSON(url, ms = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); return await r.json(); }
  finally { clearTimeout(t); }
}

// Solana / Pump.fun: Heuristiken aus dem Create-Event + optional GoPlus
async function checkPump(msg) {
  const flags = [];
  const devSol = +msg.solAmount || 0;
  if (!msg.name || !msg.symbol) return { ok: false, reason: "kein Name/Symbol" };
  if (devSol > cfg.MAX_DEV_BUY_SOL) return { ok: false, reason: `Dev-Buy ${devSol.toFixed(1)} SOL zu groß (Dump-Risiko)` };
  if (devSol < cfg.MIN_DEV_BUY_SOL) return { ok: false, reason: `Dev-Buy ${devSol.toFixed(2)} SOL zu klein (kein Commitment)` };

  let gp = null;
  try {
    const d = await fetchJSON(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${msg.mint}`);
    gp = d?.result?.[msg.mint] || null;
  } catch { /* zu jung für GoPlus – normal */ }

  if (gp) {
    const on = k => { const v = gp[k]; return !!(v && (v.status === "1" || v === "1" || v === 1)); };
    if (on("freezable") || on("freeze_account")) return { ok: false, reason: "Freeze-Authority aktiv" };
    if (on("mintable")) return { ok: false, reason: "Mint-Authority aktiv" };
  } else {
    if (cfg.REQUIRE_GOPLUS) return { ok: false, reason: "keine GoPlus-Daten (REQUIRE_GOPLUS=true)" };
    flags.push("ungeprüft (zu neu für GoPlus)");
  }
  return { ok: true, flags, devSol };
}

// EVM (GeckoTerminal-Kandidaten): vollwertiger GoPlus-Check
const GOP_ID = { eth: "1", base: "8453", bsc: "56", arbitrum: "42161" };
async function checkEvm(network, address) {
  const id = GOP_ID[network];
  if (!id) return { ok: false, reason: "Chain nicht unterstützt" };
  let s = null;
  try {
    const d = await fetchJSON(`https://api.gopluslabs.io/api/v1/token_security/${id}?contract_addresses=${address}`, 4000);
    s = d?.result?.[address] || d?.result?.[address.toLowerCase()] || null;
  } catch { return { ok: false, reason: "GoPlus nicht erreichbar" }; }
  if (!s) return { ok: false, reason: "keine GoPlus-Daten" };

  if (s.is_honeypot === "1") return { ok: false, reason: "HONEYPOT" };
  const tax = s.sell_tax !== "" && s.sell_tax != null ? +s.sell_tax * 100 : null;
  if (tax != null && tax > cfg.MAX_SELL_TAX_PCT) return { ok: false, reason: `Sell-Tax ${tax.toFixed(0)}%` };
  if (s.is_mintable === "1") return { ok: false, reason: "mintbar" };
  if (s.transfer_pausable === "1") return { ok: false, reason: "Transfers pausierbar" };
  if (s.can_take_back_ownership === "1") return { ok: false, reason: "Ownership rückholbar" };
  if (s.selfdestruct === "1") return { ok: false, reason: "Selfdestruct im Contract" };

  const flags = [];
  const creator = s.creator_percent !== "" && s.creator_percent != null ? +s.creator_percent * 100 : null;
  if (creator != null && creator > cfg.MAX_CREATOR_PCT) return { ok: false, reason: `Creator hält ${creator.toFixed(0)}%` };

  let lp = null;
  if (Array.isArray(s.lp_holders) && s.lp_holders.length) {
    lp = s.lp_holders.reduce((a, h) => {
      const locked = h.is_locked === 1 || h.is_locked === "1" || BURN.has((h.address || "").toLowerCase());
      return a + (locked ? (+h.percent || 0) : 0);
    }, 0) * 100;
    if (lp < cfg.MIN_LP_LOCK_PCT) return { ok: false, reason: `LP nur ${lp.toFixed(0)}% gelockt` };
  } else flags.push("LP-Lock unbekannt");

  if (s.is_open_source === "0") flags.push("Contract nicht verifiziert");
  return { ok: true, flags, lpLockedPct: lp, creatorPct: creator, sellTax: tax };
}

module.exports = { checkPump, checkEvm };
