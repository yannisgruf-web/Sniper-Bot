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

  // Friktions-Simulation (realistische Kosten im Paper-Trading)
  FRICTION:          b(process.env.FRICTION, true),        // false = alter friktionsloser Modus
  FEE_PCT:           n(process.env.FEE_PCT, 0.5),          // DEX-Gebühr je Seite in %
  SLIPPAGE_PCT:      n(process.env.SLIPPAGE_PCT, 2),       // Slippage je Seite in %
  ENTRY_DELAY_MIN_MS:n(process.env.ENTRY_DELAY_MIN_MS, 2000),  // Reaktionszeit min
  ENTRY_DELAY_MAX_MS:n(process.env.ENTRY_DELAY_MAX_MS, 8000),  // Reaktionszeit max
  SOURCE_QUOTA:      b(process.env.SOURCE_QUOTA, false), // true = max. halbe Slots je Quelle

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

  // ── LIVE-EXECUTOR ──
  SOLANA_ADDRESS:     process.env.SOLANA_ADDRESS || "",
  LIVE_TRADING:      b(process.env.LIVE_TRADING, false),   // Hauptschalter: false = reines Paper
  DRY_RUN:           b(process.env.DRY_RUN, true),         // true = alles außer finalem Signieren
  ONE_TRADE_TEST:    b(process.env.ONE_TRADE_TEST, true),  // nach 1 echtem Trade automatisch stoppen
  POS_USD_SOLANA:    n(process.env.POS_USD_SOLANA, 5),     // Positionsgröße Solana
  POS_USD_BSC:       n(process.env.POS_USD_BSC, 10),       // Positionsgröße BSC
  ENTRY_SLIPPAGE_BPS:n(process.env.ENTRY_SLIPPAGE_BPS, 300),  // 3% Kauf-Toleranz
  EXIT_SLIPPAGE_BPS: n(process.env.EXIT_SLIPPAGE_BPS, 1500),  // 15% Verkauf-Toleranz (raus kommen!)
  DAILY_LOSS_STOP_USD:n(process.env.DAILY_LOSS_STOP_USD, 6),  // Tagesverlust-Limit -> Selbstabschaltung
  LIVE_CHAINS:       (process.env.LIVE_CHAINS || "solana,bsc").split(","),
  SOL_RPC:           process.env.HELIUS_RPC_URL || "https://api.mainnet-beta.solana.com",
  BSC_RPC:           process.env.BSC_RPC || "https://bsc-dataseed.binance.org",

  // ── Live-Trading (Executor) ──
  SOLANA_ADDRESS:     process.env.SOLANA_ADDRESS || "",
  LIVE_TRADING:      b(process.env.LIVE_TRADING, false),   // Hauptschalter. false = reines Paper.
  POS_USD_SOLANA:    n(process.env.POS_USD_SOLANA, 5),
  POS_USD_BSC:       n(process.env.POS_USD_BSC, 10),
  MAX_SLOTS_SOLANA:  n(process.env.MAX_SLOTS_SOLANA, 8),
  MAX_SLOTS_BSC:     n(process.env.MAX_SLOTS_BSC, 3),
  BUY_SLIPPAGE_BPS:  n(process.env.BUY_SLIPPAGE_BPS, 800),   // 8% Kauf-Toleranz
  SELL_SLIPPAGE_BPS: n(process.env.SELL_SLIPPAGE_BPS, 2000), // 20% Verkauf-Toleranz (raus kommen!)
  SELL_RETRIES:      n(process.env.SELL_RETRIES, 5),
  SELL_FAIL_LIMIT:   n(process.env.SELL_FAIL_LIMIT, 3),   // nach 3 gescheiterten Verkaufs-RUNDEN (Watchdog) -> Rug, Totalverlust buchen
  SELL_GATE:         b(process.env.SELL_GATE, true),        // Verkäuflichkeits-Prüfung VOR jedem echten Kauf (Solana)
  MAX_ROUNDTRIP_LOSS_PCT: n(process.env.MAX_ROUNDTRIP_LOSS_PCT, 30), // sofortiger Kauf+Verkauf dürfte max. 30% kosten
  BLOCK_MINT_AUTHORITY: b(process.env.BLOCK_MINT_AUTHORITY, true),   // Tokens mit aktiver Mint-Authority ablehnen
  DAILY_LOSS_LIMIT_USD: n(process.env.DAILY_LOSS_LIMIT_USD, 15), // dann Auto-Stopp bis Folgetag
  LIVE_CHAINS:       (process.env.LIVE_CHAINS || "solana,bsc").split(",").map(s=>s.trim()),
  PRIORITY_FEE_LAMPORTS: n(process.env.PRIORITY_FEE_LAMPORTS, 200000),

  // Ruhemodus: Paper läuft intern weiter (steuert die Live-Exits!), meldet aber nichts.
  NOTIFY_PAPER:      b(process.env.NOTIFY_PAPER, false),  // Telegram für Paper-Signale/-Exits
  LOG_SIGNALS:       b(process.env.LOG_SIGNALS, false),   // SIGNAL/GESPERRT-Zeilen im Log
  LOG_PAPER:         b(process.env.LOG_PAPER, false),     // [PAPER OPEN]/[PAPER CLOSE] im Log

  // Push
  MAX_PUSH_PER_HOUR: n(process.env.MAX_PUSH_PER_HOUR, 12),

  // Stats-HTTP
  PORT:              n(process.env.PORT, 8080),
  STATS_TOKEN:       process.env.STATS_TOKEN || "",

  // ── LIVE-TRADING ──
  SOLANA_ADDRESS:     process.env.SOLANA_ADDRESS || "",
  LIVE_TRADING:      b(process.env.LIVE_TRADING, false),   // Hauptschalter: false = nur Paper
  SOLANA_PRIVATE_KEY:process.env.SOLANA_PRIVATE_KEY || "",
  BSC_PRIVATE_KEY:   process.env.BSC_PRIVATE_KEY || "",
  POSITION_USD_SOLANA:n(process.env.POSITION_USD_SOLANA, 5),
  POSITION_USD_BSC:  n(process.env.POSITION_USD_BSC, 10),
  MAX_DAILY_LOSS_USD:n(process.env.MAX_DAILY_LOSS_USD, 15), // Tagesverlust-Limit -> Selbstabschaltung
  BUY_SLIPPAGE_BPS:  n(process.env.BUY_SLIPPAGE_BPS, 800),  // 800 = 8% max. Kauf-Slippage
  SELL_SLIPPAGE_BPS: n(process.env.SELL_SLIPPAGE_BPS, 1500),// 1500 = 15% beim Verkauf (raus wollen)
  LIVE_CHAINS:       (process.env.LIVE_CHAINS || "solana,bsc").split(",").map(s=>s.trim())
};
