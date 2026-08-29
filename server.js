const crypto = require('crypto');
const express = require('express');
const admin = require('firebase-admin');

// Safety net: one bad outbound request (e.g. to a payment provider) must never
// take down the whole bot server. Log it instead of crashing the process.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (server kept running):', err);
});

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const STARS_PRICE = parseInt(process.env.STARS_PRICE || '100', 10);
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// T-Bank (Tinkoff) acquiring — optional, SBP/card payment path.
// Leave both empty to disable this payment method entirely.
const TBANK_TERMINAL_KEY = process.env.TBANK_TERMINAL_KEY || '';
const TBANK_PASSWORD = process.env.TBANK_PASSWORD || '';
const TBANK_PRICE_RUB = parseInt(process.env.TBANK_PRICE_RUB || '149', 10);
const TBANK_ENABLED = !!(TBANK_TERMINAL_KEY && TBANK_PASSWORD);
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // e.g. https://meme-game-bot.onrender.com, needed for NotificationURL/SuccessURL

for (const [name, val] of Object.entries({ BOT_TOKEN, WEBHOOK_SECRET, FIREBASE_SERVICE_ACCOUNT, FIREBASE_DATABASE_URL })) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON:', e.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: FIREBASE_DATABASE_URL,
});
const db = admin.database();

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- Telegram WebApp initData validation ---
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function validateInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [];
  for (const key of [...params.keys()].sort()) {
    pairs.push(`${key}=${params.get(key)}`);
  }
  const dataCheckString = pairs.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const now = Math.floor(Date.now() / 1000);
  if (!authDate || now - authDate > 86400) return null; // older than 24h -> reject

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    const user = JSON.parse(userJson);
    if (!user || !user.id) return null;
    return user;
  } catch {
    return null;
  }
}

// --- Firebase Realtime Database helpers ---
// Data lives under /paidUsers/<telegramId>, separate from the game's own multiplayer data.
async function isPaid(telegramId) {
  try {
    const snap = await db.ref('paidUsers/' + telegramId).get();
    return snap.exists();
  } catch (e) {
    console.error('isPaid error:', e.message);
    return false;
  }
}

async function markPaid(telegramId, chargeId) {
  try {
    await db.ref('paidUsers/' + telegramId).set({
      paidAt: admin.database.ServerValue.TIMESTAMP,
      chargeId: chargeId || null,
    });
  } catch (e) {
    console.error('markPaid error:', e.message);
  }
}

// --- Telegram Bot API helpers ---
async function tgCall(method, body) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.error(`${method} failed:`, JSON.stringify(json));
  return json;
}

// --- T-Bank (Tinkoff) acquiring helpers ---
// Signature algorithm: https://developer.tbank.ru/eacq/api/token
// Take all root-level scalar request fields + Password, sort keys alphabetically,
// concatenate the values (not keys), SHA-256 the result.
function tbankToken(params) {
  const data = Object.assign({}, params, { Password: TBANK_PASSWORD });
  const keys = Object.keys(data).filter((k) => typeof data[k] !== 'object').sort();
  const concatenated = keys.map((k) => String(data[k])).join('');
  return crypto.createHash('sha256').update(concatenated).digest('hex');
}

async function tbankCall(method, params) {
  const body = Object.assign({ TerminalKey: TBANK_TERMINAL_KEY }, params);
  body.Token = tbankToken(body);
  const res = await fetch(`https://securepay.tinkoff.ru/v2/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// --- API: check access ---
app.post('/api/check-access', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const paid = await isPaid(user.id);
  res.json({ paid });
});

// --- API: create invoice link for Stars purchase ---
app.post('/api/create-invoice', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });

  const alreadyPaid = await isPaid(user.id);
  if (alreadyPaid) return res.json({ alreadyPaid: true });

  const result = await tgCall('createInvoiceLink', {
    title: 'Полный доступ к игре',
    description: 'Открывает рубрику «Кино и сериалы» и все будущие платные рубрики навсегда.',
    payload: `full_access_${user.id}_${Date.now()}`,
    currency: 'XTR',
    prices: [{ label: 'Полный доступ', amount: STARS_PRICE }],
  });

  if (!result.ok) return res.status(502).json({ error: 'telegram api error' });
  res.json({ link: result.result });
});

// --- API: create SBP/card payment link via T-Bank ---
app.post('/api/create-tbank-payment', async (req, res) => {
  if (!TBANK_ENABLED) return res.status(503).json({ error: 'card payment not configured yet' });
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });

  const alreadyPaid = await isPaid(user.id);
  if (alreadyPaid) return res.json({ alreadyPaid: true });

  const orderId = `kino-${user.id}-${Date.now()}`;
  let result;
  try {
    result = await tbankCall('Init', {
      Amount: TBANK_PRICE_RUB * 100, // kopecks
      OrderId: orderId,
      Description: 'Полный доступ к игре: рубрика «Кино и сериалы»',
      NotificationURL: `${PUBLIC_URL}/tbank-notification`,
      SuccessURL: `${PUBLIC_URL}/tbank-success`,
      FailURL: `${PUBLIC_URL}/tbank-fail`,
    });
  } catch (e) {
    console.error('T-Bank Init request failed:', e);
    return res.status(502).json({ error: 'tbank api unreachable' });
  }

  if (!result.Success) {
    console.error('T-Bank Init failed:', JSON.stringify(result));
    return res.status(502).json({ error: 'tbank api error' });
  }
  res.json({ url: result.PaymentURL });
});

// --- T-Bank payment notification webhook ---
// Docs: T-Bank sends a POST here on every status change; must reply with plain text "OK".
app.post('/tbank-notification', async (req, res) => {
  try {
    const body = req.body || {};
    const receivedToken = body.Token;
    const check = Object.assign({}, body);
    delete check.Token;
    const expectedToken = tbankToken(check);

    if (!TBANK_ENABLED || receivedToken !== expectedToken) {
      console.error('T-Bank notification: bad token');
      return res.send('OK'); // still ack so T-Bank doesn't retry forever; just don't grant access
    }

    if (body.Status === 'CONFIRMED' && typeof body.OrderId === 'string') {
      const m = body.OrderId.match(/^kino-(\d+)-/);
      if (m) {
        const telegramId = m[1];
        await markPaid(telegramId, body.PaymentId ? String(body.PaymentId) : null);
        try {
          await tgCall('sendMessage', {
            chat_id: telegramId,
            text: 'Спасибо за покупку! Полный доступ открыт 🎬 Возвращайся в игру — рубрика «Кино и сериалы» уже разблокирована.',
          });
        } catch (e) { /* best effort */ }
      }
    }
  } catch (e) {
    console.error('tbank-notification error:', e);
  }
  res.send('OK');
});

app.get('/tbank-success', (req, res) => res.send('Оплата прошла успешно! Возвращайся в игру в Telegram.'));
app.get('/tbank-fail', (req, res) => res.send('Оплата не прошла. Вернись в игру и попробуй ещё раз.'));

// --- Telegram webhook ---
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  const update = req.body;
  res.sendStatus(200); // ack immediately, process after

  try {
    if (update.pre_checkout_query) {
      const q = update.pre_checkout_query;
      await tgCall('answerPreCheckoutQuery', { pre_checkout_query_id: q.id, ok: true });
      return;
    }

    if (update.message && update.message.successful_payment) {
      const msg = update.message;
      const sp = msg.successful_payment;
      const telegramId = msg.from.id;
      await markPaid(telegramId, sp.telegram_payment_charg
