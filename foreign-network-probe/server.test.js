'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { handler } = require('./server');

test('probe answers only GET health requests and does not reflect input', async () => {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const ok = await fetch(`${base}/`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'Foreign network probe is reachable');
    assert.equal(ok.headers.get('cache-control'), 'no-store');

    const unknown = await fetch(`${base}/?telegram_id=123`);
    assert.equal(unknown.status, 404);
    assert.equal(await unknown.text(), 'Not found');

    const post = await fetch(`${base}/health`, { method: 'POST', body: 'secret' });
    assert.equal(post.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
