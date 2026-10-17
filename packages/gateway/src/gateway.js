// One public door (D-25): path prefixes route to the local services so a single HTTPS tunnel serves everything.
//   /registry -> :4000   /atlas :4011  /tremor :4012  /brief :4013  /overquote :4021  /redirect :4022  /hollow :4023  /offline :4024  /relay :4014
//   everything else -> Beacon :4100 (dashboard, buyer API, live events)
// A tiny hand-written proxy on purpose (no proxy library, so nothing extra to audit). It adds no compression or
// buffering, so server-sent events stream straight through.
const http = require('http');

const ROUTES = { registry: 4000, atlas: 4011, tremor: 4012, brief: 4013, overquote: 4021, redirect: 4022, hollow: 4023, offline: 4024, relay: 4014 };
const json = (res, status, body) => { if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

function forward(req, res, { host, port, path, timeoutMs, label, scheme }) {
  const headers = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress || '', 'x-forwarded-proto': req.headers['x-forwarded-proto'] || scheme || 'http' };
  const up = http.request({ host, port, method: req.method, path, headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  if (timeoutMs) up.setTimeout(timeoutMs, () => up.destroy(new Error('upstream timeout')));
  up.on('error', () => json(res, 502, { error: label === 'beacon' ? 'beacon_unreachable' : 'upstream_unreachable', service: label }));
  res.on('close', () => up.destroy());
  req.pipe(up);
}

/** Returns a plain (req, res) handler, usable with http.createServer. */
function createGateway({ routes = ROUTES, beacon = 4100, host = '127.0.0.1' } = {}) {
  return (req, res) => {
    // Refuse any attempt to climb out of a prefix: dot segments, encoded slashes and backslashes never reach an upstream.
    if (/(^|\/)\.\.(\/|$|\?)|%2e|%2f|%5c|\\/i.test(req.url)) return json(res, 400, { error: 'bad_path' });
    if (req.url === '/gateway/health') return json(res, 200, { ok: true, routes: Object.keys(routes) });
    for (const [prefix, port] of Object.entries(routes)) {
      const p = `/${prefix}`;
      if (req.url === p || req.url.startsWith(`${p}/`) || req.url.startsWith(`${p}?`)) {
        const rest = req.url.slice(p.length);
        return forward(req, res, { host, port, path: rest.startsWith('/') ? rest : `/${rest}`, timeoutMs: 130000, label: prefix });
      }
    }
    return forward(req, res, { host, port: beacon, path: req.url, timeoutMs: 0, label: 'beacon' });
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  http.createServer(createGateway()).listen(port, () => console.log(`gateway on :${port}`));
}
module.exports = { createGateway, ROUTES };
