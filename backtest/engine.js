// backtest/engine.js – rechnet die LIVE-Logik über historische Kerzen.
//
// Architektur (wichtig für die Laufzeit): Die teuren Indikatoren werden EINMAL
// pro Coin/Zeitrahmen als Zeitreihe berechnet und zwischengespeichert. Danach
// ist jede Parameter-Kombination nur noch ein billiger Durchlauf über diese
// vorberechneten Signale. Sonst wäre jede Kombi ein kompletter Neu-Durchlauf.
const ind = require("../src/indicators");

// ── 15m-Kerzen zu größeren Zeitrahmen zusammenfassen ──
function aggregiere(candles, faktor) {
  if (faktor === 1) return candles;
  const out = [];
  for (let i = 0; i + faktor <= candles.length; i += faktor) {
    const grp = candles.slice(i, i + faktor);
    out.push({
      t: grp[0].t, o: grp[0].o,
      h: Math.max(...grp.map(k => k.h)),
      l: Math.min(...grp.map(k => k.l)),
      c: grp[grp.length - 1].c,
      v: grp.reduce((s, k) => s + k.v, 0),
    });
  }
  return out;
}

// ── Serien-Varianten der Indikatoren, die live nur einen Skalar liefern ──
// (Werte identisch zu src/indicators.js – wird in run.js gegengeprüft.)
function adxSerie(candles, len = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < len * 2) return out;
  let trN = 0, plusN = 0, minusN = 0;
  const dx = [], dxIdx = [];
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    const plusDM = (up > down && up > 0) ? up : 0;
    const minusDM = (down > up && down > 0) ? down : 0;
    const tr = Math.max(candles[i].h - candles[i].l,
                        Math.abs(candles[i].h - candles[i - 1].c),
                        Math.abs(candles[i].l - candles[i - 1].c));
    if (i <= len) { trN += tr; plusN += plusDM; minusN += minusDM; }
    else {
      trN = trN - trN / len + tr;
      plusN = plusN - plusN / len + plusDM;
      minusN = minusN - minusN / len + minusDM;
    }
    if (i >= len) {
      const plusDI = 100 * plusN / (trN || 1e-9);
      const minusDI = 100 * minusN / (trN || 1e-9);
      const sum = plusDI + minusDI || 1e-9;
      dx.push(100 * Math.abs(plusDI - minusDI) / sum);
      dxIdx.push(i);
    }
  }
  if (dx.length < len) return out;
  let adxVal = dx.slice(0, len).reduce((a, b) => a + b, 0) / len;
  out[dxIdx[len - 1]] = adxVal;
  for (let j = len; j < dx.length; j++) {
    adxVal = (adxVal * (len - 1) + dx[j]) / len;
    out[dxIdx[j]] = adxVal;
  }
  return out;
}

function atrSerie(candles, len = 14) {
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < len + 1) return out;
  const tr = [];
  for (let i = 1; i < n; i++)
    tr.push(Math.max(candles[i].h - candles[i].l,
                     Math.abs(candles[i].h - candles[i - 1].c),
                     Math.abs(candles[i].l - candles[i - 1].c)));
  let v = tr.slice(0, len).reduce((a, b) => a + b, 0) / len;
  out[len] = v;
  for (let i = len; i < tr.length; i++) { v = (v * (len - 1) + tr[i]) / len; out[i + 1] = v; }
  return out;
}

function emaTrendSerie(closes, fast = 50, slow = 200) {
  const ef = ind.ema(closes, fast), es = ind.ema(closes, slow);
  return closes.map((price, i) => {
    if (i < slow) {                                  // gleiche Fallback-Logik wie live
      const kurz = ind.ema(closes.slice(0, i + 1), Math.min(fast, Math.max(2, Math.floor((i + 1) / 2))));
      const v = kurz[i];
      if (v == null) return 0;
      return price > v ? 1 : price < v ? -1 : 0;
    }
    if (ef[i] == null || es[i] == null) return 0;
    if (price > ef[i] && ef[i] > es[i]) return 1;
    if (price < ef[i] && ef[i] < es[i]) return -1;
    return 0;
  });
}

function vwapSideSerie(candles, lookback = 96) {
  const n = candles.length;
  const out = new Array(n).fill(0);
  let pvSum = 0, volSum = 0;
  const pvArr = [], volArr = [];
  for (let i = 0; i < n; i++) {
    const tp = (candles[i].h + candles[i].l + candles[i].c) / 3;
    pvArr.push(tp * candles[i].v); volArr.push(candles[i].v);
    pvSum += pvArr[i]; volSum += volArr[i];
    if (pvArr.length > lookback) { pvSum -= pvArr[i - lookback]; volSum -= volArr[i - lookback]; }
    if (volSum <= 0) { out[i] = 0; continue; }
    const vwap = pvSum / volSum;
    out[i] = candles[i].c > vwap ? 1 : candles[i].c < vwap ? -1 : 0;
  }
  return out;
}

// ── Signale EINMAL pro Coin/Zeitrahmen vorberechnen ──
// Ergebnis je Kerze: Anzahl bullischer/bärischer Oszillator-Stimmen, ADX, ATR,
// EMA-Trend, VWAP-Seite, Momentum-Ausbruchsrichtung.
function berechneSignale(candles) {
  const n = candles.length;
  const closes = candles.map(k => k.c);
  const rsiS = ind.rsi(closes, 14);
  const mfiS = ind.mfi(candles, 14);
  const { k: kS, d: dS } = ind.stochRsi(closes);
  const psoS = ind.premierStoch(candles);
  const macdS = ind.macd(closes);
  const sqS = ind.ttmSqueeze(candles);
  const adxS = adxSerie(candles);
  const atrS = atrSerie(candles);
  const emaS = emaTrendSerie(closes);
  const vwapS = vwapSideSerie(candles);

  const bull = new Uint8Array(n), bear = new Uint8Array(n);
  const fibS = new Uint8Array(n), momS = new Int8Array(n);
  const momBody = new Float32Array(n), momVol = new Float32Array(n);

  // Rollendes Durchschnittsvolumen für den Momentum-Ausbruch (20 Kerzen)
  const VOL_LEN = 20;
  let volSum = 0;
  for (let i = 0; i < n; i++) {
    const p = i - 1;
    let b = 0, s = 0;

    // RSI-Divergenz: braucht ein Fenster, das auf i endet
    if (i >= 45) {
      const fenster = candles.slice(Math.max(0, i - 59), i + 1);
      const rsiFenster = rsiS.slice(Math.max(0, i - 59), i + 1);
      const div = ind.rsiDivergence(fenster, rsiFenster);
      if (div === 1) b++; else if (div === -1) s++;
    }
    if (mfiS[i] != null) { if (mfiS[i] < 20) b++; else if (mfiS[i] > 80) s++; }
    if (p >= 0 && kS[i] != null && dS[i] != null && kS[p] != null && dS[p] != null) {
      if (kS[p] <= dS[p] && kS[i] > dS[i] && kS[i] < 30) b++;
      else if (kS[p] >= dS[p] && kS[i] < dS[i] && kS[i] > 70) s++;
    }
    if (p >= 0 && psoS[i] != null && psoS[p] != null) {
      if (psoS[p] < -0.9 && psoS[i] >= -0.9) b++;
      else if (psoS[p] > 0.9 && psoS[i] <= 0.9) s++;
    }
    if (p >= 0 && macdS.hist[i] != null && macdS.hist[p] != null) {
      if (macdS.hist[p] <= 0 && macdS.hist[i] > 0) b++;
      else if (macdS.hist[p] >= 0 && macdS.hist[i] < 0) s++;
    }
    if (p >= 0 && sqS.on[i] != null && sqS.on[p] != null && sqS.on[p] === true && sqS.on[i] === false) {
      if (sqS.momo[i] > 0) b++; else if (sqS.momo[i] < 0) s++;
    }
    // Fibonacci Golden Pocket (nur bullisch)
    if (i >= 60) {
      const f = ind.fibGoldenPocket(candles.slice(Math.max(0, i - 59), i + 1));
      if (f.inPocket === 1) { fibS[i] = 1; b++; }
    }
    bull[i] = b; bear[i] = s;

    // Momentum-Ausbruch: starke Kerze + Volumen-Spike
    volSum += candles[i].v;
    if (i > VOL_LEN) {
      volSum -= candles[i - VOL_LEN - 1].v;
      const avgVol = volSum / VOL_LEN;            // Schnitt der VORIGEN 20 (ohne i)
      const bodyPct = ((candles[i].c - candles[i].o) / candles[i].o) * 100;
      momBody[i] = bodyPct;
      momVol[i] = avgVol > 0 ? candles[i].v / avgVol : 0;
    }
  }
  return { bull, bear, fib: fibS, adx: adxS, atr: atrS, ema: emaS, vwap: vwapS,
           momBody, momVol, candles };
}

// ── Eine Parameter-Kombination über die vorberechneten Signale simulieren ──
// Führt exakt die Live-Regeln aus: ADX-Weiche, Trend-Gate, ATR- oder Prozent-Exits.
function simuliere(sig, cfg) {
  const c = sig.candles, n = c.length;
  const trades = [];
  let pos = null;

  for (let i = Math.max(210, 61); i < n; i++) {
    const price = c[i].c;

    // ── Offene Position prüfen (Exits laufen auf Hoch/Tief der Kerze) ──
    if (pos) {
      const istLong = pos.side === "long";
      const hoch = c[i].h, tief = c[i].l;
      let exitPreis = null, grund = null;

      if (pos.slPrice != null) {                    // ATR-Modus
        if (istLong) {
          if (tief <= pos.slPrice) { exitPreis = pos.slPrice; grund = "atr-stop"; }
          else if (pos.tpPrice && hoch >= pos.tpPrice) { exitPreis = pos.tpPrice; grund = "atr-ziel"; }
          else if (price > pos.peakPrice) {         // Trailing nachziehen
            pos.peakPrice = price;
            const neu = price - pos.atrAbs * cfg.atrTrailMult;
            if (neu > pos.slPrice) pos.slPrice = neu;
          }
        } else {
          if (hoch >= pos.slPrice) { exitPreis = pos.slPrice; grund = "atr-stop"; }
          else if (pos.tpPrice && tief <= pos.tpPrice) { exitPreis = pos.tpPrice; grund = "atr-ziel"; }
          else if (price < pos.peakPrice) {
            pos.peakPrice = price;
            const neu = price + pos.atrAbs * cfg.atrTrailMult;
            if (neu < pos.slPrice) pos.slPrice = neu;
          }
        }
      } else {                                       // Prozent-Modus
        const bewegungHoch = istLong ? ((hoch - pos.entry) / pos.entry) * 100 : ((pos.entry - tief) / pos.entry) * 100;
        const bewegungTief = istLong ? ((tief - pos.entry) / pos.entry) * 100 : ((pos.entry - hoch) / pos.entry) * 100;
        const pnlHoch = bewegungHoch * cfg.hebel, pnlTief = bewegungTief * cfg.hebel;
        if (pnlTief <= cfg.slPct) {
          exitPreis = istLong ? pos.entry * (1 + cfg.slPct / cfg.hebel / 100) : pos.entry * (1 - cfg.slPct / cfg.hebel / 100);
          grund = "stop-loss";
        } else if (pnlHoch >= cfg.tpPct) {
          exitPreis = istLong ? pos.entry * (1 + cfg.tpPct / cfg.hebel / 100) : pos.entry * (1 - cfg.tpPct / cfg.hebel / 100);
          grund = "take-profit";
        } else {
          const pnlJetzt = (istLong ? ((price - pos.entry) / pos.entry) : ((pos.entry - price) / pos.entry)) * 100 * cfg.hebel;
          if (pnlJetzt > pos.peakPnl) pos.peakPnl = pnlJetzt;
          if (pos.peakPnl >= cfg.trailArm) {
            const stufe = Math.floor(pos.peakPnl / cfg.trailStep) * cfg.trailStep - cfg.trailStep;
            if (pnlJetzt <= stufe) { exitPreis = price; grund = "trailing"; }
          }
        }
      }
      // Gegen-Konfluenz schließt Oszillator-Positionen
      if (!exitPreis && pos.strategie === "oszillator") {
        if (pos.side === "long" && sig.bear[i] >= cfg.minVotes) { exitPreis = price; grund = "gegen-konfluenz"; }
        else if (pos.side === "short" && sig.bull[i] >= cfg.minVotes) { exitPreis = price; grund = "gegen-konfluenz"; }
      }

      if (exitPreis) {
        const move = pos.side === "long" ? (exitPreis - pos.entry) / pos.entry : (pos.entry - exitPreis) / pos.entry;
        const bruttoPct = move * 100 * cfg.hebel;
        const gebuehrPct = cfg.feePct * 2 * cfg.hebel;      // Gebühr auf Positionsvolumen
        let nettoPct = bruttoPct - gebuehrPct;
        if (nettoPct < -100) nettoPct = -100;                // Liquidation kappt bei Einsatz
        trades.push({ side: pos.side, strategie: pos.strategie, nettoPct, bruttoPct,
                      dauerKerzen: i - pos.iEntry, grund, t: c[i].t });
        pos = null;
      }
    }

    // ── Neue Position eröffnen ──
    if (!pos) {
      const adxWert = sig.adx[i];
      const trendPhase = cfg.momentum && adxWert != null && adxWert >= cfg.momentumAdx;
      let side = null, strategie = null;

      if (trendPhase) {
        const volOk = sig.momVol[i] >= cfg.momVolMult;
        const body = sig.momBody[i];
        if (volOk && body >= cfg.momBodyPct) { side = "long"; strategie = "momentum"; }
        else if (volOk && body <= -cfg.momBodyPct && cfg.shorts) { side = "short"; strategie = "momentum"; }
      } else {
        const wollLong = sig.bull[i] >= cfg.minVotes;
        const wollShort = cfg.shorts && sig.bear[i] >= cfg.minVotes;
        if (wollLong || wollShort) {
          const wunsch = wollLong ? "long" : "short";
          const richtung = wunsch === "long" ? 1 : -1;
          let erlaubt = true;
          if (cfg.trendFilter) {
            const et = sig.ema[i], vw = sig.vwap[i];
            if (cfg.trendStrict ? et !== richtung : et === -richtung) erlaubt = false;
            else if (vw === -richtung) erlaubt = false;
            else if (adxWert != null && et !== 0 && et !== richtung && adxWert >= cfg.adxMax) erlaubt = false;
          }
          if (erlaubt) { side = wunsch; strategie = "oszillator"; }
        }
      }

      if (side) {
        const atrAktiv = cfg.atrStop && sig.atr[i] > 0 &&
          (cfg.atrScope === "all" || strategie === cfg.atrScope);
        pos = { side, strategie, entry: price, iEntry: i, peakPnl: 0, peakPrice: price,
                slPrice: null, tpPrice: null, atrAbs: null };
        if (atrAktiv) {
          const a = sig.atr[i];
          pos.atrAbs = a;
          pos.slPrice = side === "short" ? price + a * cfg.atrMult : price - a * cfg.atrMult;
          pos.tpPrice = side === "short" ? price - a * cfg.atrTpMult : price + a * cfg.atrTpMult;
        }
      }
    }
  }
  return trades;
}

module.exports = { aggregiere, berechneSignale, simuliere, adxSerie, atrSerie, emaTrendSerie, vwapSideSerie };
