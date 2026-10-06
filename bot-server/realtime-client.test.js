'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('opt-in browser client joins, reads, publishes and closes the Russian relay', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'realtime-client.js'), 'utf8');
  const calls = [];
  const received = [];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'));
      controller.enqueue(encoder.encode('data: {"name":"state","data":{"round":2}}\n\n'));
    }
  });
  const context = {
    window: {}, fetch: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/join')) return { ok: true, json: async () => ({ token: 'a'.repeat(64) }) };
      if (url.endsWith('/stream')) return { ok: true, body: stream };
      return { ok: true, json: async () => ({ delivered: 1 }) };
    },
    AbortController, TextDecoder, setTimeout, clearTimeout, console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const client = context.window.createRussianRealtimeClient('https://example.test', '1234', 'signed',
    (name, data) => received.push({ name, data }));
  await client.connect();
  assert.equal(client.connection.state, 'connected');
  assert.equal(calls[0].url, 'https://example.test/api/game/realtime/join');
  assert.match(calls[0].options.body, /"initData":"signed"/);
  assert.equal(calls[1].options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
  await client.publish('action', { type: 'request_state' });
  assert.equal(calls[2].url, 'https://example.test/api/game/realtime/publish');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer ' + 'a'.repeat(64));
  await new Promise(setImmediate);
  assert.deepEqual(received.map((item) => item.name), ['state']);
  assert.equal(received[0].data.round, 2);
  client.close();
  assert.equal(client.connection.state, 'closed');
});
