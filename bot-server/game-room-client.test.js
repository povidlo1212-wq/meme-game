const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('var fbGameHeartbeatTimer=null;');
const end = html.indexOf("var COVER_URL=", start);
assert.ok(start >= 0 && end > start);
const roomClient = html.slice(start, end);

function makeClient(testMode) {
  const requests = [];
  const storage = new Map();
  const firebaseCalls = [];
  const context = {
    GAME_ROOMS_API_TEST: testMode,
    window: { crypto: { getRandomValues(bytes) { bytes.fill(7); } } },
    crypto: { getRandomValues(bytes) { bytes.fill(7); } },
    localStorage: {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); },
      removeItem(key) { storage.delete(key); }
    },
    fetchBackend(url, options) {
      requests.push({ url, options });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(url.includes('?code=') ? { alive: true } : { rooms: [{ code: '1234' }] }) });
    },
    initFirebase() { return true; },
    fbDB: { ref(name) { return { set(value) { firebaseCalls.push(['set', name, value]); }, remove() { firebaseCalls.push(['remove', name]); } }; } },
    console,
    Uint8Array,
    Array,
    setInterval() { return 1; },
    clearInterval() {},
    Date
  };
  vm.createContext(context);
  vm.runInContext(roomClient, context);
  return { context, requests, storage, firebaseCalls };
}

test('room API test mode uses Russian backend, never Firebase room discovery', async () => {
  const { context, requests, storage, firebaseCalls } = makeClient(true);
  context.fbUpdateGameRoom('1234', 'kino', 'lobby', true, 2);
  await new Promise(setImmediate);
  assert.equal(requests[0].url, '/api/game/rooms');
  assert.equal(JSON.parse(requests[0].options.body).key, '07'.repeat(16));
  assert.equal(JSON.parse(requests[0].options.body).action, 'upsert');
  assert.equal(firebaseCalls.length, 0);
  assert.equal(await new Promise(resolve => context.fbCheckGameRoomAlive('1234', resolve)), true);
  const rooms = await new Promise(resolve => context.fbFetchOpenGameRooms(resolve));
  assert.equal(rooms[0].code, '1234');
  context.fbRemoveGameRoom('1234');
  await new Promise(setImmediate);
  assert.equal(JSON.parse(requests[3].options.body).action, 'remove');
  assert.equal(storage.size, 0);
});

test('default room mode still writes and removes through Firebase', () => {
  const { context, requests, firebaseCalls } = makeClient(false);
  context.fbUpdateGameRoom('1234', 'kino', 'lobby', true, 2);
  context.fbRemoveGameRoom('1234');
  assert.equal(requests.length, 0);
  assert.equal(firebaseCalls[0][0], 'set');
  assert.equal(firebaseCalls[1][0], 'remove');
});
