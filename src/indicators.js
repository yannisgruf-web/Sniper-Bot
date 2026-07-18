// src/indicators.js – reine Mathematik auf Kerzendaten. Kerze: {o,h,l,c,v}
// Alle Funktionen liefern Zeitreihen (Arrays gleicher Länge, führend mit null).

function sma(vals, len) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= len) sum -= vals[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function ema(vals, len) {
  const out = new Array(vals.length).fill(null);
  const k = 2 / (len + 1);
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] == null) continue;
    prev = prev == null ? vals[i] : vals[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// RSI nach Wilder
function rsi(closes, len = 14) {
  const out = new Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) { gain += g; loss += l; if (i === len) { gain /= len; loss /= len; out[i] = 100 - 100 / (1 + (loss === 0 ? 1e9 : gain / loss)); } }
    else {
      gain = (gain * (len - 1) + g) / len;
      loss = (loss * (len - 1) + l) / len;
      out[i] = 100 - 100 / (1 + (loss === 0 ? 1e9 : gain / loss));
    }
  }
  return out;
}

// Money Flow Index
function mfi(candles, len = 14) {
  const out = new Array(candles.length).fill(null);
  const tp = candles.map(k => (k.h + k.l + k.c) / 3);
  const pos = [], neg = [];
  for (let i = 1; i < candles.length; i++) {
    const raw = tp[i] * candles[i].v;
    pos.push(tp[i] > tp[i - 1] ? raw : 0);
    neg.push(tp[i] < tp[i - 1] ? raw : 0);
    if (pos.length > len) { pos.shift(); neg.shift(); }
    if (pos.length === len) {
      const p = pos.reduce((a, b) => a + b, 0), n = neg.reduce((a, b) => a + b, 0);
      out[i] = n === 0 ? 100 : 100 - 100 / (1 + p / n);
    }
  }
  return out;
}

// Stochastic RSI: %K und %D
function stochRsi(closes, rsiLen = 14, stochLen = 14, kSmooth = 3, dSmooth = 3) {
  const r = rsi(closes, rsiLen);
  const rawK = new Array(closes.length).fill(null);
  for (let i = 0; i < r.length; i++) {
    if (r[i] == null) continue;
    const win = r.slice(Math.max(0, i - stochLen + 1), i + 1).filter(x => x != null);
    if (win.length < stochLen) continue;
    const hi = Math.max(...win), lo = Math.min(...win);
    rawK[i] = hi === lo ? 50 : ((r[i] - lo) / (hi - lo)) * 100;
  }
  const k = smaSkipNull(rawK, kSmooth);
  const d = smaSkipNull(k, dSmooth);
  return { k, d };
}
function smaSkipNull(vals, len) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) {
    const win = vals.slice(Math.max(0, i - len + 1), i + 1);
    if (win.some(x => x == null) || win.length < len) continue;
    out[i] = win.reduce((a, b) => a + b, 0) / len;
  }
  return out;
}

// MACD 12/26/9
function macd(closes, fast = 12, slow = 26, sig = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null && i >= slow - 1) ? ef[i] - es[i] : null);
  const signal = ema(line.map(x => x), sig).map((x, i) => line[i] == null ? null : x);
  const hist = line.map((x, i) => (x != null && signal[i] != null) ? x - signal[i] : null);
  return { line, signal, hist };
}

// TTM Squeeze: Bollinger(20,2) in Keltner(20,1.5*ATR) + Momentum (LinReg-Fit)
function ttmSqueeze(candles, len = 20, bbMult = 2, kcMult = 1.5) {
  const closes = candles.map(k => k.c);
  const basis = sma(closes, len);
  const on = new Array(candles.length).fill(null);
  const momo = new Array(candles.length).fill(null);
  // ATR (einfacher gleitender Schnitt der True Range)
  const tr = candles.map((k, i) => i === 0 ? k.h - k.l :
    Math.max(k.h - k.l, Math.abs(k.h - candles[i - 1].c), Math.abs(k.l - candles[i - 1].c)));
  const atr = sma(tr, len);
  for (let i = len - 1; i < candles.length; i++) {
    const win = closes.slice(i - len + 1, i + 1);
    const mean = basis[i];
    const sd = Math.sqrt(win.reduce((s, x) => s + (x - mean) ** 2, 0) / len);
    on[i] = (mean + bbMult * sd) < (mean + kcMult * atr[i]) && (mean - bbMult * sd) > (mean - kcMult * atr[i]);
    // Momentum: LinReg-Endwert von close - Mittel aus Donchian-Mitte und SMA
    const hh = Math.max(...candles.slice(i - len + 1, i + 1).map(k => k.h));
    const ll = Math.min(...candles.slice(i - len + 1, i + 1).map(k => k.l));
    const mid = ((hh + ll) / 2 + mean) / 2;
    const ys = closes.slice(i - len + 1, i + 1).map(c => c - mid);
    momo[i] = linregLast(ys);
  }
  return { on, momo };
}
function linregLast(ys) {
  const n = ys.length;
  const xs = [...Array(n).keys()];
  const mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = num / den, icept = my - slope * mx;
  return slope * (n - 1) + icept;
}

// Premier Stochastic Oscillator (Leibfarth): doppelt EMA-geglätteter, normierter %K
function premierStoch(candles, stochLen = 8, smoothLen = 5) {
  const rawK = new Array(candles.length).fill(null);
  for (let i = stochLen - 1; i < candles.length; i++) {
    const win = candles.slice(i - stochLen + 1, i + 1);
    const hi = Math.max(...win.map(k => k.h)), lo = Math.min(...win.map(k => k.l));
    rawK[i] = hi === lo ? 50 : ((candles[i].c - lo) / (hi - lo)) * 100;
  }
  const nsk = rawK.map(k => k == null ? null : 0.1 * (k - 50));
  const s = ema(ema(nsk.filter(x => x != null), smoothLen), smoothLen);
  // zurück auf volle Länge mappen
  const out = new Array(candles.length).fill(null);
  let j = 0;
  for (let i = 0; i < candles.length; i++) if (nsk[i] != null) { const v = s[j++]; out[i] = v == null ? null : (Math.exp(v) - 1) / (Math.exp(v) + 1); }
  return out;
}

// Pivot-basierte RSI-Divergenz im Rückblick: +1 bullisch, -1 bärisch, 0 keine
function rsiDivergence(candles, rsiVals, lookback = 40, pivotWin = 3) {
  const n = candles.length;
  const from = Math.max(pivotWin, n - lookback);
  const isPivotLow = i => {
    for (let d = 1; d <= pivotWin; d++)
      if (!(candles[i].l < candles[i - d]?.l && candles[i].l < candles[i + d]?.l)) return false;
    return true;
  };
  const isPivotHigh = i => {
    for (let d = 1; d <= pivotWin; d++)
      if (!(candles[i].h > candles[i - d]?.h && candles[i].h > candles[i + d]?.h)) return false;
    return true;
  };
  const lows = [], highs = [];
  for (let i = from; i < n - pivotWin; i++) {
    if (rsiVals[i] == null) continue;
    if (isPivotLow(i)) lows.push(i);
    if (isPivotHigh(i)) highs.push(i);
  }
  if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    if (candles[b].l < candles[a].l && rsiVals[b] > rsiVals[a]) return 1;    // bullische Divergenz
  }
  if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    if (candles[b].h > candles[a].h && rsiVals[b] < rsiVals[a]) return -1;   // bärische Divergenz
  }
  return 0;
}

// Fibonacci-Retracement über den jüngsten Swing (höchstes Hoch / tiefstes Tief
// im Lookback). Golden Pocket = Zone zwischen 0.618 und 0.65 Retracement.
// In einem Aufwärts-Swing (Tief -> Hoch) ist ein Rücksetzer in diese Zone ein
// klassisches bullisches Long-Setup. Rückgabe: 1 wenn aktueller Preis im Golden
// Pocket eines Aufwärts-Swings liegt, sonst 0.
function fibGoldenPocket(candles, lookback = 60) {
  const n = candles.length;
  if (n < 10) return { inPocket: 0 };
  const win = candles.slice(Math.max(0, n - lookback));
  let hiIdx = 0, loIdx = 0;
  for (let i = 0; i < win.length; i++) {
    if (win[i].h > win[hiIdx].h) hiIdx = i;
    if (win[i].l < win[loIdx].l) loIdx = i;
  }
  const hi = win[hiIdx].h, lo = win[loIdx].l;
  if (hi <= lo) return { inPocket: 0 };
  // Nur werten, wenn das Tief VOR dem Hoch liegt -> es war ein Aufwärts-Swing,
  // und der Preis kommt jetzt zurück (gesunder Pullback, kein Abwärtstrend).
  if (loIdx >= hiIdx) return { inPocket: 0 };
  const price = candles[n - 1].c;
  const range = hi - lo;
  const level618 = hi - range * 0.618;
  const level650 = hi - range * 0.65;
  // Golden Pocket liegt zwischen level650 (unten) und level618 (oben)
  const inPocket = (price <= level618 && price >= level650) ? 1 : 0;
  const retracePct = ((hi - price) / range) * 100;
  return { inPocket, hi, lo, level618, level650, retracePct: +retracePct.toFixed(1) };
}

module.exports = { sma, ema, rsi, mfi, stochRsi, macd, ttmSqueeze, premierStoch, rsiDivergence, fibGoldenPocket };
