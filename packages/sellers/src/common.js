// Shared bootstrap for every seller process. A seller holds ONLY a receiving address, never a private key (M-71).
// It deliberately does NOT load .env: the launcher passes an explicit allowlist of variables (scripts/lib/services.js).
const path = require('path');
const fs = require('fs');
const { createSellerApp } = require('./kit');

const ROOT = path.join(__dirname, '..', '..', '..');
const addresses = require(path.join(ROOT, 'config', 'addresses.json'));

/** Starts a seller unless it is being required by a test. */
function boot(name, port, appOpts, requiredBy) {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const app = createSellerApp({
    name,
    payTo: process.env.PAY_TO || addresses.sellers[name],
    claimsDb: process.env.CLAIMS_DB || path.join(ROOT, 'data', `seller-${name}.db`),
    facilitatorUrl: process.env.FACILITATOR_URL,
    ...appOpts,
  });
  if (require.main === requiredBy) {
    const p = Number(process.env.PORT || port);
    app.listen(p, () => console.log(`${name} seller on :${p}, payTo ${process.env.PAY_TO || addresses.sellers[name]}`));
  }
  return app;
}

module.exports = { boot, ROOT, addresses };
