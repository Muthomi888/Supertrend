const WebSocket = require('ws');
const fetch = require('node-fetch');

// ─── CONFIG ───────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_BOT_TOKEN: '8073234881:AAGQIYWFWkIIfF9sJPArdsEo8rIdbE5Gvqg',
  TELEGRAM_CHAT_ID:   '6466334989',
  DERIV_APP_ID:       '1089',
  SYMBOLS:            ['R_10', 'R_25'],
  TIMEFRAMES:         ['5min', /*'15min', '1hr'*/],
  SUPERTREND: {
    period:     1,
    multiplier: 1,
  },
  MAX_CANDLES: 300,
};
// ─────────────────────────────────────────────────────────────────

const API_URL = `wss://ws.derivws.com/websockets/v3?app_id=${CONFIG.DERIV_APP_ID}`;

const timeframeMap = {
  '5min':  300,
  '15min': 900,
  '1hr':   3600,
};

const displayNames = {
  'R_10':  'Volatility 10 Index',
  'R_25':  'Volatility 25 Index',
  '5min':  '5 minutes',
  '15min': '15 minutes',
  '1hr':   '1 hour',
};

// ─── STATE ────────────────────────────────────────────────────────
const historicalData  = {};
const currentCandles  = {};
const trendState      = {};

CONFIG.SYMBOLS.forEach(sym => {
  historicalData[sym] = {};
  currentCandles[sym] = {};
  trendState[sym]     = {};
  CONFIG.TIMEFRAMES.forEach(tf => {
    historicalData[sym][tf] = [];
    currentCandles[sym][tf] = null;
    trendState[sym][tf]     = null;
  });
});

// ─── TELEGRAM ─────────────────────────────────────────────────────
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res  = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:    CONFIG.TELEGRAM_CHAT_ID,
        text:       message,
        parse_mode: 'Markdown',
      }),
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data);
    else          console.log(`📨 Telegram sent: ${message.split('\n')[0]}`);
  } catch (err) {
    console.error('Telegram fetch error:', err.message);
  }
}

// ─── TREND CHANGE (candle-close only) ────────────────────────────
async function checkTrendChangeOnClose(symbol, timeframe, newTrend, value) {
  const prev = trendState[symbol][timeframe];

  if (prev === null) {
    trendState[symbol][timeframe] = newTrend;
    return;
  }

  if (prev !== newTrend) {
    const symName = displayNames[symbol];
    const tfName  = displayNames[timeframe];
    const now     = new Date().toUTCString();

    let message = '';
    if (newTrend === 'uptrend') {
      message =
        `🟢 *TREND CHANGE — BULLISH*\n` +
        `*${symName}* switched to *UPTREND* on *${tfName}*\n` +
        `Supertrend: \`${value.toFixed(4)}\`\n` +
        `🕐 ${now}\n` +
        `_(confirmed on candle close)_`;
    } else {
      message =
        `🔴 *TREND CHANGE — BEARISH*\n` +
        `*${symName}* switched to *DOWNTREND* on *${tfName}*\n` +
        `Supertrend: \`${value.toFixed(4)}\`\n` +
        `🕐 ${now}\n` +
        `_(confirmed on candle close)_`;
    }

    await sendTelegram(message);
    trendState[symbol][timeframe] = newTrend;
  }
}

// ─── SUPERTREND MATHS ─────────────────────────────────────────────
function calcRMA(data, period) {
  if (data.length < period) return [];
  const result = [data.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < data.length; i++) {
    result.push(data[i] * (1 / period) + result[result.length - 1] * (1 - 1 / period));
  }
  return result;
}

function calcTR(data) {
  return data.map((d, i) => {
    if (i === 0) return d.high - d.low;
    return Math.max(
      d.high - d.low,
      Math.abs(d.high - data[i - 1].close),
      Math.abs(d.low  - data[i - 1].close)
    );
  });
}

function calcSupertrend(data, period, multiplier) {
  if (data.length < period + 1) return null;

  const atr     = calcRMA(calcTR(data), period);
  const offset  = data.length - atr.length;
  const results = [];

  for (let i = period; i < data.length; i++) {
    const ai  = i - offset;
    if (ai < 0) continue;
    const hl2 = (data[i].high + data[i].low) / 2;
    results.push({
      index:          i,
      basicUpper:     hl2 + multiplier * atr[ai],
      basicLower:     hl2 - multiplier * atr[ai],
      close:          data[i].close,
    });
  }

  if (!results.length) return null;

  let prevUpper = results[0].basicUpper;
  let prevLower = results[0].basicLower;
  let prevTrend = results[0].close > results[0].basicUpper ? 'uptrend' : 'downtrend';

  for (let i = 0; i < results.length; i++) {
    const cur = results[i];

    cur.finalUpper =
      cur.basicUpper < prevUpper ||
      (i > 0 && data[results[i - 1].index].close > prevUpper)
        ? cur.basicUpper : prevUpper;

    cur.finalLower =
      cur.basicLower > prevLower ||
      (i > 0 && data[results[i - 1].index].close < prevLower)
        ? cur.basicLower : prevLower;

    if      (i === 0)                   cur.trend = prevTrend;
    else if (cur.close > cur.finalUpper) cur.trend = 'uptrend';
    else if (cur.close < cur.finalLower) cur.trend = 'downtrend';
    else                                 cur.trend = prevTrend;

    cur.supertrend = cur.trend === 'uptrend' ? cur.finalLower : cur.finalUpper;
    prevUpper = cur.finalUpper;
    prevLower = cur.finalLower;
    prevTrend = cur.trend;
  }

  const last = results[results.length - 1];
  return last ? { trend: last.trend, value: last.supertrend } : null;
}

// ─── CANDLE MANAGEMENT ────────────────────────────────────────────
function getCandleTime(timestamp, granularity) {
  return Math.floor(timestamp / granularity) * granularity;
}

async function updateCurrentCandle(symbol, price, timestamp) {
  for (const timeframe of CONFIG.TIMEFRAMES) {
    const granularity = timeframeMap[timeframe];
    const candleTime  = getCandleTime(timestamp, granularity);

    if (!currentCandles[symbol][timeframe] ||
        currentCandles[symbol][timeframe].timestamp !== candleTime) {

      // ── Candle just CLOSED ──────────────────────────────────────
      if (currentCandles[symbol][timeframe]) {
        historicalData[symbol][timeframe].push(currentCandles[symbol][timeframe]);

        if (historicalData[symbol][timeframe].length > CONFIG.MAX_CANDLES) {
          historicalData[symbol][timeframe].shift();
        }

        // Calculate supertrend on closed candles only → send notification if trend changed
        const result = calcSupertrend(
          historicalData[symbol][timeframe],
          CONFIG.SUPERTREND.period,
          CONFIG.SUPERTREND.multiplier
        );

        if (result) {
          console.log(`[${symbol}][${timeframe}] Candle closed → trend: ${result.trend} | value: ${result.value.toFixed(4)}`);
          await checkTrendChangeOnClose(symbol, timeframe, result.trend, result.value);
        }
      }

      // Start new candle
      currentCandles[symbol][timeframe] = {
        timestamp: candleTime,
        open:  price,
        high:  price,
        low:   price,
        close: price,
      };

    } else {
      const c   = currentCandles[symbol][timeframe];
      c.high    = Math.max(c.high, price);
      c.low     = Math.min(c.low,  price);
      c.close   = price;
    }
  }
}

// ─── BOOTSTRAP HISTORICAL CANDLES ────────────────────────────────
function processCandles(symbol, timeframe, candles) {
  const data = candles.map(c => ({
    open:      parseFloat(c.open),
    high:      parseFloat(c.high),
    low:       parseFloat(c.low),
    close:     parseFloat(c.close),
    timestamp: c.epoch,
  }));

  if (!data.length) return;

  historicalData[symbol][timeframe] = data.slice(0, -1);

  const last = data[data.length - 1];
  currentCandles[symbol][timeframe] = {
    timestamp: last.timestamp,
    open:  last.open,
    high:  last.high,
    low:   last.low,
    close: last.close,
  };

  const combined = [...historicalData[symbol][timeframe], currentCandles[symbol][timeframe]];
  const result   = calcSupertrend(combined, CONFIG.SUPERTREND.period, CONFIG.SUPERTREND.multiplier);

  if (result) {
    // Initialise trend state — no notification on startup
    trendState[symbol][timeframe] = result.trend;
    console.log(`[${symbol}][${timeframe}] Loaded ${data.length} candles → initial trend: ${result.trend}`);
  }
}

// ─── WEBSOCKET ────────────────────────────────────────────────────
let ws;

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function requestCandles(symbol, timeframe) {
  const granularity = timeframeMap[timeframe];
  send({
    ticks_history:    symbol,
    adjust_start_time: 1,
    count:            CONFIG.MAX_CANDLES,
    end:              'latest',
    style:            'candles',
    granularity,
  });
}

function subscribeToTicks(symbol) {
  send({ ticks: symbol, subscribe: 1 });
}

async function handleMessage(raw) {
  let data;
  try { data = JSON.parse(raw); }
  catch { return; }

  if (data.error) {
    console.error('Deriv WS error:', data.error.message);
    return;
  }

  if (data.candles) {
    const symbol      = data.echo_req.ticks_history;
    const granularity = data.echo_req.granularity;
    const timeframe   = Object.keys(timeframeMap).find(k => timeframeMap[k] === granularity);
    if (timeframe) processCandles(symbol, timeframe, data.candles);
  }

  if (data.tick) {
    const { symbol, quote, epoch } = data.tick;
    await updateCurrentCandle(symbol, parseFloat(quote), epoch);
  }
}

function connect() {
  console.log('🔌 Connecting to Deriv WebSocket...');
  ws = new WebSocket(API_URL);

  ws.on('open', () => {
    console.log('✅ Connected to Deriv WebSocket');
    CONFIG.SYMBOLS.forEach(sym => {
      CONFIG.TIMEFRAMES.forEach(tf => requestCandles(sym, tf));
      subscribeToTicks(sym);
    });
  });

  ws.on('message', handleMessage);

  ws.on('close', () => {
    console.warn('⚠️  WebSocket closed — reconnecting in 5s...');
    setTimeout(connect, 5000);
  });

  ws.on('error', err => {
    console.error('❌ WebSocket error:', err.message);
  });
}

// ─── BOOT ─────────────────────────────────────────────────────────
console.log('🚀 Supertrend bot starting...');
connect();
