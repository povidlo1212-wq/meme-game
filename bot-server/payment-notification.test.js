const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openSqliteStore } = require('./sqlite-store');

test('confirmed card payment grants premium, retries safely, and rejects bad notifications', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-payment-test-'));
  const file = path.join(dir, 'payments.sqlite');
  const seed = await openSqliteStore(file);
  await seed.ref('paidUsers/existing').set({ paidUntil: Date.now() + 1000 });
  await seed.ref('processedPayments/tbank_kino-7710810536-1791540000000').set({ at: 1 });
  seed.close();

  Object.assign(process.env, {
    BOT_TOKEN: 'test-token', WEBHOOK_SECRET: 'test-webhook', DB_BACKEND: 'sqlite',
    SQLITE_DB_PATH: file, TBANK_TERMINAL_KEY: 'test-terminal', TBANK_PASSWORD: 'test-password',
    TBANK_PRICE_RUB: '149',
  });
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).includes('api.telegram.org')) return { json: async () => ({ ok: true }) };
    return originalFetch(url, options);
  };
  const { app, initializeStorage } = require('./server');
  let server;
  try {
    await initializeStorage();
    server = app.listen(0);
    const url = `http://127.0.0.1:${server.address().port}/tbank-notification`;
    const token = (body) => {
      const signed = { ...body, Password: 'test-password' };
      return crypto.createHash('sha256').update(Object.keys(signed).sort().map((key) => String(signed[key])).join('')).digest('hex');
    };
    const body = {
      TerminalKey: 'test-terminal', OrderId: 'kino-7710810536-1791540000000',
      PaymentId: 'payment-123', Amount: 14900, Success: true, Status: 'CONFIRMED', ErrorCode: '0',
    };
    const send = async (payload) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal((await send({ ...body, Token: 'wrong' })).status, 401);
    assert.equal((await send({ ...body, Amount: 1, Token: token({ ...body, Amount: 1 }) })).status, 400);

    assert.equal((await send({ ...body, Token: token(body) })).status, 200);
    const inspect = await openSqliteStore(file, { requireExisting: true });
    const granted = (await inspect.ref('paidUsers/7710810536').get()).val();
    assert.equal(granted.chargeId, body.PaymentId);
    assert.ok(granted.paidUntil > Date.now());
    assert.equal((await inspect.ref('processedPayments/tbank_' + body.OrderId).get()).val().state, 'completed');
    const gifts = (await inspect.ref('paymentGiftTokens').get()).val();
    assert.equal(Object.keys(gifts).length, 1);

    assert.equal((await send({ ...body, Token: token(body) })).status, 200);
    assert.equal((await inspect.ref('paidUsers/7710810536').get()).val().paidUntil, granted.paidUntil);
    assert.equal(Object.keys((await inspect.ref('paymentGiftTokens').get()).val()).length, 1);
    inspect.close();
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
