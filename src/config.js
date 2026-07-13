// src/config.js – zentrale Konfiguration, alles per Env-Variable übersteuerbar
const n = (v, d) => (v != null && v !== "" && !isNaN(+v) ? +v : d);
const b = (v, d) => (v == null || v === "" ? d : String(v).toLowerCase() === "true");

module.exports = {
  // Paper-Trading
  POSITION_USD:      n(process.env.POSITION_USD, 50),      // fiktive Positionsgröße
  TAKE_PROFIT_PCT:   n(process.env.TAKE_PROFIT_PCT, 30),   // Exit bei +30%
  STOP_LOSS_PCT:     n(process.env.STOP_LOSS_PCT, -20),    // Exit bei -20%
  TIME_LIMIT_MIN:    n(process.env.TIME_LIMIT_MIN, 30),    // Exit spätestens nach 30 Min
  MAX_OPEN_POSITIONS:n(process.env.MAX_OPEN_POSITIONS, 10),

  // Pump.fun-Filter (Solana, sekundenschnell)
  MAX_DEV_BUY_SOL:   n(process.env.MAX_DEV_BUY_SOL, 3),    // Dev-Erstkauf > 3 SOL = Dump-Risiko
  MIN_DEV_BUY_SOL:   n(process.env.MIN_DEV_BUY_SOL, 0.1),  // < 0.1 SOL = kein Skin-in-the-Game
  REQUIRE_GOPLUS:    b(process.env.REQUIRE_GOPLUS, false), // true = nur Coins MIT GoPlus-Daten (streng, wenige Treffer)

  // Entry-Gate (Beobachtungsfenster vor dem Einstieg, pump.fun)
  OBS_MAX_TRADES:    n(process.env.OBS_MAX_TRADES, 10),   // nach 10 Käufen auswerten …
  OBS_MAX_SEC:       n(process.env.OBS_MAX_SEC, 45),      // … oder spätestens nach 45s
  OBS_MIN_TRADES:    n(process.env.OBS_MIN_TRADES, 4),    // unter 4 Käufen: kein Einstieg
  MAX_BURST_3S:      n(process.env.MAX_BURST_3S, 5),      // >=5 Käufe in 3s = Bundle
  MIN_UNIQUE_RATIO:  n(process.env.MIN_UNIQUE_RATIO, 0.6),// <60% einzigartige Käufer = Wash
  MAX_TOP_WALLET_SHARE: n(process.env.MAX_TOP_WALLET_SHARE, 0.5), // eine Wallet >50% Volumen
  MAX_TOP_HOLDERS_PCT:  n(process.env.MAX_TOP_HOLDERS_PCT, 70),   // Top-5 halten >70% Umlauf

  // GeckoTerminal-Filter (EVM-Chains + Solana-DEX-Pools)
  GT_NETWORKS:       ["solana", "base", "eth", "bsc", "arbitrum"],
  MAX_AGE_MIN:       n(process.env.MAX_AGE_MIN, 30),       // nur Pools jünger als 30 Min
  MIN_LIQ_USD:       n(process.env.MIN_LIQ_USD, 5000),
  MIN_LP_LOCK_PCT:   n(process.env.MIN_LP_LOCK_PCT, 50),   // EVM: LP-Lock unter 50% = raus (wenn Daten da)
  MAX_CREATOR_PCT:   n(process.env.MAX_CREATOR_PCT, 10),
  MAX_SELL_TAX_PCT:  n(process.env.MAX_SELL_TAX_PCT, 10),
  GT_POLL_SEC:       n(process.env.GT_POLL_SEC, 60),
  PRICE_POLL_SEC:    n(process.env.PRICE_POLL_SEC, 30),

  // Push
  MAX_PUSH_PER_HOUR: n(process.env.MAX_PUSH_PER_HOUR, 12),

  // Stats-HTTP
  PORT:              n(process.env.PORT, 8080),
  STATS_TOKEN:       process.env.STATS_TOKEN || ""
};
