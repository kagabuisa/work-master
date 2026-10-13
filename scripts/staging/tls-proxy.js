'use strict';
// Loopback-only staging TLS termination, with one fixed private upstream.
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');

function headers(input) {
  const blocked = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
  for (const name of String(input.connection || '').split(',')) blocked.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(input).filter(([key]) => !blocked.has(key.toLowerCase())));
}

function serve(req, res) {
  if (!req.url.startsWith('/') || req.url.startsWith('//') || req.url.length > 8192) { res.writeHead(400); res.end(); return; }
  const forwarded = headers(req.headers);
  const port = process.env.STAGING_HTTPS_PORT || '3443';
  if (![ `localhost:${port}`, `127.0.0.1:${port}`, 'staging-proxy:8443' ].includes(req.headers.host)) {
    res.writeHead(421); res.end(); return;
  }
  // Never trust caller-supplied proxy metadata. The app is not host-published.
  forwarded.host = req.headers.host;
  forwarded['x-forwarded-host'] = forwarded.host;
  forwarded['x-forwarded-proto'] = 'https';
  forwarded['x-forwarded-for'] = req.socket.remoteAddress;
  delete forwarded.forwarded;
  const upstream = http.request({ hostname: 'staging-app', port: 3020, path: req.url, method: req.method, headers: forwarded }, response => {
    res.writeHead(response.statusCode, headers(response.headers));
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.setTimeout(20000, () => upstream.destroy());
  upstream.on('error', () => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'staging_upstream_unavailable', message: 'Staging upstream unavailable.' } }));
  });
  req.on('aborted', () => upstream.destroy());
  req.on('error', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

if (require.main === module) {
  const server = https.createServer({ key: fs.readFileSync('/staging-tls/server.key'), cert: fs.readFileSync('/staging-tls/server.crt'), minVersion: 'TLSv1.2' }, serve);
  server.headersTimeout = 15000;
  server.requestTimeout = 20000;
  server.listen(8443, () => console.log('Local staging TLS proxy ready.'));
}
module.exports = { headers };
