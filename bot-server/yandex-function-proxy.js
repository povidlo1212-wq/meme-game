'use strict';

// Public Yandex Cloud Function entry point: yandex-function-proxy.handler.
// Narrow bridge to game data and Telegram premium-status checks on Amvera.
// Never proxy bot or payment-creation routes.
const AMVERA_ORIGIN = 'https://memy-millenialov-marco.amvera.io';
const GAME_ORIGIN = 'https://povidlo1212-wq.github.io';
const MAX_BODY_CHARS = 4096;

function response(statusCode, body, origin, contentType = 'application/json; charset=utf-8') {
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (origin === GAME_ORIGIN) headers['Access-Control-Allow-Origin'] = GAME_ORIGIN;
  return { statusCode, headers, body: String(body), isBase64Encoded: false };
}

module.exports.handler = async function handler(event = {}) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin || '';
  const method = String(event.httpMethod || 'GET').toUpperCase();
  const query = event.queryStringParameters || {};
  const operation = String(query.op || 'probe');

  if (origin && origin !== GAME_ORIGIN) {
    return response(403, JSON.stringify({ error: 'origin not allowed' }), origin);
  }
  if (method === 'OPTIONS') return response(204, '', origin);

  let path;
  if (operation === 'probe' && method === 'GET') {
    path = '/';
  } else if (operation === 'rooms' && (method === 'GET' || method === 'POST')) {
    path = '/api/game/rooms';
  } else if (operation === 'leaderboard' && (method === 'GET' || method === 'POST')) {
    path = '/api/game/leaderboard';
  } else if (operation === 'access' && method === 'POST') {
    path = '/api/check-access';
  } else {
    return response(404, JSON.stringify({ error: 'route not found' }), origin);
  }

  const url = new URL(path, AMVERA_ORIGIN);
  if (operation === 'rooms' && method === 'GET' && query.code != null) {
    if (!/^\d{4}$/.test(String(query.code))) {
      return response(400, JSON.stringify({ error: 'invalid room code' }), origin);
    }
    url.searchParams.set('code', String(query.code));
  }

  const options = { method, signal: AbortSignal.timeout(8000) };
  if (method === 'POST') {
    if (event.isBase64Encoded || typeof event.body !== 'string' ||
        event.body.length > MAX_BODY_CHARS) {
      return response(400, JSON.stringify({ error: 'invalid request body' }), origin);
    }
    let parsed;
    try { parsed = JSON.parse(event.body); } catch {
      return response(400, JSON.stringify({ error: 'invalid JSON' }), origin);
    }
    if (operation === 'access' &&
        (!parsed || typeof parsed.initData !== 'string' ||
         !parsed.initData || parsed.initData.length > 4000)) {
      return response(400, JSON.stringify({ error: 'invalid access request' }), origin);
    }
    options.headers = { 'Content-Type': 'application/json' };
    options.body = operation === 'access'
      ? JSON.stringify({ initData: parsed.initData })
      : event.body;
  }

  try {
    const upstream = await fetch(url, options);
    const body = await upstream.text();
    if (body.length > 262144) {
      return response(502, JSON.stringify({ error: 'upstream response too large' }), origin);
    }
    return response(
      upstream.status,
      body,
      origin,
      operation === 'probe' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    );
  } catch {
    // Do not leak IPs, request bodies, player IDs or backend details into logs.
    return response(502, JSON.stringify({ error: 'Amvera is unreachable from the proxy' }), origin);
  }
};
