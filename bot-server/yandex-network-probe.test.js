'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('./yandex-network-probe');

test('entry check never calls Amvera', async () => {
  const previous = global.fetch;
  global.fetch = () => { throw new Error('must not fetch'); };
  try {
    const result = await handler({ httpMethod: 'GET' });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { yandex: 'reachable' });
  } finally {
    global.fetch = previous;
  }
});

test('Amvera check uses only the fixed health URL', async () => {
  const previous = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://memy-millenialov-marco.amvera.io/');
    assert.equal(options.method, 'GET');
    return { ok: true, status: 200 };
  };
  try {
    const result = await handler({
      httpMethod: 'GET',
      queryStringParameters: { check: 'amvera', url: 'https://example.com/' },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(JSON.parse(result.body).amvera, 'reachable');
  } finally {
    global.fetch = previous;
  }
});

test('bad methods and unknown checks are rejected', async () => {
  assert.equal((await handler({ httpMethod: 'POST' })).statusCode, 405);
  assert.equal((await handler({ queryStringParameters: { check: 'other' } })).statusCode, 400);
});
