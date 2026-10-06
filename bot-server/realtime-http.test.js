'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { createRealtimeRouter } = require('./realtime-http');

test('authenticated peers exchange room events without echo or cross-room delivery', async () => {
  const app = express();
  app.use(express.json());
  app.use('/relay', createRealtimeRouter((value) => value === 'signed'));
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/relay`;
  const controllers = [];
  try {
    const post = (path, body, token) => fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal((await post('/join', { code: '1234', initData: 'forged' })).status, 401);
    assert.equal((await post('/join', { code: 'bad', initData: 'signed' })).status, 400);
    const join = async (code) => {
      const response = await post('/join', { code, initData: 'signed' });
      assert.equal(response.status, 200);
      return (await response.json()).token;
    };
    const host = await join('1234');
    const guest = await join('1234');
    const other = await join('5678');
    assert.equal((await post('/publish', { name: 'state', data: {} }, host)).status, 401);
    const open = async (token) => {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(base + '/stream', {
        headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
      });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      await reader.read(); // Initial connected comment.
      return reader;
    };
    const hostReader = await open(host);
    const guestReader = await open(guest);
    const otherReader = await open(other);
    const sent = await post('/publish', { name: 'state', data: { round: 1 } }, host);
    assert.equal(sent.status, 200);
    assert.deepEqual(await sent.json(), { delivered: 1 });
    const received = new TextDecoder().decode((await guestReader.read()).value);
    assert.match(received, /"name":"state"/);
    assert.match(received, /"round":1/);
    assert.equal((await post('/publish', { name: 'unknown', data: {} }, guest)).status, 400);
    assert.equal((await post('/publish', { name: 'action', data: {} }, other)).status, 200);
    // Neither host nor other-room peer receives the state event.
    hostReader.cancel();
    otherReader.cancel();
    guestReader.cancel();
  } finally {
    controllers.forEach((controller) => controller.abort());
    await new Promise((resolve) => server.close(resolve));
  }
});
