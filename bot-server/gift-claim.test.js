const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = source.indexOf('async function claimGiftToken(');
const end = source.indexOf('\nasync function recordProcessedPayment(', start);
assert(start >= 0 && end > start);

function makeStore(initial) {
  const state = structuredClone(initial);
  let failGrant = false;
  const read = (key) => key.split('/').reduce((value, part) => value?.[part], state) ?? null;
  const write = (key, value) => {
    const parts = key.split('/');
    const last = parts.pop();
    const parent = parts.reduce((value, part) => (value[part] ??= {}), state);
    if (value === null) delete parent[last];
    else parent[last] = structuredClone(value);
  };
  const snapshot = (value) => ({ exists: () => value !== null, val: () => structuredClone(value) });
  return {
    state,
    failNextGrant: () => { failGrant = true; },
    ref: (key) => ({
      get: async () => snapshot(read(key)),
      update: async (patch) => {
        for (const [child, value] of Object.entries(patch)) write(key + '/' + child, value);
      },
      transaction: async (updater) => {
        if (failGrant && key.startsWith('paidUsers/')) {
          failGrant = false;
          throw new Error('temporary database failure');
        }
        const actual = read(key);
        // Firebase may first invoke a transaction with an empty local cache.
        let next = updater(null);
        if (next !== undefined && actual !== null) next = updater(actual);
        if (next === undefined) return { committed: false, snapshot: snapshot(actual) };
        write(key, next);
        return { committed: true, snapshot: snapshot(next) };
      },
    }),
  };
}

function makeClaim(db) {
  const context = { db, Date, console: { log() {}, error() {} },
    GIFT_BONUS_DAYS: 7, DAY_MS: 86400000, SERVER_TIMESTAMP: { '.sv': 'timestamp' } };
  return vm.runInNewContext(source.slice(start, end) + '\nclaimGiftToken;', context);
}

test('existing gift is claimed despite null-first Firebase transaction; retry is idempotent', async () => {
  const db = makeStore({ giftTokens: { abc: { fromUid: 'buyer', days: 7 } }, paidUsers: {} });
  const claim = makeClaim(db);
  const first = await claim('abc', 'friend');
  assert.equal(first.ok, true);
  assert.equal(db.state.giftTokens.abc.claimedBy, 'friend');
  assert.equal(db.state.paidUsers.friend.giftClaims.abc, true);
  const until = db.state.paidUsers.friend.paidUntil;
  const retry = await claim('abc', 'friend');
  assert.equal(retry.ok, true);
  assert.equal(db.state.paidUsers.friend.paidUntil, until);
  assert.equal((await claim('abc', 'someone-else')).reason, 'claimed');
});

test('a failed entitlement write can be retried by the same recipient', async () => {
  const db = makeStore({ giftTokens: { abc: { fromUid: 'buyer', days: 7 } }, paidUsers: {} });
  const claim = makeClaim(db);
  db.failNextGrant();
  assert.equal((await claim('abc', 'friend')).reason, 'error');
  assert.equal(db.state.paidUsers.friend, undefined);
  assert.equal((await claim('abc', 'friend')).ok, true);
});

test('a gift stacks on paid time without replacing an existing entitlement', async () => {
  const currentUntil = Date.now() + 30 * 86400000;
  const db = makeStore({ giftTokens: { abc: { fromUid: 'buyer', days: 7 } },
    paidUsers: { friend: { paidAt: 1, paidUntil: currentUntil, chargeId: 'existing' } } });
  assert.equal((await makeClaim(db)('abc', 'friend')).ok, true);
  assert.equal(db.state.paidUsers.friend.paidUntil, currentUntil + 7 * 86400000);
  assert.equal(db.state.paidUsers.friend.chargeId, 'existing');
});

test('missing, expired and self-gifts cannot be claimed', async () => {
  const db = makeStore({ giftTokens: {
    expired: { fromUid: 'buyer', days: 7, expiresAt: 1 },
    self: { fromUid: 'buyer', days: 7 },
  }, paidUsers: {} });
  const claim = makeClaim(db);
  assert.equal((await claim('missing', 'friend')).reason, 'not_found');
  assert.equal((await claim('expired', 'friend')).reason, 'expired');
  assert.equal((await claim('self', 'buyer')).reason, 'self');
  assert.deepEqual(db.state.paidUsers, {});
});
