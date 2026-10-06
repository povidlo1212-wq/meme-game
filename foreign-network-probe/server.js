'use strict';

const http = require('node:http');

const port = Number(process.env.PORT || 3000);

function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method !== 'GET' || (req.url !== '/' && req.url !== '/health')) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  res.statusCode = 200;
  res.end('Foreign network probe is reachable');
}

if (require.main === module) {
  http.createServer(handler).listen(port, '0.0.0.0', () => {
    console.log(`Network probe listening on port ${port}`);
  });
}

module.exports = { handler };
