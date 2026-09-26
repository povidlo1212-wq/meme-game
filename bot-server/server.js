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
const FIREBASE_SERVICE_ACCOUNT_B64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
const FIREBASE_DATABASE_URL = process.env.FIREBASE_DATABASE_URL;
const STARS_PRICE = parseInt(process.env.STARS_PRICE || '100', 10);
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// T-Bank (Tinkoff) acquiring — optional, SBP/card payment path.
// Leave both empty to disable this payment method entirely.
const TBANK_TERMINAL_KEY = process.env.TBANK_TERMINAL_KEY || '';
const TBANK_PASSWORD = process.env.TBANK_PASSWORD || '';
const TBANK_PRICE_RUB = parseInt(process.env.TBANK_PRICE_RUB || '149', 10);
const TBANK_ENABLED = !!(TBANK_TERMINAL_KEY && TBANK_PASSWORD);
const PUBLIC_URL = process.env.PUBLIC_URL || ''; // e.g. https://meme-game-bot.onrender.com, needed for NotificationURL/SuccessURL
// 54-FZ requires a fiscal receipt on every card/SBP charge. Telegram never
// gives us the payer's email/phone, so the receipt goes to one fixed address -
// set this to whatever email your kassa/ОФД setup should send receipts to.
const TBANK_RECEIPT_EMAIL = process.env.TBANK_RECEIPT_EMAIL || '';
// Tax system code from your T-Bank/ФНС registration, e.g. usn_income,
// usn_income_outcome, osn, envd, esn, patent. usn_income is the common default
// for a self-employed/ИП seller on "доходы" - override if yours differs.
const TBANK_TAXATION = process.env.TBANK_TAXATION || 'usn_income';
if (TBANK_ENABLED && !TBANK_RECEIPT_EMAIL) {
  console.error('TBANK_ENABLED but TBANK_RECEIPT_EMAIL is not set - T-Bank Init will fail with "expected.receipt" until it is.');
}

// Yandex Games in-app purchases — optional, only used by the ?platform=yandex
// build. The secret lives in the Yandex Developer Console once you connect
// in-app purchases there (Инап-покупки → Настройки). Leave empty to disable.
const YANDEX_PAYMENTS_SECRET = process.env.YANDEX_PAYMENTS_SECRET || '';

// VK Mini Apps in-app payments — optional, only used by the ?platform=vk
// build. The secret is the "Секретный ключ платежей" from the VK app admin
// (Управление → Оплата), separate from the app's main "Защищённый ключ".
// Leave empty to disable. Price is in VK's internal currency (голоса).
const VK_PAYMENTS_SECRET = process.env.VK_PAYMENTS_SECRET || '';
const VK_PREMIUM_PRICE_VOTES = parseInt(process.env.VK_PREMIUM_PRICE_VOTES || '19', 10);

// VK Mini Apps launch-params signature key ("Защищённый ключ" in VK app admin,
// Настройки → base) - different secret from VK_PAYMENTS_SECRET above. VK's
// rules (1.2.2) require validating the signature of launch params rather than
// trusting vk_user_id straight from the URL, so this verifies it server-side.
const VK_APP_SECRET = process.env.VK_APP_SECRET || '';

// Support bot — optional: your own Telegram chat id to receive a copy of every
// support message / bug report players send. Get it from @userinfobot.
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '';

for (const [name, val] of Object.entries({
  BOT_TOKEN,
  WEBHOOK_SECRET,
  FIREBASE_SERVICE_ACCOUNT: FIREBASE_SERVICE_ACCOUNT || FIREBASE_SERVICE_ACCOUNT_B64,
  FIREBASE_DATABASE_URL,
})) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

let serviceAccount;
try {
  const rawServiceAccount = FIREBASE_SERVICE_ACCOUNT_B64
    ? Buffer.from(FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8')
    : FIREBASE_SERVICE_ACCOUNT;
  serviceAccount = JSON.parse(rawServiceAccount);
} catch (e) {
  console.error('Firebase service account is not valid JSON/Base64:', e.message);
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
// VK's payment-notification callbacks arrive as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  const requestOrigin = req.get('Origin');
  if (ALLOWED_ORIGINS.includes('*')) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) {
    res.header('Access-Control-Allow-Origin', requestOrigin);
    res.header('Vary', 'Origin');
  }
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

// --- Premium duration ---
// Premium is time-limited (used to be a lifetime grant). Records written before
// this change have no paidUntil field at all - those are grandfathered in as
// still-active rather than retroactively cutting off people who already paid.
const PREMIUM_DAYS = 30;
const GIFT_BONUS_DAYS = 7; // free week bundled with every self-purchase, for a friend
const GIFT_PURCHASED_DAYS = 30; // full month when someone buys premium as a gift
const DAY_MS = 24 * 60 * 60 * 1000;
// Yandex product id (set up in the Developer Console under Инап-покупки) ->
// days of premium it grants. Add more entries here if you create more products.
const YANDEX_PRODUCT_DAYS = { premium_month: PREMIUM_DAYS };
// Same idea for VK's payment items (set up in VK app admin under Оплата).
const VK_PRODUCT_DAYS = { premium_month: PREMIUM_DAYS };

// --- Firebase Realtime Database helpers ---
// Data lives under /paidUsers/<telegramId>, separate from the game's own multiplayer data.
async function isPaid(telegramId) {
  try {
    const snap = await db.ref('paidUsers/' + telegramId).get();
    if (!snap.exists()) return false;
    const v = snap.val() || {};
    if (typeof v.paidUntil !== 'number') return true; // legacy lifetime grant
    return v.paidUntil > Date.now();
  } catch (e) {
    console.error('isPaid error:', e.message);
    return false;
  }
}

async function getPaidRecord(telegramId) {
  try {
    const snap = await db.ref('paidUsers/' + telegramId).get();
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    console.error('getPaidRecord error:', e.message);
    return null;
  }
}

// Grants `days` of premium starting now (self-purchase). Stars/card purchases
// always start a fresh PREMIUM_DAYS window from the moment of payment.
async function markPaid(telegramId, chargeId, days) {
  days = days || PREMIUM_DAYS;
  try {
    await db.ref('paidUsers/' + telegramId).set({
      paidAt: admin.database.ServerValue.TIMESTAMP,
      paidUntil: Date.now() + days * DAY_MS,
      chargeId: chargeId || null,
    });
    await db.ref('pendingPayments/' + telegramId).remove().catch(() => {});
  } catch (e) {
    console.error('markPaid error:', e.message);
  }
}

// Random URL-safe gift token id.
function genGiftToken() {
  return crypto.randomBytes(6).toString('hex');
}

// Creates a claimable gift record. kind: 'bonus' (free week bundled with a
// self-purchase) or 'purchased' (someone paid specifically to gift it).
async function createGiftToken(fromUid, kind, days) {
  const token = genGiftToken();
  const now = Date.now();
  await db.ref('giftTokens/' + token).set({
    fromUid: String(fromUid),
    kind,
    days,
    createdAt: now,
    expiresAt: now + PREMIUM_DAYS * DAY_MS, // unclaimed link goes stale after a month
    claimedBy: null,
    claimedAt: null,
  });
  console.log('createGiftToken', token, 'from', fromUid, 'kind=' + kind, 'days=' + days);
  return token;
}

// Atomically claims a gift token and extends the recipient's premium.
// Stacks on top of any still-active premium instead of overwriting it.
async function claimGiftToken(token, toUid) {
  toUid = String(toUid);
  const ref = db.ref('giftTokens/' + token);
  let aborted = null;
  let sawBefore = null;
  const result = await ref.transaction((cur) => {
    sawBefore = cur; // last state the callback actually saw (may run more than once on retry)
    if (!cur) { aborted = 'not_found'; return; }
    if (cur.claimedBy) { aborted = 'claimed'; return; }
    if (cur.expiresAt && cur.expiresAt < Date.now()) { aborted = 'expired'; return; }
    if (String(cur.fromUid) === toUid) { aborted = 'self'; return; }
    cur.claimedBy = toUid;
    cur.claimedAt = Date.now();
    return cur;
  });
  console.log(
    'claimGiftToken', token, 'by', toUid,
    'committed=' + result.committed, 'reason=' + aborted,
    'sawBefore=' + JSON.stringify(sawBefore),
  );
  if (!result.committed) return { ok: false, reason: aborted || 'claimed' };
  const data = result.snapshot.val();
  const days = data.days || GIFT_BONUS_DAYS;
  try {
    const prevSnap = await db.ref('paidUsers/' + toUid).get();
    const prev = prevSnap.exists() ? prevSnap.val() : null;
    const stillActive = prev && typeof prev.paidUntil === 'number' && prev.paidUntil > Date.now();
    const base = stillActive ? prev.paidUntil : Date.now();
    await db.ref('paidUsers/' + toUid).set({
      paidAt: (prev && prev.paidAt) || admin.database.ServerValue.TIMESTAMP,
      paidUntil: base + days * DAY_MS,
      chargeId: (prev && prev.chargeId) || null,
      giftFrom: data.fromUid,
    });
  } catch (e) {
    console.error('claimGiftToken grant error:', e.message);
    return { ok: false, reason: 'error' };
  }
  return { ok: true, fromUid: data.fromUid, days };
}

// Payment gateways (Tinkoff, Telegram) can and do redeliver the same
// confirmation more than once. Without this, a redelivered notification would
// mint a second gift token and reset paidUntil again for the same purchase -
// claim the order id atomically before acting on it so a retry is a no-op.
async function claimPaymentOnce(key) {
  const ref = db.ref('processedPayments/' + key);
  const result = await ref.transaction((cur) => {
    if (cur) return; // already claimed -> abort
    return { at: Date.now() };
  });
  return result.committed;
}

function giftLink(token) {
  return `https://t.me/meme_millennials_bot?start=gift_${token}`;
}
function purchaseThanksText(bonusToken) {
  return (
    'Спасибо за покупку! Премиум активен на месяц 🎉 Все платные рубрики открыты, рекламы нет.\n\n' +
    '🎁 Бонус: подари неделю премиума другу — перешли ему эту ссылку, и она сама всё сделает, как только он её откроет:\n' +
    giftLink(bonusToken)
  );
}
function giftReadyText(token) {
  return (
    '🎁 Подарок готов! Перешли эту ссылку другу — как только он её откроет, у него на месяц появится премиум:\n' +
    giftLink(token) +
    '\n\nСсылка одноразовая, сработает только у того, кто откроет её первым.'
  );
}

// Track "a payment was started but not yet confirmed" so the support bot can
// answer "did my payment go through" with a real, current status. No AI needed.
async function markPending(telegramId, method) {
  try {
    await db.ref('pendingPayments/' + telegramId).set({
      method: method,
      startedAt: admin.database.ServerValue.TIMESTAMP,
    });
  } catch (e) {
    console.error('markPending error:', e.message);
  }
}

async function getPending(telegramId) {
  try {
    const snap = await db.ref('pendingPayments/' + telegramId).get();
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    return null;
  }
}

// --- Telegram Bot API helpers ---
async function tgCall(method, body) {
  try {
    const res = await fetch(`${TG_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) console.error(`${method} failed:`, JSON.stringify(json));
    return json;
  } catch (e) {
    console.error(`${method} threw:`, e && e.message ? e.message : e);
    return { ok: false, error: String(e) };
  }
}

// --- T-Bank (Tinkoff) acquiring helpers ---
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

// --- Marketing source tracking ---
// Deep links carry ?startapp=s_<source> (or /start s_<source> in the bot).
// We attribute each Telegram user to the FIRST source they arrived from, and
// also keep a daily hit counter per source for trends.
function cleanSource(s) {
  return String(s || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32).toLowerCase();
}
async function trackSource(src, uid, profile) {
  src = cleanSource(src);
  if (!src || !uid) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const firstRef = db.ref('sourceFirstTouch/' + uid);
    const snap = await firstRef.get();
    if (!snap.exists()) {
      await firstRef.set({ src, at: admin.database.ServerValue.TIMESTAMP });
      await db.ref('sources/' + src + '/users/' + uid).set(true);
      await db.ref('sources/' + src + '/total').transaction((n) => (n || 0) + 1);
    }
    await db.ref('sources/' + src + '/daily/' + day).transaction((n) => (n || 0) + 1);
    // Telegram gives us the name/username for free right in initData - stash it
    // so /_stats can show who these ids actually are without extra API calls.
    if (profile) {
      await db.ref('userProfiles/' + uid).update(profile);
    }
  } catch (e) {
    console.error('trackSource error:', e.message);
  }
}

app.post('/api/track', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.json({ ok: false });
  await trackSource(req.body.source, user.id, {
    first_name: user.first_name || null,
    last_name: user.last_name || null,
    username: user.username || null,
  });
  res.json({ ok: true });
});

// Simple stats readout: /_stats?token=<WEBHOOK_SECRET>
app.get('/_stats', async (req, res) => {
  if (req.query.token !== WEBHOOK_SECRET) return res.status(403).send('forbidden');
  try {
    const snap = await db.ref('sources').get();
    const v = snap.exists() ? snap.val() : {};
    const out = {};
    for (const src of Object.keys(v)) {
      const ids = Object.keys(v[src].users || {});
      const users = await Promise.all(ids.map(async (uid) => {
        let profSnap = await db.ref('userProfiles/' + uid).get();
        let prof = profSnap.exists() ? profSnap.val() : null;
        // No stashed profile yet (id was tracked before this feature existed) -
        // resolve it once via Telegram and cache it for next time.
        if (!prof) {
          const chat = await tgCall('getChat', { chat_id: uid });
          if (chat.ok) {
            prof = {
              first_name: chat.result.first_name || null,
              last_name: chat.result.last_name || null,
              username: chat.result.username || null,
            };
            await db.ref('userProfiles/' + uid).set(prof);
          } else {
            prof = { error: 'not resolvable (never started the bot, or blocked it)' };
          }
        }
        return Object.assign({ id: uid }, prof);
      }));
      out[src] = {
        unique_users: v[src].total || ids.length,
        daily: v[src].daily || {},
        users,
      };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Verifies a VK Mini Apps launch-params query string against VK_APP_SECRET
// (see https://dev.vk.ru/ru/mini-apps/development/launch-params). Returns the
// validated vk_user_id, or null if the signature is missing/invalid/unconfigured.
function vkVerifyLaunchParams(qs) {
  if (!VK_APP_SECRET || !qs) return null;
  try {
    const params = new URLSearchParams(qs);
    const sign = params.get('sign');
    if (!sign) return null;
    const vkEntries = [];
    for (const [k, v] of params) {
      if (k.startsWith('vk_')) vkEntries.push([k, v]);
    }
    vkEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const sorted = vkEntries.map(([k, v]) => `${k}=${v}`).join('&');
    const computed = crypto.createHmac('sha256', VK_APP_SECRET).update(sorted).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    if (computed !== sign) return null;
    const uid = params.get('vk_user_id');
    return uid ? String(uid) : null;
  } catch (e) {
    return null;
  }
}

// --- API: check access ---
app.post('/api/check-access', async (req, res) => {
  let uid;
  if (req.body.platform === 'yandex' && req.body.yaPlayerId) {
    // Client-asserted id, not cryptographically verified - fine for a plain
    // "am I paid" read. Anything that actually grants access (the purchase
    // flow below) is verified server-side via the signed Yandex receipt.
    uid = String(req.body.yaPlayerId);
  } else if (req.body.platform === 'vk' && req.body.vkUserId) {
    // Prefer the signature-verified id from launch params (VK rules 1.2.2);
    // fall back to the client-asserted id only if verification isn't
    // possible (e.g. VK_APP_SECRET not yet configured). Either way this is
    // just a read-only "am I paid" check - actual access is only ever
    // granted via VK's own signed payment webhook.
    const verifiedUid = vkVerifyLaunchParams(req.body.launchParams);
    uid = 'vk_' + (verifiedUid || String(req.body.vkUserId).replace(/^vk_/, ''));
  } else {
    const user = validateInitData(req.body.initData);
    if (!user) return res.status(401).json({ error: 'invalid initData' });
    uid = user.id;
  }
  const paid = await isPaid(uid);
  res.json({ paid });
});

// --- API: fetch the most recent unclaimed gift token this user created ---
// The Mini App polls this right after a successful purchase (self or gift) to
// build the "share this with a friend" link - the token itself is minted
// server-side by the payment webhook, this just hands it to the client.
app.post('/api/gift/latest', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const kind = req.body.kind === 'purchased' ? 'purchased' : 'bonus';
  try {
    const snap = await db
      .ref('giftTokens')
      .orderByChild('fromUid')
      .equalTo(String(user.id))
      .limitToLast(20)
      .get();
    if (!snap.exists()) return res.json({ token: null });
    let best = null;
    snap.forEach((ch) => {
      const v = ch.val();
      if (v.kind === kind && !v.claimedBy && (!best || v.createdAt > best.createdAt)) {
        best = { token: ch.key, createdAt: v.createdAt };
      }
    });
    res.json({ token: best ? best.token : null });
  } catch (e) {
    console.error('gift/latest error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// --- API: create invoice link for Stars purchase ---
// Pass { gift: true } to buy premium as a gift for someone else instead of for
// yourself - that skips the "already paid" short-circuit (you can always buy a
// gift, no matter your own status) and tags the invoice so the webhook knows to
// mint a claimable gift link instead of marking the buyer paid.
app.post('/api/create-invoice', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const isGift = !!req.body.gift;

  if (!isGift) {
    const alreadyPaid = await isPaid(user.id);
    if (alreadyPaid) return res.json({ alreadyPaid: true });
  }

  const result = await tgCall('createInvoiceLink', {
    title: isGift ? 'Премиум в подарок другу' : 'Премиум на месяц',
    description: isGift
      ? 'Оплачиваешь ты — премиум на месяц достанется другу, которому отправишь ссылку после оплаты. Открывает все платные рубрики и убирает рекламу.'
      : 'Полный доступ ко всем платным рубрикам и без рекламы на месяц. Плюс сразу после покупки — ссылка, чтобы подарить другу неделю премиума бесплатно.',
    payload: `${isGift ? 'gift_access' : 'full_access'}_${user.id}_${Date.now()}`,
    currency: 'XTR',
    prices: [{ label: isGift ? 'Премиум в подарок' : 'Премиум на месяц', amount: STARS_PRICE }],
  });

  if (!result.ok) return res.status(502).json({ error: 'telegram api error' });
  if (!isGift) markPending(user.id, 'stars').catch(() => {});
  res.json({ link: result.result });
});

// --- API: create SBP/card payment link via T-Bank ---
app.post('/api/create-tbank-payment', async (req, res) => {
  if (!TBANK_ENABLED) return res.status(503).json({ error: 'card payment not configured yet' });
  const user = validateInitData(req.body.initData);
  if (!user) return res.status(401).json({ error: 'invalid initData' });
  const isGift = !!req.body.gift;

  if (!isGift) {
    const alreadyPaid = await isPaid(user.id);
    if (alreadyPaid) return res.json({ alreadyPaid: true });
  }

  const orderId = `kino-${isGift ? 'gift-' : ''}${user.id}-${Date.now()}`;
  const itemName = isGift ? 'Премиум в подарок (1 месяц)' : 'Премиум на месяц';
  let result;
  try {
    result = await tbankCall('Init', {
      Amount: TBANK_PRICE_RUB * 100, // kopecks
      OrderId: orderId,
      Description: isGift
        ? 'Премиум в подарок другу на месяц — оплачивает даритель'
        : 'Премиум на месяц: все рубрики, без рекламы, плюс неделя в подарок другу',
      NotificationURL: `${PUBLIC_URL}/tbank-notification`,
      SuccessURL: `${PUBLIC_URL}/tbank-success`,
      FailURL: `${PUBLIC_URL}/tbank-fail`,
      // Required by 54-FZ for every card/SBP charge - without it T-Bank rejects
      // the Init call outright (ErrorCode 309, expected.receipt).
      Receipt: {
        Email: TBANK_RECEIPT_EMAIL || undefined,
        Taxation: TBANK_TAXATION,
        Items: [
          {
            Name: itemName,
            Price: TBANK_PRICE_RUB * 100,
            Quantity: 1,
            Amount: TBANK_PRICE_RUB * 100,
            Tax: 'none',
            PaymentMethod: 'full_payment',
            PaymentObject: 'service',
          },
        ],
      },
    });
  } catch (e) {
    console.error('T-Bank Init request failed:', e);
    return res.status(502).json({ error: 'tbank api unreachable', detail: e && e.message });
  }

  if (!result.Success) {
    console.error('T-Bank Init failed:', JSON.stringify(result));
    return res.status(502).json({
      error: 'tbank api error',
      detail: result.Message || result.Details || `ErrorCode ${result.ErrorCode || '?'}`,
    });
  }
  if (!isGift) markPending(user.id, 'card').catch(() => {});
  res.json({ url: result.PaymentURL });
});

// --- T-Bank payment notification webhook ---
app.post('/tbank-notification', async (req, res) => {
  try {
    const body = req.body || {};
    const receivedToken = body.Token;
    const check = Object.assign({}, body);
    delete check.Token;
    const expectedToken = tbankToken(check);

    if (!TBANK_ENABLED || receivedToken !== expectedToken) {
      console.error('T-Bank notification: bad token');
      return res.send('OK');
    }

    if (body.Status === 'CONFIRMED' && typeof body.OrderId === 'string') {
      const firstTime = await claimPaymentOnce('tbank_' + body.OrderId);
      if (!firstTime) {
        console.log('tbank-notification: duplicate delivery for', body.OrderId, '- skipping');
        return res.send('OK');
      }
      const paymentId = body.PaymentId ? String(body.PaymentId) : null;
      const giftMatch = body.OrderId.match(/^kino-gift-(\d+)-/);
      const selfMatch = giftMatch ? null : body.OrderId.match(/^kino-(\d+)-/);
      if (giftMatch) {
        const buyerId = giftMatch[1];
        const token = await createGiftToken(buyerId, 'purchased', GIFT_PURCHASED_DAYS);
        try {
          await tgCall('sendMessage', {
            chat_id: buyerId,
            text: giftReadyText(token),
          });
        } catch (e) { /* best effort */ }
      } else if (selfMatch) {
        const telegramId = selfMatch[1];
        await markPaid(telegramId, paymentId);
        const bonusToken = await createGiftToken(telegramId, 'bonus', GIFT_BONUS_DAYS);
        try {
          await tgCall('sendMessage', {
            chat_id: telegramId,
            text: purchaseThanksText(bonusToken),
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

// --- Yandex Games in-app purchases ---
// payments.purchase({signed:true}) on the client returns only a signed
// receipt (no raw token) - verify it here with HMAC-SHA256 using the secret
// from the Developer Console, exactly as documented:
// https://yandex.ru/dev/games/doc/ru/sdk/sdk-purchases
function verifyYandexSignature(signature) {
  if (!signature || typeof signature !== 'string') return null;
  const parts = signature.split('.');
  if (parts.length !== 2) return null;
  const [sign, encodedData] = parts;
  try {
    const message = Buffer.from(encodedData, 'base64');
    const expected = crypto.createHmac('sha256', YANDEX_PAYMENTS_SECRET).update(message).digest('base64');
    if (sign !== expected) return null;
    return JSON.parse(message.toString());
  } catch (e) {
    return null;
  }
}

// In-memory de-dupe so a retried/duplicate request can't grant premium twice
// for the same purchase. Fine for a single-instance deployment; consumePurchase
// on the Yandex side (called by the client right after this succeeds) is the
// real source of truth that a purchase can't be redeemed again.
const _yaUsedTokens = new Set();

// Accepts both the single-purchase receipt from payments.purchase() and the list
// receipt from payments.getPurchases() (the startup check for unconsumed
// purchases that Yandex requires before moderation).
function extractYandexPurchases(parsed) {
  const d = parsed && parsed.data;
  const list = Array.isArray(d) ? d : d ? [d] : [];
  return list
    .map((x) => ({
      token: x.token || x.purchaseToken,
      productId: (x.product && x.product.id) || x.productID || x.productId,
      payerId: x.developerPayload,
    }))
    .filter((x) => x.token && x.productId);
}

app.post('/api/yandex/verify-purchase', async (req, res) => {
  if (!YANDEX_PAYMENTS_SECRET) return res.status(503).json({ error: 'yandex payments not configured yet' });
  const parsed = verifyYandexSignature(req.body.signature);
  if (!parsed) return res.status(400).json({ error: 'bad signature', detail: 'signature did not verify' });
  const purchases = extractYandexPurchases(parsed);
  if (!purchases.length) return res.status(400).json({ error: 'incomplete purchase data' });
  const tokens = [];
  for (const pu of purchases) {
    const days = YANDEX_PRODUCT_DAYS[pu.productId];
    const payerId = pu.payerId || req.body.yaPlayerId;
    if (!days || !payerId) continue;
    if (!_yaUsedTokens.has(pu.token)) {
      _yaUsedTokens.add(pu.token);
      try {
        await markPaid(payerId, pu.token, days);
      } catch (e) {
        _yaUsedTokens.delete(pu.token);
        console.error('yandex verify-purchase markPaid error:', e.message);
        return res.status(500).json({ error: 'server error' });
      }
    }
    tokens.push(pu.token);
  }
  if (!tokens.length) return res.status(400).json({ error: 'unknown product or payer' });
  res.json({ ok: true, token: tokens[0], tokens });
});

// --- VK Mini Apps in-app payments ---
// VK calls this URL itself (server-to-server, application/x-www-form-urlencoded)
// to ask what an item costs and to confirm a completed purchase - the game
// client never sees a receipt, it just polls /api/check-access afterward.
// Configure the notification URL in VK app admin -> Оплата -> Уведомления:
//   <PUBLIC_URL>/api/vk/payments
// https://dev.vk.com/ru/mini-apps/payments
function vkVerifySignature(params) {
  if (!params.sig) return false;
  const { sig, ...rest } = params;
  const sorted = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join('');
  const computed = crypto.createHash('md5').update(sorted + VK_PAYMENTS_SECRET).digest('hex');
  return computed === sig;
}

app.post('/api/vk/payments', async (req, res) => {
  const p = Object.assign({}, req.query, req.body);
  if (!VK_PAYMENTS_SECRET) return res.json({ error: { error_code: 10, error_msg: 'payments not configured', critical: true } });
  if (!vkVerifySignature(p)) return res.json({ error: { error_code: 10, error_msg: 'bad signature', critical: true } });

  if (p.notification_type === 'get_item' || p.notification_type === 'get_item_test') {
    if (!VK_PRODUCT_DAYS[p.item]) return res.json({ error: { error_code: 20, error_msg: 'Item not found', critical: true } });
    return res.json({ response: { item_id: p.item, title: 'Премиум на месяц', price: VK_PREMIUM_PRICE_VOTES } });
  }

  if (p.notification_type === 'order_status_change' && p.status === 'chargeable') {
    const days = VK_PRODUCT_DAYS[p.item];
    if (!days) return res.json({ error: { error_code: 20, error_msg: 'Item not found', critical: true } });
    try {
      await markPaid('vk_' + p.user_id, 'vk_order_' + p.order_id, days);
    } catch (e) {
      console.error('vk payments markPaid error:', e.message);
      return res.json({ error: { error_code: 100, error_msg: 'server error', critical: true } });
    }
    return res.json({ response: { order_id: Number(p.order_id), app_order_id: Number(p.order_id) } });
  }

  res.json({ response: 1 });
});

// ============================================================================
//  SUPPORT BOT — free, no AI. Fixed FAQ answers + a live payment-status check
//  + "leave a message for the developer". Every reply is a canned string, so
//  there is nothing to jailbreak.
// ============================================================================

const priceLine = () =>
  TBANK_ENABLED
    ? `${STARS_PRICE} Telegram Stars или ${TBANK_PRICE_RUB} ₽ картой/СБП`
    : `${STARS_PRICE} Telegram Stars`;

const FAQ = {
  play:
    '📖 Как играть\n\n' +
    'Настольная игра для компании 3–10 человек, играется прямо в Telegram, качать ничего не надо.\n\n' +
    '1. Один игрок создаёт комнату и кидает друзьям 4-буквенный код.\n' +
    '2. Каждый раунд один из игроков — судья: он выбирает жизненную ситуацию.\n' +
    '3. Остальные выкладывают самый смешной мем под эту ситуацию.\n' +
    '4. Судья выбирает лучший мем — его автор получает очко.\n' +
    '5. Судья меняется по кругу. Побеждает тот, кто первым набрал нужное число очков.',
  rubrics:
    '🧩 Рубрики и полный доступ\n\n' +
    'Бесплатно: «Мемы миллениалов» и «Мемы зумеров».\n\n' +
    'Полный доступ открывает «Кино и сериалы», «Микс из всех мемов» и все будущие рубрики, а также убирает рекламу.\n\n' +
    '👥 Платит один игрок в комнате — доступ получают все, кто зашёл по коду. Премиум действует месяц.\n\n' +
    '🎁 При покупке сразу получаешь ссылку, чтобы подарить другу неделю премиума бесплатно. Плюс можно в любой момент купить премиум в подарок другому игроку.',
  pay:
    '💳 Как оплатить\n\n' +
    'Открой игру → зайди в платную рубрику (с замком) → «Подключить премиум» → выбери способ:\n' +
    `• Telegram Stars\n• Карта / СБП${TBANK_ENABLED ? '' : ' (скоро)'}\n\n` +
    `Цена: ${priceLine()}. После оплаты доступ открывается сразу — просто вернись в игру. Если рубрика ещё с замком — полностью перезайди в игру.`,
};

const MENU = {
  inline_keyboard: [
    [{ text: '📖 Как играть', callback_data: 'faq:play' }],
    [{ text: '🧩 Рубрики и полный доступ', callback_data: 'faq:rubrics' }],
    [{ text: '💳 Как оплатить', callback_data: 'faq:pay' }],
    [{ text: '🧾 Проверить мою оплату', callback_data: 'faq:status' }],
    [{ text: '⭐ Оставить отзыв', callback_data: 'ask:review' }],
    [
      { text: '🐞 Баг или идея', callback_data: 'ask:bug' },
      { text: '✍️ Свой вопрос', callback_data: 'ask:question' },
    ],
  ],
};

const WELCOME =
  'Привет! Это поддержка игры «Мемы Миллениалов».\n' +
  'Выбери кнопку ниже или просто напиши свой вопрос — разработчик увидит.';

// --- lightweight per-user spam guard (in-memory) ---
const _rl = new Map(); // tgId -> [timestamps]
const RL_MAX = 20;
const RL_WINDOW_MS = 10 * 60 * 1000;
function rlOk(tgId) {
  const now = Date.now();
  const arr = (_rl.get(tgId) || []).filter((t) => now - t < RL_WINDOW_MS);
  arr.push(now);
  _rl.set(tgId, arr);
  return arr.length <= RL_MAX;
}

// --- "next message from this user is a bug report / free question" state ---
const _awaiting = new Map(); // tgId -> { mode: 'bug'|'question'|'review', ts }
const AWAIT_TTL_MS = 15 * 60 * 1000;

function fmtAgo(ms) {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 1) return 'меньше минуты назад';
  if (min < 60) return `${min} мин назад`;
  return `${Math.round(min / 60)} ч назад`;
}

async function paymentStatusText(tgId) {
  const [paidRec, pending] = await Promise.all([getPaidRecord(tgId), getPending(tgId)]);
  if (paidRec) {
    if (typeof paidRec.paidUntil === 'number') {
      if (paidRec.paidUntil <= Date.now()) {
        return (
          '🧾 Твой премиум закончился.\n\n' +
          'Чтобы продлить — открой игру, зайди в платную рубрику и нажми «Подключить премиум».'
        );
      }
      const daysLeft = Math.max(1, Math.ceil((paidRec.paidUntil - Date.now()) / DAY_MS));
      const until = new Date(paidRec.paidUntil).toISOString().slice(0, 10);
      return `🧾 Премиум активен ✅ ещё ${daysLeft} дн. (до ${until})\n\nЕсли в игре всё ещё замок — полностью закрой и снова открой игру: доступ подтянется.`;
    }
    return '🧾 Полный доступ у тебя активен ✅ (бессрочно, куплен до перехода на помесячную оплату)\n\nЕсли в игре всё ещё замок — полностью закрой и снова открой игру: доступ подтянется.';
  }
  if (pending && pending.startedAt) {
    const method = pending.method === 'card' ? 'картой/СБП' : 'через Telegram Stars';
    return (
      `🧾 Вижу начатую оплату ${method}, ${fmtAgo(pending.startedAt)}.\n` +
      'Подтверждения от платёжной системы ещё не было — обычно это занимает пару минут.\n\n' +
      'Если ты точно оплатил, а доступа так и нет — нажми «✍️ Свой вопрос» и опиши: способ оплаты, сумму и время. Разработчик проверит вручную.'
    );
  }
  return (
    '🧾 Оплат по твоему аккаунту не вижу.\n\n' +
    'Чтобы купить полный доступ — открой игру, зайди в платную рубрику и нажми «Подключить премиум».'
  );
}

async function logSupport(fromUser, text, kind) {
  try {
    await db.ref('support/' + fromUser.id).push({
      u: fromUser.username || fromUser.first_name || '',
      kind: kind || 'msg',
      q: String(text || '').slice(0, 2000),
      ts: admin.database.ServerValue.TIMESTAMP,
    });
  } catch (e) {
    console.error('logSupport error:', e.message);
  }
}

async function notifyOwner(fromUser, text, kind) {
  if (!OWNER_CHAT_ID) return;
  const who = fromUser.username ? '@' + fromUser.username : (fromUser.first_name || 'без имени');
  try {
    await tgCall('sendMessage', {
      chat_id: OWNER_CHAT_ID,
      text:
        `📨 ${kind === 'bug' ? 'БАГ/ИДЕЯ' : kind === 'review' ? 'ОТЗЫВ ⭐' : 'поддержка'} от ${who} (id ${fromUser.id}):\n\n` +
        `${String(text || '').slice(0, 2000)}\n\n` +
        `↩️ Ответь на это сообщение (свайп «Ответить») — бот перешлёт твой ответ игроку.`,
    });
  } catch (e) { /* best effort */ }
}

const OWNER = OWNER_CHAT_ID ? String(OWNER_CHAT_ID) : '';

// Owner swiped "Reply" on a 📨 forward -> relay that reply back to the player.
async function handleOwnerReply(msg) {
  const src = String((msg.reply_to_message && msg.reply_to_message.text) || '');
  const m = src.match(/\(id (\d+)\):/);
  if (!m) {
    await tgCall('sendMessage', {
      chat_id: OWNER,
      text: 'Не вижу id игрока в этом сообщении. Отвечай свайпом именно на уведомление «📨 …».',
    });
    return;
  }
  const targetId = m[1];
  const r = await tgCall('sendMessage', {
    chat_id: targetId,
    text: '💬 Ответ от поддержки:\n\n' + String(msg.text || '').slice(0, 3000),
  });
  await tgCall('sendMessage', {
    chat_id: OWNER,
    text: r.ok
      ? `✅ Отправлено игроку ${targetId}.`
      : `⚠️ Не смог отправить игроку ${targetId}. Возможно, он не начинал диалог с ботом или заблокировал его.`,
  });
}

async function sendMenu(chatId, text) {
  await tgCall('sendMessage', { chat_id: chatId, text, reply_markup: MENU });
}

// When a VPN cannot reach Amvera from the Mini App, Telegram can still deliver
// a /start deep link to the bot. The bot (running on Amvera) creates the same
// payment as the HTTP API; the phone never calls Amvera to obtain the link.
async function sendBotPayment(chatId, telegramId, method, isGift) {
  let alreadyPaid = false;
  try {
    if (!isGift) {
      const snap = await db.ref('paidUsers/' + telegramId).get();
      if (snap.exists()) {
        const record = snap.val() || {};
        alreadyPaid = typeof record.paidUntil !== 'number' || record.paidUntil > Date.now();
      }
    }
  } catch (e) {
    console.error('Bot payment access check failed:', e);
    return tgCall('sendMessage', { chat_id: chatId, text: 'Не удалось проверить текущий премиум. Чтобы избежать двойной оплаты, попробуй позже.' });
  }
  if (alreadyPaid) {
    return tgCall('sendMessage', {
      chat_id: chatId,
      text: '✅ Премиум уже активен. Если игра с VPN показывает замок, проблема в связи игры с сервером, а не в оплате. Не плати повторно.',
    });
  }

  if (method === 'stars') {
    const result = await tgCall('sendInvoice', {
      chat_id: chatId,
      title: isGift ? 'Премиум в подарок другу' : 'Премиум на месяц',
      description: isGift
        ? 'Премиум на месяц для друга. После оплаты бот пришлёт ссылку-подарок.'
        : 'Полный доступ ко всем рубрикам на месяц и неделя премиума другу в подарок.',
      payload: `${isGift ? 'gift_access' : 'full_access'}_${telegramId}_${Date.now()}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: isGift ? 'Премиум в подарок' : 'Премиум на месяц', amount: STARS_PRICE }],
      start_parameter: 'premium',
    });
    if (!result.ok) await tgCall('sendMessage', { chat_id: chatId, text: 'Не получилось создать счёт Stars. Попробуй позже или напиши в поддержку.' });
    else if (!isGift) markPending(telegramId, 'stars').catch(() => {});
    return;
  }

  if (!TBANK_ENABLED || !TBANK_RECEIPT_EMAIL || !PUBLIC_URL) {
    return tgCall('sendMessage', { chat_id: chatId, text: 'Оплата картой/СБП сейчас не настроена. Напиши в поддержку.' });
  }
  const orderId = `kino-${isGift ? 'gift-' : ''}${telegramId}-${Date.now()}`;
  const itemName = isGift ? 'Премиум в подарок (1 месяц)' : 'Премиум на месяц';
  let result;
  try {
    result = await tbankCall('Init', {
      Amount: TBANK_PRICE_RUB * 100,
      OrderId: orderId,
      Description: isGift
        ? 'Премиум в подарок другу на месяц — оплачивает даритель'
        : 'Премиум на месяц: все рубрики, без рекламы, плюс неделя в подарок другу',
      NotificationURL: `${PUBLIC_URL}/tbank-notification`,
      SuccessURL: `${PUBLIC_URL}/tbank-success`,
      FailURL: `${PUBLIC_URL}/tbank-fail`,
      Receipt: {
        Email: TBANK_RECEIPT_EMAIL,
        Taxation: TBANK_TAXATION,
        Items: [{
          Name: itemName,
          Price: TBANK_PRICE_RUB * 100,
          Quantity: 1,
          Amount: TBANK_PRICE_RUB * 100,
          Tax: 'none',
          PaymentMethod: 'full_payment',
          PaymentObject: 'service',
        }],
      },
    });
  } catch (e) {
    console.error('Bot T-Bank Init request failed:', e);
  }
  if (!result || !result.Success || !result.PaymentURL) {
    if (result) console.error('Bot T-Bank Init failed:', JSON.stringify(result));
    return tgCall('sendMessage', { chat_id: chatId, text: 'Не получилось создать ссылку на оплату картой/СБП. Попробуй позже или напиши в поддержку.' });
  }
  if (!isGift) markPending(telegramId, 'card').catch(() => {});
  return tgCall('sendMessage', {
    chat_id: chatId,
    text: `Ссылка на оплату ${isGift ? 'подарка' : 'премиума'} картой или через СБП готова. Нажми кнопку ниже:`,
    reply_markup: { inline_keyboard: [[{ text: '💳 Открыть страницу оплаты', url: result.PaymentURL }]] },
  });
}

async function handleCallback(cq) {
  const data = String(cq.data || '');
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : cq.from.id;
  const userId = cq.from.id;
  await tgCall('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});

  if (!rlOk(userId)) {
    await tgCall('sendMessage', { chat_id: chatId, text: 'Слишком часто. Подожди минуту 🙏' });
    return;
  }

  if (data === 'faq:play') return sendMenu(chatId, FAQ.play);
  if (data === 'faq:rubrics') return sendMenu(chatId, FAQ.rubrics);
  if (data === 'faq:pay') return sendMenu(chatId, FAQ.pay);
  if (data === 'faq:status') return sendMenu(chatId, await paymentStatusText(userId));

  if (data === 'ask:bug' || data === 'ask:question' || data === 'ask:review') {
    const mode = data === 'ask:bug' ? 'bug' : data === 'ask:review' ? 'review' : 'question';
    _awaiting.set(userId, { mode, ts: Date.now() });
    const t =
      mode === 'bug'
        ? '🐞 Опиши баг или идею одним сообщением: что делал, что пошло не так, телефон или ПК. Разработчик увидит и ответит здесь.'
        : mode === 'review'
        ? '⭐ Напиши свой отзыв об игре одним сообщением — что понравилось, что нет, чего не хватает. Разработчик всё прочитает.'
        : '✍️ Напиши свой вопрос одним сообщением — разработчик ответит здесь.';
    await tgCall('sendMessage', { chat_id: chatId, text: t });
    return;
  }

  return sendMenu(chatId, WELCOME);
}

async function handleTextMessage(msg) {
  const from = msg.from;
  const chatId = msg.chat.id;
  const raw = String(msg.text || '').trim();
  if (!raw) return;

  if (!rlOk(from.id)) {
    await tgCall('sendMessage', { chat_id: chatId, text: 'Слишком много сообщений подряд. Подожди пару минут 🙏' });
    return;
  }

  if (raw === '/start' || raw === '/help' || raw === '/menu' || raw.startsWith('/start ')) {
    if (raw.startsWith('/start ')) {
      const sp = raw.slice(7).trim();
      if (sp.indexOf('gift_') === 0) {
        _awaiting.delete(from.id);
        const token = sp.slice(5);
        const result = await claimGiftToken(token, from.id);
        if (result.ok) {
          await tgCall('sendMessage', {
            chat_id: chatId,
            text:
              `🎉 Тебе подарили ${result.days >= 30 ? 'месяц' : 'неделю'} премиума в «Мемах Миллениалов»! ` +
              'Все платные рубрики уже открыты, реклама убрана.',
            reply_markup: { inline_keyboard: [[{ text: '🎮 Открыть игру', url: 'https://t.me/meme_millennials_bot/meme_game' }]] },
          });
          tgCall('sendMessage', {
            chat_id: result.fromUid,
            text: '✅ Твой подарок принят другом — премиум ему уже открыт. Спасибо, что делишься игрой!',
          }).catch(() => {});
        } else {
          const why =
            result.reason === 'self'
              ? 'Нельзя подарить премиум самому себе 🙂'
              : result.reason === 'expired'
              ? 'Эта ссылка-подарок устарела (прошёл месяц) 😕'
              : 'Эта ссылка-подарок уже использована или недействительна 😕';
          await tgCall('sendMessage', { chat_id: chatId, text: why });
        }
        return sendMenu(chatId, WELCOME);
      }
      const paymentMatch = /^pay_(stars|card)(_gift)?$/.exec(sp);
      if (paymentMatch) {
        _awaiting.delete(from.id);
        if (msg.chat.type !== 'private') return sendMenu(chatId, 'Открой личный чат с ботом для оплаты.');
        return sendBotPayment(chatId, from.id, paymentMatch[1], !!paymentMatch[2]);
      }
      if (sp.indexOf('s_') === 0) trackSource(sp.slice(2), from.id).catch(() => {});
    }
    _awaiting.delete(from.id);
    return sendMenu(chatId, WELCOME);
  }

  const pend = _awaiting.get(from.id);
  if (pend && Date.now() - pend.ts < AWAIT_TTL_MS) {
    _awaiting.delete(from.id);
    await logSupport(from, raw, pend.mode);
    await notifyOwner(from, raw, pend.mode);
    await sendMenu(
      chatId,
      pend.mode === 'review'
        ? 'Спасибо за отзыв! 🙌 Разработчик всё прочитает. Если оставил вопрос — ответ придёт сюда же.'
        : 'Спасибо! Передал разработчику — ответ придёт сюда же. Пока можешь глянуть быстрые ответы:',
    );
    return;
  }

  // Any other free text: don't lose it — log + forward, then show the menu.
  await logSupport(from, raw, 'msg');
  await notifyOwner(from, raw, 'msg');
  await sendMenu(
    chatId,
    'Спасибо, разработчик увидит твоё сообщение. А пока — быстрые ответы ниже:',
  );
}

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
      const firstTime = await claimPaymentOnce('stars_' + sp.telegram_payment_charge_id);
      if (!firstTime) {
        console.log('successful_payment: duplicate delivery for', sp.telegram_payment_charge_id, '- skipping');
        return;
      }
      const payload = String(sp.invoice_payload || '');
      if (payload.startsWith('gift_access_')) {
        const token = await createGiftToken(msg.from.id, 'purchased', GIFT_PURCHASED_DAYS);
        await tgCall('sendMessage', { chat_id: msg.chat.id, text: giftReadyText(token) });
      } else {
        await markPaid(msg.from.id, sp.telegram_payment_charge_id);
        const bonusToken = await createGiftToken(msg.from.id, 'bonus', GIFT_BONUS_DAYS);
        await tgCall('sendMessage', { chat_id: msg.chat.id, text: purchaseThanksText(bonusToken) });
      }
      return;
    }

    if (update.callback_query) {
      await handleCallback(update.callback_query);
      return;
    }

    // Owner replied (swipe) to a 📨 forward -> relay to the player.
    if (
      OWNER &&
      update.message &&
      update.message.from &&
      String(update.message.from.id) === OWNER &&
      update.message.reply_to_message &&
      typeof update.message.text === 'string'
    ) {
      await handleOwnerReply(update.message);
      return;
    }

    if (update.message && typeof update.message.text === 'string' && update.message.from && !update.message.from.is_bot) {
      await handleTextMessage(update.message);
      return;
    }
  } catch (e) {
    console.error('webhook processing error:', e);
  }
});

const VERSION = 'support-bot 2026-09-26 (VPN payment fallback)';
app.get('/', (req, res) => res.send('meme-game-bot-server is running (' + VERSION + ')'));

app.listen(PORT, () => console.log(`Listening on port ${PORT} (${VERSION})`));
