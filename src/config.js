// src/config.js – zentrale Konfiguration, alles per Env-Variable übersteuerbar.
// Konsolidiert am 2026-07-17: vorher gab es mehrere Duplikate mit unterschiedlichen
// Defaults (SOLANA_ADDRESS/LIVE_TRADING/LIVE_CHAINS je 3x, SELL_SLIPPAGE_BPS 3x
// widersprüchlich, MAX_DAILY_LOSS_USD wurde gesetzt aber NIE gelesen). Jetzt: ein
// Schlüssel = eine Definition. Alte Env-Namen bleiben als Fallback gültig, damit
// bereits in Railway gesetzte Variablen nicht plötzlich wirkungslos werden.
const n = (v, d) => (v != null && v !== "" && !isNaN(+v) ? +v : d);
const b = (v, d) => (v == null || v === "" ? d : String(v).toLowerCase() === "true");
const first = (...vals) => vals.find(v => v != null && v !== "");

// Positionsgrößen: beide Env-Namen (POS_USD_* und POSITION_USD_*) werden akzeptiert.
const POS_SOL = n(first(process.env.POS_USD_SOLANA, process.env.POSITION_USD_SOLANA), 5);
const POS_BSC = n(first(process.env.POS_USD_BSC, process.env.POSITION_USD_BSC), 10);
// Tageslimit: beide Env-Namen (DAILY_LOSS_LIMIT_USD und MAX_DAILY_LOSS_USD) werden akzeptiert.
const DAILY_LOSS = n(first(process.env.DAILY_LOSS_LIMIT_USD, process.env.MAX_DAILY_LOSS_USD), 15);

module.exports = {
  // ── Paper-Trading ──
  POSITION_USD:      n(process.env.POSITION_USD, 50),
  TAKE_PROFIT_PCT:   n(process.env.TAKE_PROFIT_PCT, 30),
  STOP_LOSS_PCT:     n(process.env.STOP_LOSS_PCT, -20),
  TIME_LIMIT_MIN:    n(process.env.TIME_LIMIT_MIN, 30),
  MAX_OPEN_POSITIONS:n(process.env.MAX_OPEN_POSITIONS, 10),

  // ── Friktions-Simulation ──
  FRICTION:          b(process.env.FRICTION, true),
  FEE_PCT:           n(process.env.FEE_PCT, 0.5),
  SLIPPAGE_PCT:      n(process.env.SLIPPAGE_PCT, 2),
  ENTRY_DELAY_MIN_MS:n(process.env.ENTRY_DELAY_MIN_MS, 2000),
  ENTRY_DELAY_MAX_MS:n(process.env.ENTRY_DELAY_MAX_MS, 8000),
  SOURCE_QUOTA:      b(process.env.SOURCE_QUOTA, false),

  // ── Pump.fun-Filter ──
  MAX_DEV_BUY_SOL:   n(process.env.MAX_DEV_BUY_SOL, 3),
  MIN_DEV_BUY_SOL:   n(process.env.MIN_DEV_BUY_SOL, 0.1),
  REQUIRE_GOPLUS:    b(process.env.REQUIRE_GOPLUS, false),

  // ── Entry-Gate ──
  OBS_MAX_TRADES:    n(process.env.OBS_MAX_TRADES, 10),
  OBS_MAX_SEC:       n(process.env.OBS_MAX_SEC, 45),
  OBS_MIN_TRADES:    n(process.env.OBS_MIN_TRADES, 4),
  MAX_BURST_3S:      n(process.env.MAX_BURST_3S, 5),
  MIN_UNIQUE_RATIO:  n(process.env.MIN_UNIQUE_RATIO, 0.6),
  MAX_TOP_WALLET_SHARE: n(process.env.MAX_TOP_WALLET_SHARE, 0.5),
  MAX_TOP_HOLDERS_PCT:  n(process.env.MAX_TOP_HOLDERS_PCT, 70),

  // ── GeckoTerminal-Filter ──
  GT_NETWORKS:       ["solana", "base", "eth", "bsc", "arbitrum"],
  MAX_AGE_MIN:       n(process.env.MAX_AGE_MIN, 30),
  MIN_LIQ_USD:       n(process.env.MIN_LIQ_USD, 5000),
  MIN_LP_LOCK_PCT:   n(process.env.MIN_LP_LOCK_PCT, 50),
  MAX_CREATOR_PCT:   n(process.env.MAX_CREATOR_PCT, 10),
  MAX_SELL_TAX_PCT:  n(process.env.MAX_SELL_TAX_PCT, 10),
  GT_POLL_SEC:       n(process.env.GT_POLL_SEC, 60),
  PRICE_POLL_SEC:    n(process.env.PRICE_POLL_SEC, 30),

  // ── Live-Executor: Kern ──
  SOLANA_ADDRESS:    process.env.SOLANA_ADDRESS || "",
  SOLANA_PRIVATE_KEY:process.env.SOLANA_PRIVATE_KEY || "",
  BSC_PRIVATE_KEY:   process.env.BSC_PRIVATE_KEY || "",
  LIVE_TRADING:      b(process.env.LIVE_TRADING, false),
  DRY_RUN:           b(process.env.DRY_RUN, true),
  ONE_TRADE_TEST:    b(process.env.ONE_TRADE_TEST, true),
  LIVE_CHAINS:       (process.env.LIVE_CHAINS || "solana,bsc").split(",").map(s => s.trim()),
  SOL_RPC:           process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com",
  BSC_RPC:           process.env.BSC_RPC || "https://bsc-dataseed.binance.org",

  // ── Live-Executor: Positionsgröße & Slots ──
  POS_USD_SOLANA:    POS_SOL,
  POS_USD_BSC:       POS_BSC,
  POSITION_USD_SOLANA: POS_SOL,
  POSITION_USD_BSC:  POS_BSC,
  MAX_SLOTS_SOLANA:  n(process.env.MAX_SLOTS_SOLANA, 8),
  MAX_SLOTS_BSC:     n(process.env.MAX_SLOTS_BSC, 3),

  // ── Live-Executor: Slippage ──
  ENTRY_SLIPPAGE_BPS:n(process.env.ENTRY_SLIPPAGE_BPS, 300),
  EXIT_SLIPPAGE_BPS: n(process.env.EXIT_SLIPPAGE_BPS, 1500),
  BUY_SLIPPAGE_BPS:  n(process.env.BUY_SLIPPAGE_BPS, 800),
  SELL_SLIPPAGE_BPS: n(process.env.SELL_SLIPPAGE_BPS, 1500),

  // ── Live-Executor: Exit-Robustheit ──
  SELL_RETRIES:      n(process.env.SELL_RETRIES, 5),
  SELL_FAIL_LIMIT:   n(process.env.SELL_FAIL_LIMIT, 3),
  SELL_GATE:         b(process.env.SELL_GATE, true),
  MAX_ROUNDTRIP_LOSS_PCT: n(process.env.MAX_ROUNDTRIP_LOSS_PCT, 30),
  BLOCK_MINT_AUTHORITY: b(process.env.BLOCK_MINT_AUTHORITY, true),
  TRAILING:          b(process.env.TRAILING, true),
  TRAIL_ARM_PCT:     n(process.env.TRAIL_ARM_PCT, 5),
  TRAIL_STEP_PCT:    n(process.env.TRAIL_STEP_PCT, 5),
  WATCHDOG_SEC:      n(process.env.WATCHDOG_SEC, 10),

  // ── Live-Executor: Risiko ──
  DAILY_LOSS_LIMIT_USD: DAILY_LOSS,
  MAX_DAILY_LOSS_USD:   DAILY_LOSS,
  PRIORITY_FEE_LAMPORTS: n(process.env.PRIORITY_FEE_LAMPORTS, 200000),

  // ── Indikator-Engine (Paper, Top-Coins, 15m) ──
  INDI_ENABLED:      b(process.env.INDI_ENABLED, true),
  INDI_START_USD:    n(process.env.INDI_START_USD, 1000),
  INDI_POS_USD:      n(process.env.INDI_POS_USD, 100),      // fester Einsatz je Position ($) – nur wenn INDI_POS_PCT = 0
  INDI_POS_PCT:      n(process.env.INDI_POS_PCT, 0),        // Einsatz als % des Gesamtkapitals (>0 überschreibt INDI_POS_USD; erzeugt Zinseszins)
  INDI_MAX_POS:      n(process.env.INDI_MAX_POS, 5),
  INDI_TOP_N:        n(process.env.INDI_TOP_N, 50),         // Top-N liquideste Coins nach 24h-Volumen
  INDI_MIN_VOTES:    n(process.env.INDI_MIN_VOTES, 4),
  INDI_TP_PCT:       n(process.env.INDI_TP_PCT, 5),
  INDI_SL_PCT:       n(process.env.INDI_SL_PCT, -3),
  INDI_TRAIL_ARM:    n(process.env.INDI_TRAIL_ARM, 2),
  INDI_TRAIL_STEP:   n(process.env.INDI_TRAIL_STEP, 1),
  INDI_HEARTBEAT:    b(process.env.INDI_HEARTBEAT, true),   // stündliches Lebenszeichen an Telegram
  INDI_HEARTBEAT_MIN:n(process.env.INDI_HEARTBEAT_MIN, 60), // Intervall in Minuten
  INDI_SOURCE:       process.env.INDI_SOURCE || "binance-vision", // binance | binance-vision | bybit | okx
  INDI_SHORTS:       b(process.env.INDI_SHORTS, false),    // Short-Trades zusätzlich zu Longs (getrennt ausgewertet)
  INDI_TREND_FILTER: b(process.env.INDI_TREND_FILTER, false), // EMA/VWAP/ADX als Richtungs-Gate über den Oszillatoren
  INDI_TREND_STRICT: b(process.env.INDI_TREND_STRICT, false), // true: EMA muss aktiv PRO Richtung sein; false: darf nur nicht dagegen sein
  INDI_ADX_MAX:      n(process.env.INDI_ADX_MAX, 30),      // ab diesem ADX keine Gegen-Trend-Trades mehr
  // ── Momentum-Strategie (ADX-Weiche: hoher ADX -> Momentum statt Oszillatoren) ──
  INDI_MOMENTUM:     b(process.env.INDI_MOMENTUM, false),  // Momentum-Strategie in Trendphasen aktivieren
  INDI_MOMENTUM_ADX: n(process.env.INDI_MOMENTUM_ADX, 30), // ab diesem ADX gilt "Trendphase" -> Momentum
  INDI_MOM_BODY_PCT: n(process.env.INDI_MOM_BODY_PCT, 2),  // Mindest-Kerzensprung in % für Ausbruch
  INDI_MOM_VOL_MULT: n(process.env.INDI_MOM_VOL_MULT, 2),  // Volumen muss X-fachen des Schnitts erreichen
  INDI_FEES:         b(process.env.INDI_FEES, true),       // Gebühren realistisch in die Bilanz einrechnen
  INDI_FEE_PCT:      n(process.env.INDI_FEE_PCT, 0.1),     // Handelsgebühr je Seite in % (Binance/Bybit Spot ~0.1)
  INDI_FUNDING_PCT:  n(process.env.INDI_FUNDING_PCT, 0.01),// Funding je 8h für Shorts in %
  INDI_LEVERAGE:     n(process.env.INDI_LEVERAGE, 1),      // Hebel (1 = Spot ungehebelt, 2 = 2x, ...)

  // ── Ruhemodus ──
  NOTIFY_PAPER:      b(process.env.NOTIFY_PAPER, false),
  LOG_SIGNALS:       b(process.env.LOG_SIGNALS, false),
  LOG_PAPER:         b(process.env.LOG_PAPER, false),

  // ── Push / Stats-HTTP ──
  MAX_PUSH_PER_HOUR: n(process.env.MAX_PUSH_PER_HOUR, 12),
  PORT:              n(process.env.PORT, 8080),
  STATS_TOKEN:       process.env.STATS_TOKEN || "",
};
