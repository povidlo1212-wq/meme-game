'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { handler } = require('./yandex-function-proxy');

test('probe forwards only to the Amvera root', async () => {
  const oldFetch = global.fetch;
  const called = [];
  global.fetch = async (url, options) => {
    called.push([String(url), options.method]);
    return { status: 200, text: async () => 'meme-game-bot-server is running' };
  };
  try {
    const result = await handler({ httpMethod: 'GET', queryStringParameters: { op: 'probe' } });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(called, [['https://memy-millenialov-marco.amvera.io/', 'GET']]);
  } finally { global.fetch = oldFetch; }
});

test('game routes are allowlisted and preserve only validated data', async () => {
  const oldFetch = global.fetch;
  const called = [];
  global.fetch = async (url, options) => {
    called.push([String(url), options]);
    return { status: 200, text: async () => '{"rooms":[]}' };
  };
  try {
    const rooms = await handler({ httpMethod: 'GET', queryStringParameters: { op: 'rooms', code: '1234' } });
    assert.equal(rooms.statusCode, 200);
    assert.equal(called[0][0], 'https://memy-millenialov-marco.amvera.io/api/game/rooms?code=1234');

    const body = JSON.stringify({ code: '1234', key: 'a'.repeat(32), action: 'remove' });
    const update = await handler({
      httpMethod: 'POST',
      headers: { origin: 'https://povidlo1212-wq.github.io' },
      queryStringParameters: { op: 'rooms' }, body,
    });
    assert.equal(update.statusCode, 200);
    assert.equal(called[1][1].body, body);
    assert.equal(update.headers['Access-Control-Allow-Origin'], 'https://povidlo1212-wq.github.io');

    const denied = await handler({ httpMethod: 'POST', queryStringParameters: { op: 'payments' }, body });
    assert.equal(denied.statusCode, 404);
    assert.equal(called.length, 2);

    const invalid = await handler({ httpMethod: 'GET', queryStringParameters: { op: 'rooms', code: '../pay' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(called.length, 2);
  } finally { global.fetch = oldFetch; }
});

test('preflight, foreign origins and backend failures are handled without forwarding private data', async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => { throw new Error('network details'); };
  try {
    const preflight = await handler({ httpMethod: 'OPTIONS', headers: { origin: 'https://povidlo1212-wq.github.io' } });
    assert.equal(preflight.statusCode, 204);
    const foreign = await handler({ httpMethod: 'GET', headers: { origin: 'https://unrelated.example' } });
    assert.equal(foreign.statusCode, 403);
    const offline = await handler({ httpMethod: 'GET', queryStringParameters: { op: 'leaderboard' } });
    assert.equal(offline.statusCode, 502);
    assert.doesNotMatch(offline.body, /network details/);
  } finally { global.fetch = oldFetch; }
});
