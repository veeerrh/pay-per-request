// One public door (D-25): path prefixes route to the local services so a single HTTPS tunnel serves everything.
//   /registry -> :4000   /atlas :4011  /tremor :4012  /brief :4013  /overquote :4021  /redirect :4022  /hollow :4023  /offline :4024
//   everything else -> Beacon :4100 (dashboard, buyer API, live events)
// No compression or buffering is added, so server-sent events stream straight through.
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const ROUTES = { registry: 4000, atlas: 4011, tremor: 4012, brief: 4013, overquote: 4021, redirect: 4022, hollow: 4023, offline: 4024 };

function createGateway({ routes = ROUTES, beacon = 4100, host = '127.0.0.1' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Refuse any attempt to climb out of a prefix: dot segments or encoded slashes and dots never reach an upstream.
  app.use((req, res, next) => (/(^|\/)\.\.(\/|$|\?)|%2e|%2f|%5c|\\/i.test(req.url) ? res.status(400).json({ error: 'bad_path' }) : next()));
  app.get('/gateway/health', (_req, res) => res.json({ ok: true, routes: Object.keys(routes) }));
  for (const [prefix, port] of Object.entries(routes)) {
    app.use(createProxyMiddleware({
      pathFilter: (p) => p === `/${prefix}` || p.startsWith(`/${prefix}/`) || p.startsWith(`/${prefix}?`),
      target: `http://${host}:${port}`,
      pathRewrite: { [`^/${prefix}`]: '' },
      changeOrigin: false, // keep the public Host header so the seller's 402 names the public URL
      proxyTimeout: 130000, timeout: 130000,
      on: { error: (err, _req, res) => { if (res.writeHead && !res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'upstream_unreachable', service: prefix })); } } },
    }));
  }
  app.use(createProxyMiddleware({
    target: `http://${host}:${beacon}`, changeOrigin: false, proxyTimeout: 0, timeout: 0,
    on: { error: (err, _req, res) => { if (res.writeHead && !res.headersSent) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'beacon_unreachable' })); } } },
  }));
  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  createGateway().listen(port, () => console.log(`gateway on :${port}`));
}
module.exports = { createGateway, ROUTES };
