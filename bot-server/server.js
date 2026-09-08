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

// Support bot — optional: your own Telegram chat id to receive a copy of every
// support message / bug report players send. Get it from @userinfobot.
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || '';

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

async function getPaidRecord(telegramId) {
  try {
    const snap = await db.ref('paidUsers/' + telegramId).get();
    return snap.exists() ? snap.val() : null;
  } catch (e) {
    console.error('getPaidRecord error:', e.message);
    return null;
  }
}

async function markPaid(telegramId, chargeId) {
  try {
    await db.ref('paidUsers/' + telegramId).set({
      paidAt: admin.database.ServerValue.TIMESTAMP,
      chargeId: chargeId || null,
    });
    await db.ref('pendingPayments/' + telegramId).remove().catch(() => {});
  } catch (e) {
    console.error('markPaid error:', e.message);
  }
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
async function trackSource(src, uid) {
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
  } catch (e) {
    console.error('trackSource error:', e.message);
  }
}

app.post('/api/track', async (req, res) => {
  const user = validateInitData(req.body.initData);
  if (!user) return res.json({ ok: false });
  await trackSource(req.body.source, user.id);
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
      out[src] = {
        unique_users: v[src].total || Object.keys(v[src].users || {}).length,
        daily: v[src].daily || {},
      };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    description: 'Полный доступ ко всем платным рубрикам и без рекламы. Оплачивает один игрок в комнате — играют все по коду. Навсегда, разовая покупка.',
    payload: `full_access_${user.id}_${Date.now()}`,
    currency: 'XTR',
    prices: [{ label: 'Полный доступ', amount: STARS_PRICE }],
  });

  if (!result.ok) return res.status(502).json({ error: 'telegram api error' });
  markPending(user.id, 'stars').catch(() => {});
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
      Description: 'Полный доступ: все рубрики, без рекламы, один платит — играют все',
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
  markPending(user.id, 'card').catch(() => {});
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
      const m = body.OrderId.match(/^kino-(\d+)-/);
      if (m) {
        const telegramId = m[1];
        await markPaid(telegramId, body.PaymentId ? String(body.PaymentId) : null);
        try {
          await tgCall('sendMessage', {
            chat_id: telegramId,
            text: 'Спасибо за покупку! Полный доступ открыт 🎉 Возвращайся в игру — все платные рубрики уже разблокированы.',
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
    '👥 Платит один игрок в комнате — полный доступ получают все, кто зашёл по коду. Покупка навсегда, разовая.',
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
const _awaiting = new Map(); // tgId -> { mode: 'bug'|'question', ts }
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
    const d = paidRec.paidAt ? ' (' + new Date(paidRec.paidAt).toISOString().slice(0, 10) + ')' : '';
    return `🧾 Полный доступ у тебя активен ✅${d}\n\nЕсли в игре всё ещё замок — полностью закрой и снова открой игру: доступ подтянется.`;
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
        `📨 ${kind === 'bug' ? 'БАГ/ИДЕЯ' : 'поддержка'} от ${who} (id ${fromUser.id}):\n\n` +
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

  if (data === 'ask:bug' || data === 'ask:question') {
    _awaiting.set(userId, { mode: data === 'ask:bug' ? 'bug' : 'question', ts: Date.now() });
    const t =
      data === 'ask:bug'
        ? '🐞 Опиши баг или идею одним сообщением: что делал, что пошло не так, телефон или ПК. Разработчик увидит и ответит здесь.'
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
      'Спасибо! Передал разработчику — ответ придёт сюда же. Пока можешь глянуть быстрые ответы:',
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
      await markPaid(msg.from.id, sp.telegram_payment_charge_id);
      await tgCall('sendMessage', {
        chat_id: msg.chat.id,
        text: 'Спасибо за покупку! Полный доступ открыт 🎉 Возвращайся в игру — все платные рубрики уже разблокированы.',
      });
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

const VERSION = 'support-bot 2026-09-08';
app.get('/', (req, res) => res.send('meme-game-bot-server is running (' + VERSION + ')'));

app.listen(PORT, () => console.log(`Listening on port ${PORT} (${VERSION})`));
