'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createRoomHub } = require('./realtime-room-hub');

// Opt-in transport for the Russian realtime relay. It stays disabled in the
// production server until the mobile route is reliable; Ably remains live.
function createRealtimeRouter(validateInitData) {
  const router = express.Router();
  const hub = createRoomHub();
  const sessions = new Map();

  function tokenFrom(req) {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(req.get('Authorization') || '');
    return match && match[1];
  }

  function closeSession(token) {
    const session = sessions.get(token);
    if (!session) return;
    sessions.delete(token);
    clearTimeout(session.joinTimer);
    hub.leave(session.peer);
  }

  router.post('/join', (req, res) => {
    if (!validateInitData(req.body && req.body.initData)) {
      return res.status(401).json({ error: 'invalid initData' });
    }
    const code = req.body && req.body.code;
    if (typeof code !== 'string' || !/^\d{4}$/.test(code)) {
      return res.status(400).json({ error: 'invalid room code' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const session = { response: null, peer: null, joinTimer: null };
    session.peer = {
      send(message) {
        if (!session.response || !session.response.write(`data: ${message}\n\n`)) {
          throw new Error('recipient disconnected or too slow');
        }
      },
    };
    try {
      hub.join(code, session.peer);
    } catch (error) {
      return res.status(429).json({ error: error.message });
    }
    // A join that never opens its stream must not occupy a room indefinitely.
    session.joinTimer = setTimeout(() => closeSession(token), 30000);
    session.joinTimer.unref();
    sessions.set(token, session);
    res.set('Cache-Control', 'no-store').json({ token });
  });

  router.get('/stream', (req, res) => {
    const token = tokenFrom(req);
    const session = sessions.get(token);
    if (!session || session.response) return res.status(401).end();
    clearTimeout(session.joinTimer);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    session.response = res;
    // Send enough initial bytes for proxies that buffer very small chunks.
    res.write(`: connected ${' '.repeat(2048)}\n\n`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
    heartbeat.unref();
    res.on('close', () => {
      clearInterval(heartbeat);
      closeSession(token);
    });
  });

  router.post('/publish', (req, res) => {
    const session = sessions.get(tokenFrom(req));
    if (!session || !session.response) return res.status(401).json({ error: 'not connected' });
    try {
      const delivered = hub.publish(session.peer, req.body && req.body.name, req.body && req.body.data);
      res.json({ delivered });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createRealtimeRouter };
