'use strict';

// Temporary connectivity check. No player data, payments, or game routes.
// Deploy as a Yandex Cloud Function with entry point yandex-network-probe.handler.
const AMVERA_HEALTH_URL = 'https://memy-millenialov-marco.amvera.io/';

function reply(statusCode, payload) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(payload),
    isBase64Encoded: false,
  };
}

module.exports.handler = async function handler(event = {}) {
  if (String(event.httpMethod || 'GET').toUpperCase() !== 'GET') {
    return reply(405, { error: 'method_not_allowed' });
  }

  const check = String(event.queryStringParameters?.check || 'entry');
  if (check === 'entry') return reply(200, { yandex: 'reachable' });
  if (check !== 'amvera') return reply(400, { error: 'unknown_check' });

  try {
    const upstream = await fetch(AMVERA_HEALTH_URL, {
      method: 'GET',
      signal: AbortSignal.timeout(8000),
    });
    return reply(upstream.ok ? 200 : 502, {
      yandex: 'reachable',
      amvera: upstream.ok ? 'reachable' : 'http_error',
      upstreamStatus: upstream.status,
    });
  } catch {
    return reply(502, { yandex: 'reachable', amvera: 'connection_failed' });
  }
};
