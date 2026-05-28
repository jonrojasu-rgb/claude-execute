/**
 * Claude + SMC — Automated Trading Bot
 *
 * Smart Money Concepts strategy: daily bias → 4H order block / FVG → 1H CHoCH entry.
 * Market data: Binance public API (free, no auth).
 * Execution: BitGet (spot or futures). Set PAPER_TRADING=true to log without placing orders.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const paperMode = process.env.PAPER_TRADING !== "false";
  const required = paperMode ? [] : ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — opening it for you to fill in...\n");
    writeFileSync(
      ".env",
      [
        "# BitGet credentials",
        "BITGET_API_KEY=",
        "BITGET_SECRET_KEY=",
        "BITGET_PASSPHRASE=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=2",
        "PAPER_TRADING=true",
        "SYMBOL=BTCUSDT",
        "",
        "# Telegram notifications (optional — leave blank to disable)",
        "# Bot token from @BotFather · Chat ID from @userinfobot",
        "TELEGRAM_BOT_TOKEN=",
        "TELEGRAM_CHAT_ID=",
      ].join("\n") + "\n",
    );
    try { execSync("open .env"); } catch {}
    console.log("Fill in your BitGet credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try { execSync("open .env"); } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(`   Open in Google Sheets or Excel any time — or tell Claude to move it:\n`);
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "2"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
  // SMC timeframe stack (fixed by strategy)
  biasFrame:    "1D",
  entryFrame:   "4H",
  confirmFrame: "1H",
  minScore: 4,
};

const LOG_FILE = "safety-check-log.json";

// ─── Timezone helpers (America/Panama — UTC-5, no DST) ────────────────────────

const TIMEZONE = "America/Panama";

function toPanamaDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(date);
}

function toPanamaTime(date = new Date()) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = toPanamaDate();
  return log.trades.filter((t) => toPanamaDate(new Date(t.timestamp)) === today && t.orderPlaced).length;
}

// ─── Market Data (Bybit public API — free, no auth) ──────────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
    "1H": "60", "4H": "240", "1D": "D", "1W": "W",
  };
  const bybitInterval = intervalMap[interval] || "1";
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bybit API error: ${res.status}`);
  const data = await res.json();
  if (data.retCode !== 0) throw new Error(`Bybit API error: ${data.retMsg}`);
  return data.result.list.reverse().map((k) => ({
    time: parseInt(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

// ─── SMC Indicators ──────────────────────────────────────────────────────────

function calcSMMA(closes, period) {
  if (closes.length < period) return null;
  let smma = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    smma = (smma * (period - 1) + closes[i]) / period;
  }
  return smma;
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = candles.slice(1).map((c, i) => {
    const prev = candles[i];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });
  return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// Pivot swing highs and lows using a symmetric lookback window
function findSwings(candles, lookback = 5) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const curHigh = candles[i].high;
    const curLow  = candles[i].low;
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= curHigh) isHigh = false;
      if (candles[j].low  <= curLow)  isLow  = false;
    }
    if (isHigh) highs.push({ price: curHigh, time: candles[i].time, index: i });
    if (isLow)  lows.push ({ price: curLow,  time: candles[i].time, index: i });
  }
  return { highs, lows };
}

// Break of structure direction: 'bullish' | 'bearish' | 'neutral'
function bosDirection(swings) {
  const { highs, lows } = swings;
  if (highs.length < 2 || lows.length < 2) return "neutral";
  const [ph1, ph2] = highs.slice(-2);
  const [pl1, pl2] = lows.slice(-2);
  if (ph2.price > ph1.price && pl2.price > pl1.price) return "bullish";
  if (ph2.price < ph1.price && pl2.price < pl1.price) return "bearish";
  return "neutral";
}

// ─── Daily Bias ──────────────────────────────────────────────────────────────

function detectDailyBias(candles) {
  const closes   = candles.map((c) => c.close);
  const smma21   = calcSMMA(closes, 21);
  const smma21p  = calcSMMA(closes.slice(0, -5), 21);
  const slope    = smma21p ? ((smma21 - smma21p) / smma21p) * 100 : 0;
  const flat     = Math.abs(slope) < 0.3;
  const price    = closes[closes.length - 1];
  const above    = price > smma21;
  const swings   = findSwings(candles, 3);
  const structure = bosDirection(swings);

  let bias = "neutral";
  if (!flat && above   && structure === "bullish") bias = "bullish";
  if (!flat && !above  && structure === "bearish") bias = "bearish";

  return { bias, smma21, slope, flat, price, above, structure, swings };
}

// ─── 4H Structure ────────────────────────────────────────────────────────────

function detectH4Structure(candles) {
  const closes  = candles.map((c) => c.close);
  const smma50  = calcSMMA(closes, 50);
  const price   = closes[closes.length - 1];
  const swings  = findSwings(candles, 5);
  const bosBias = bosDirection(swings);
  return { bosBias, smma50, aboveSMMA50: price > smma50, swings };
}

// ─── Order Block Detection ───────────────────────────────────────────────────

// Last opposite-colour candle immediately before a displacement candle (body ≥ 0.8×ATR).
// A block is invalidated if any subsequent close breaches its far edge.
function detectOrderBlocks(candles, direction, atr) {
  const threshold = atr * 0.8;
  const blocks = [];

  for (let i = 1; i < candles.length - 1; i++) {
    const cur  = candles[i];
    const next = candles[i + 1];
    const nextBody = Math.abs(next.close - next.open);

    if (direction === "bullish") {
      if (cur.close >= cur.open) continue;                      // must be bearish candle
      if (next.close <= next.open || nextBody < threshold) continue; // next must be bullish impulse
      const violated = candles.slice(i + 1).some((c) => c.close < cur.low);
      if (!violated) blocks.push({
        type: "bullish", high: cur.high, low: cur.low,
        mid: (cur.high + cur.low) / 2, time: cur.time, index: i,
      });
    } else {
      if (cur.close <= cur.open) continue;                      // must be bullish candle
      if (next.close >= next.open || nextBody < threshold) continue; // next must be bearish impulse
      const violated = candles.slice(i + 1).some((c) => c.close > cur.high);
      if (!violated) blocks.push({
        type: "bearish", high: cur.high, low: cur.low,
        mid: (cur.high + cur.low) / 2, time: cur.time, index: i,
      });
    }
  }

  return blocks.slice(-5);
}

// ─── Fair Value Gap Detection ────────────────────────────────────────────────

// 3-candle imbalance. A gap is mitigated when price closes through its near edge.
function detectFVGs(candles, direction) {
  const fvgs = [];

  for (let i = 0; i < candles.length - 2; i++) {
    const a = candles[i], c = candles[i + 2];

    if (direction === "bullish" && a.high < c.low) {
      const low = a.high, high = c.low;
      const mitigated = candles.slice(i + 2).some((x) => x.close < low);
      if (!mitigated) fvgs.push({
        type: "bullish", low, high, mid: (low + high) / 2,
        time: candles[i + 1].time, index: i + 1,
      });
    }

    if (direction === "bearish" && a.low > c.high) {
      const low = c.high, high = a.low;
      const mitigated = candles.slice(i + 2).some((x) => x.close > high);
      if (!mitigated) fvgs.push({
        type: "bearish", low, high, mid: (low + high) / 2,
        time: candles[i + 1].time, index: i + 1,
      });
    }
  }

  return fvgs.slice(-5);
}

// ─── Zone Match ───────────────────────────────────────────────────────────────

// Returns the first active zone (OBs preferred) that price is currently inside,
// with a 0.5% tolerance for price that is just entering from above/below.
function findActiveZone(price, obs, fvgs, direction) {
  const tol = 0.005;
  const inRange = (z) =>
    direction === "bullish"
      ? price >= z.low && price <= z.high * (1 + tol)
      : price >= z.low * (1 - tol) && price <= z.high;

  for (const ob  of obs.slice().reverse())  if (inRange(ob))  return { ...ob,  zoneType: "order_block" };
  for (const fvg of fvgs.slice().reverse()) if (inRange(fvg)) return { ...fvg, zoneType: "fvg" };
  return null;
}

// ─── Liquidity Sweep Detection ────────────────────────────────────────────────

// Detects a recent candle that wicked through a swing high/low and closed back the other side.
function detectLiquiditySweep(candles, swings, direction) {
  const recent = candles.slice(-8);

  if (direction === "bullish") {
    for (const sl of swings.lows.slice(-4).reverse()) {
      if (recent.some((c) => c.low < sl.price && c.close > sl.price))
        return { detected: true, type: "sell-side", level: sl.price };
    }
  } else {
    for (const sh of swings.highs.slice(-4).reverse()) {
      if (recent.some((c) => c.high > sh.price && c.close < sh.price))
        return { detected: true, type: "buy-side", level: sh.price };
    }
  }

  return { detected: false };
}

// ─── 1H CHoCH Detection ───────────────────────────────────────────────────────

// Change of character: a 1H close beyond the last confirmed swing high (bullish) or low (bearish).
function detect1HCHoCH(candles, direction) {
  const swings = findSwings(candles, 3);

  if (direction === "bullish") {
    const hs = swings.highs.slice(-2);
    if (hs.length < 2) return { confirmed: false };
    const lastHigh = hs[hs.length - 1];
    const confirmed = candles.slice(lastHigh.index + 1).some((c) => c.close > lastHigh.price);
    return { confirmed, price: lastHigh.price };
  }

  const ls = swings.lows.slice(-2);
  if (ls.length < 2) return { confirmed: false };
  const lastLow = ls[ls.length - 1];
  const confirmed = candles.slice(lastLow.index + 1).some((c) => c.close < lastLow.price);
  return { confirmed, price: lastLow.price };
}

// ─── Volume Metrics ───────────────────────────────────────────────────────────

function calcVolumeMetrics(candles) {
  if (candles.length < 25) return { displacement: false, decliningRetrace: false, ratio: 1 };
  const avgVol     = candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20;
  const maxRecent  = Math.max(...candles.slice(-5).map((c) => c.volume));
  const ratio      = maxRecent / avgVol;
  const last3      = candles.slice(-3).map((c) => c.volume);
  const decliningRetrace = last3[0] > last3[1] && last3[1] > last3[2];
  return { displacement: ratio >= 1.5, decliningRetrace, ratio };
}

// ─── SMC Analysis ─────────────────────────────────────────────────────────────

async function runSMCAnalysis(symbol) {
  console.log("\n── Fetching multi-timeframe data from Bybit ─────────────\n");

  const [dailyCandles, h4Candles, h1Candles] = await Promise.all([
    fetchCandles(symbol, "1D", 300),
    fetchCandles(symbol, "4H", 300),
    fetchCandles(symbol, "1H", 100),
  ]);

  const price = h4Candles[h4Candles.length - 1].close;
  const atr   = calcATR(h4Candles, 14);
  const daily = detectDailyBias(dailyCandles);
  const h4    = detectH4Structure(h4Candles);

  console.log(`  [1D] Price: $${price.toFixed(2)}  |  SMMA(21): $${daily.smma21?.toFixed(2)}  |  Slope: ${daily.slope.toFixed(2)}%`);
  console.log(`  [4H] ATR(14): $${atr?.toFixed(2)}  |  SMMA(50): $${h4.smma50?.toFixed(2)}`);
  console.log(`  [1D] Structure: ${daily.structure}  |  Bias: ${daily.bias.toUpperCase()}`);

  // Neutral daily bias — nothing to do
  if (daily.bias === "neutral") {
    return {
      conditions: [{
        label: "Daily bias", required: true, pass: false,
        actual: "NEUTRAL — SMMA flat or structure unclear", points: 2,
      }],
      allPass: false, score: 0, maxScore: 14, tier: "skip",
      price, atr, activeZone: null, daily, h4, direction: "neutral",
    };
  }

  const dir    = daily.bias;
  const h4OBs  = detectOrderBlocks(h4Candles, dir, atr);
  const h4FVGs = detectFVGs(h4Candles, dir);
  const zone   = findActiveZone(price, h4OBs, h4FVGs, dir);
  const atOB   = zone?.zoneType === "order_block";
  const atFVG  = zone?.zoneType === "fvg";
  const obFVGOverlap = atOB && h4FVGs.some((f) => f.low <= zone.high && f.high >= zone.low);

  const sweep  = detectLiquiditySweep(h4Candles, h4.swings, dir);
  const choch  = detect1HCHoCH(h1Candles, dir);
  const vol    = calcVolumeMetrics(h4Candles);
  const smma50AtZone = zone != null
    && h4.smma50 >= zone.low * 0.999
    && h4.smma50 <= zone.high * 1.001;

  const conditions = [
    {
      label:    `Daily bias ${dir.toUpperCase()} — SMMA(21) slope ${daily.slope.toFixed(2)}%, structure: ${daily.structure}`,
      required: true,
      pass:     true,
      actual:   `price ${daily.above ? "above" : "below"} SMMA(21) $${daily.smma21?.toFixed(0)}`,
      points:   2,
    },
    {
      label:    `4H BOS ${dir} confirmed`,
      required: true,
      pass:     h4.bosBias === dir,
      actual:   `4H structure: ${h4.bosBias}`,
      points:   1,
    },
    {
      label:    `Price at valid 4H order block`,
      required: false,
      pass:     atOB,
      actual:   atOB ? `OB $${zone.low.toFixed(0)}–$${zone.high.toFixed(0)}` : `no active OB (${h4OBs.length} found)`,
      points:   2,
    },
    {
      label:    `Price at 4H fair value gap`,
      required: false,
      pass:     atFVG,
      actual:   atFVG ? `FVG $${zone.low.toFixed(0)}–$${zone.high.toFixed(0)}` : `no active FVG (${h4FVGs.length} found)`,
      points:   1,
    },
    {
      label:    `OB + FVG overlap at zone`,
      required: false,
      pass:     obFVGOverlap,
      actual:   obFVGOverlap ? "OB and FVG overlap" : "no overlap",
      points:   1,
    },
    {
      label:    `Liquidity sweep into zone`,
      required: false,
      pass:     sweep.detected,
      actual:   sweep.detected ? `${sweep.type} sweep at $${sweep.level?.toFixed(0)}` : "no sweep detected",
      points:   2,
    },
    {
      label:    `1H CHoCH ${dir} confirmation`,
      required: true,
      pass:     choch.confirmed,
      actual:   choch.confirmed ? `CHoCH beyond $${choch.price?.toFixed(0)}` : "no 1H CHoCH",
      points:   2,
    },
    {
      label:    `Displacement candle volume ≥ 1.5× average`,
      required: false,
      pass:     vol.displacement,
      actual:   `${vol.ratio.toFixed(2)}× 20-period avg`,
      points:   1,
    },
    {
      label:    `Declining volume on retracement`,
      required: false,
      pass:     vol.decliningRetrace,
      actual:   vol.decliningRetrace ? "volume declining last 3 candles" : "volume not declining",
      points:   1,
    },
    {
      label:    `4H SMMA(50) confluent with zone`,
      required: false,
      pass:     smma50AtZone,
      actual:   `SMMA(50) $${h4.smma50?.toFixed(0)} ${smma50AtZone ? "inside" : "outside"} zone`,
      points:   1,
    },
  ];

  const requiredPass = conditions.filter((c) => c.required).every((c) => c.pass);
  const score    = conditions.filter((c) => c.pass).reduce((s, c) => s + c.points, 0);
  const maxScore = conditions.reduce((s, c) => s + c.points, 0);
  const tier     = score >= 10 ? "A" : score >= 7 ? "B" : score >= 4 ? "C" : "skip";
  const allPass  = requiredPass && tier !== "skip";

  return { conditions, allPass, score, maxScore, tier, price, atr, activeZone: zone, daily, h4, direction: dir };
}

// ─── Safety Check Print ───────────────────────────────────────────────────────

function printSMCCheck(conditions) {
  console.log("\n── SMC Safety Check ─────────────────────────────────────\n");
  for (const c of conditions) {
    console.log(`  ${c.pass ? "✅" : "🚫"} ${c.label}`);
    console.log(`     ${c.actual}`);
  }
}

// ─── Trade Limits ─────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);
  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(`🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`);
    return { ok: false, todayCount };
  }

  console.log(`✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`);
  return { ok: true, todayCount };
}

// ─── BitGet Execution ─────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto.createHmac("sha256", CONFIG.bitget.secretKey).update(message).digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity  = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol, side, orderType: "market", quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);
  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") throw new Error(`BitGet order failed: ${data.msg}`);
  return data.data;
}

// ─── Tax CSV Logging ──────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

const CSV_HEADERS = [
  "Date", "Time (Panama)", "Exchange", "Symbol", "Side", "Quantity",
  "Price", "Total USD", "Fee (est.)", "Net Amount", "Order ID", "Mode", "Notes",
].join(",");

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const note = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + note + "\n");
    console.log(`📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`);
  }
}

function writeTradeCsv(logEntry) {
  const now  = new Date(logEntry.timestamp);
  const date = toPanamaDate(now);
  const time = toPanamaTime(now);

  let side = "", quantity = "", totalUSD = "", fee = "", netAmount = "", orderId = "", mode = "", notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions.filter((c) => !c.pass).map((c) => c.label).join("; ");
    mode = "BLOCKED"; orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else {
    side     = logEntry.direction === "bearish" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee      = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId  = logEntry.orderId || "";
    mode     = logEntry.paperTrading ? "PAPER" : "LIVE";
    notes    = logEntry.error
      ? `Error: ${logEntry.error}`
      : `SMC ${logEntry.direction} | Score: ${logEntry.score} (${logEntry.tier}-grade)`;
  }

  const row = [
    date, time, "BitGet", logEntry.symbol, side, quantity,
    logEntry.price.toFixed(2), totalUSD, fee, netAmount, orderId, mode, `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) { console.log("No trades.csv found."); return; }
  const rows     = readFileSync(CSV_FILE, "utf8").trim().split("\n").slice(1).map((l) => l.split(","));
  const live     = rows.filter((r) => r[11] === "LIVE");
  const paper    = rows.filter((r) => r[11] === "PAPER");
  const blocked  = rows.filter((r) => r[11] === "BLOCKED");
  const volume   = live.reduce((s, r) => s + parseFloat(r[7] || 0), 0);
  const fees     = live.reduce((s, r) => s + parseFloat(r[8] || 0), 0);
  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${volume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${fees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();

  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — SMC Strategy");
  console.log(`  ${toPanamaDate()} ${toPanamaTime()} (Panama UTC-5)`);
  console.log(`  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`);
  console.log("═══════════════════════════════════════════════════════════");

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol}  |  Stack: ${CONFIG.biasFrame} → ${CONFIG.entryFrame} → ${CONFIG.confirmFrame}`);

  const log    = loadLog();
  const limits = checkTradeLimits(log);
  if (!limits.ok) { console.log("\nBot stopping — trade limits reached for today."); return; }

  const analysis = await runSMCAnalysis(CONFIG.symbol);
  const { conditions, allPass, score, maxScore, tier, price, atr, activeZone, direction } = analysis;

  printSMCCheck(conditions);

  // Position sizing scales with confluence tier (A=1%, B=0.75%, C=0.5%)
  const riskPct  = tier === "A" ? 0.01 : tier === "B" ? 0.0075 : 0.005;
  const tradeSize = Math.min(CONFIG.portfolioValue * riskPct, CONFIG.maxTradeSizeUSD);

  console.log(`\n── Confluence Score ──────────────────────────────────────`);
  console.log(`\n  ${score}/${maxScore} pts — ${tier === "skip" ? "⛔ BELOW MINIMUM (need 4)" : tier + "-Grade"}`);

  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp:    new Date().toISOString(),
    symbol:       CONFIG.symbol,
    timeframe:    CONFIG.entryFrame,
    price,
    direction,
    score,
    tier,
    indicators: {
      smma21daily: analysis.daily.smma21,
      smma50h4:    analysis.h4?.smma50,
      atr,
      dailyBias:   analysis.daily.bias,
      structure:   analysis.daily.structure,
      activeZone:  activeZone
        ? `${activeZone.zoneType} $${activeZone.low.toFixed(0)}–$${activeZone.high.toFixed(0)}`
        : null,
    },
    conditions,
    allPass,
    tradeSize,
    orderPlaced:  false,
    orderId:      null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD:  CONFIG.maxTradeSizeUSD,
      maxTradesPerDay:  CONFIG.maxTradesPerDay,
      tradesToday:      limits.todayCount,
    },
  };

  if (!allPass) {
    const failed = conditions.filter((c) => !c.pass).map((c) => `\n   - ${c.label}`).join("");
    console.log(`🚫 NO TRADE — score ${score}/${maxScore}${tier === "skip" ? " (below minimum)" : ", required conditions failed"}`);
    console.log(`   Failed:${failed}`);
  } else {
    const verb = direction === "bearish" ? "SHORT" : "LONG";
    console.log(`✅ HIGH-PROBABILITY SETUP — ${verb} ${CONFIG.symbol}`);
    console.log(`   Score: ${score}/${maxScore} (${tier}-Grade)  |  Risk: ${(riskPct * 100).toFixed(2)}%  |  Size: $${tradeSize.toFixed(2)}`);
    if (activeZone) {
      console.log(`   Zone: ${activeZone.zoneType.replace("_", " ")} $${activeZone.low.toFixed(0)}–$${activeZone.high.toFixed(0)}`);
    }
    if (atr) {
      const buf  = atr * 0.5;
      const stop = direction === "bullish"
        ? ((activeZone?.low ?? price) - buf).toFixed(2)
        : ((activeZone?.high ?? price) + buf).toFixed(2);
      console.log(`   Stop: $${stop} (${direction === "bullish" ? "below zone" : "above zone"} − 0.5×ATR)`);
    }

    if (CONFIG.paperTrading) {
      console.log(`\n📋 PAPER TRADE — would ${verb} ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market`);
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId     = `PAPER-${Date.now()}`;
    } else {
      const side = direction === "bearish" ? "sell" : "buy";
      console.log(`\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${verb} ${CONFIG.symbol}`);
      try {
        const order = await placeBitGetOrder(CONFIG.symbol, side, tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId     = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }

  }

  await sendTelegram(buildTradeAlert(logEntry));
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);
  writeTradeCsv(logEntry);
  console.log("═══════════════════════════════════════════════════════════\n");
}

// ─── Telegram Notifications ───────────────────────────────────────────────────

async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res  = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (data.ok) {
      console.log("📱 Telegram notification sent");
    } else {
      console.log(`⚠️  Telegram error: ${data.description}`);
    }
  } catch (err) {
    console.log(`⚠️  Telegram failed: ${err.message}`);
  }
}

function buildTradeAlert(entry) {
  const { symbol, direction, price, score, tier, conditions, tradeSize,
          paperTrading, orderId, error, indicators, allPass } = entry;

  const modeTag   = paperTrading ? "📋 PAPER" : "🔴 LIVE";
  const gradeIcon = { A: "🟢", B: "🔵", C: "🟡" }[tier] ?? "⚪";
  const priceStr  = price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (!allPass) {
    const dirLabel   = direction === "neutral" ? "NEUTRAL" : direction === "bearish" ? "BEARISH ▼" : "BULLISH ▲";
    const failedLines = (conditions || [])
      .filter((c) => !c.pass)
      .map((c) => {
        const label = c.label.replace(/ — .+/, "").slice(0, 52);
        const note  = c.actual ? `  <i>${String(c.actual).slice(0, 48)}</i>` : "";
        return `❌ ${label}${note}`;
      }).join("\n");
    return [
      `🤖 <b>CLAUDE EXECUTE — SIGNAL</b>`,
      ``,
      `<b>🚫 BLOCK — ${symbol || "BTCUSDT"}</b>  ${modeTag}`,
      `💰 Price: <b>$${priceStr}</b>  ·  ${dirLabel}`,
      `${gradeIcon} Score: <b>${score}/14</b>  ·  Grade: <b>${tier.toUpperCase()}</b>`,
      ``,
      `<b>Failed conditions</b>`,
      failedLines,
    ].join("\n");
  }

  const verb = direction === "bearish" ? "SHORT ▼" : "LONG ▲";

  // Conditions block — trim long dynamic labels for readability
  const condLines = (conditions || []).map((c) => {
    const icon  = c.pass ? "✅" : "❌";
    const label = c.label.replace(/ — .+/, "").slice(0, 52);
    const note  = c.actual ? `  <i>${String(c.actual).slice(0, 48)}</i>` : "";
    return `${icon} ${label}${note}`;
  }).join("\n");

  // Zone
  const zone = indicators?.activeZone
    ? `\n🎯 Zone: ${indicators.activeZone.replace("order_block", "Order Block").replace("fvg", "FVG")}`
    : "";

  // Stop loss
  const atr  = indicators?.atr;
  const stop = atr
    ? (() => {
        const lvl = direction === "bullish"
          ? ((indicators?.activeZone ? parseFloat(indicators.activeZone.match(/\$(\d+)/)?.[1] ?? price) : price) - atr * 0.5).toFixed(0)
          : ((indicators?.activeZone ? parseFloat(indicators.activeZone.match(/\$(\d+)–\$(\d+)/)?.[2] ?? price) : price) + atr * 0.5).toFixed(0);
        return `\n🛑 Stop: $${Number(lvl).toLocaleString("en-US")} (0.5×ATR)`;
      })()
    : "";

  // Order confirmation
  const orderLine = error
    ? `\n❌ Order error: ${error}`
    : orderId
      ? `\n🔖 ${paperTrading ? "Paper ID" : "Order ID"}: <code>${orderId}</code>`
      : "";

  return [
    `🤖 <b>CLAUDE EXECUTE — SIGNAL</b>`,
    ``,
    `<b>${verb} ${symbol || "BTCUSDT"}</b>  ${modeTag}`,
    `💰 Price: <b>$${priceStr}</b>`,
    `${gradeIcon} Score: <b>${score}/14</b>  ·  Grade: <b>${tier.toUpperCase()}</b>`,
    `💵 Size: $${tradeSize.toFixed(2)}${zone}${stop}${orderLine}`,
    ``,
    `<b>Conditions</b>`,
    condLines,
  ].join("\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  const HOUR_MS = 60 * 60 * 1000;
  const runSafe = () => run().catch((err) => console.error("Bot error:", err));
  runSafe();
  setInterval(runSafe, HOUR_MS);
}
