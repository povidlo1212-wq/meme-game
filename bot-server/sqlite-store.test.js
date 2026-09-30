const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openSqliteStore } = require('./sqlite-store');

test('Firebase-style reads, atomic claims, queries, and restart durability', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-sqlite-test-'));
  const file = path.join(dir, 'data.sqlite');
  let store = await openSqliteStore(file);
  await store.ref('paidUsers/42').set({ paidUntil: 123, paidAt: { '.sv': 'timestamp' } });
  const paid = (await store.ref('paidUsers/42').get()).val();
  assert.equal(paid.paidUntil, 123);
  assert.equal(typeof paid.paidAt, 'number');

  const first = await store.ref('processedPayments/pay1').transaction((current) => current ? undefined : { at: 1 });
  const repeat = await store.ref('processedPayments/pay1').transaction((current) => current ? undefined : { at: 2 });
  assert.equal(first.committed, true);
  assert.equal(repeat.committed, false);
  assert.equal((await store.ref('processedPayments/pay1').get()).val().at, 1);

  await store.ref('giftTokens/a').set({ fromUid: '42', createdAt: 1 });
  await store.ref('giftTokens/b').set({ fromUid: '99', createdAt: 2 });
  await store.ref('giftTokens/c').set({ fromUid: '42', createdAt: 3 });
  const matching = await store.ref('giftTokens').orderByChild('fromUid').equalTo('42').limitToLast(20).get();
  const keys = [];
  matching.forEach((snap) => { keys.push(snap.key); });
  assert.deepEqual(keys, ['a', 'c']);

  await store.ref('userProfiles/42').update({ first_name: 'A', username: 'b' });
  assert.deepEqual((await store.ref('userProfiles/42').get()).val(), { first_name: 'A', username: 'b' });
  await store.ref('pendingPayments/42').set({ method: 'stars' });
  await store.ref('pendingPayments/42').remove();
  assert.equal((await store.ref('pendingPayments/42').get()).exists(), false);

  store.close();
  store = await openSqliteStore(file, { requireExisting: true });
  assert.equal((await store.ref('paidUsers/42').get()).val().paidUntil, 123);
  assert.equal((await store.ref('processedPayments/pay1').get()).val().at, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing imported file is not treated as an empty payment database', async () => {
  const missing = path.join(os.tmpdir(), 'meme-missing-' + Date.now() + '.sqlite');
  await assert.rejects(openSqliteStore(missing, { requireExisting: true }), /missing/);
});
