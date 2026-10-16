// Offline: listed 0.004. Its handler throws on every request, after payment verification, so nothing is settled (scraping).
const { boot } = require('../common');

function createOffline(opts = {}) {
  return boot('offline', 4024, {
    method: 'GET', path: '/countries', priceUnits: '4000',
    description: 'Test vendor: always fails after verify, never charges.',
    handler: async () => { throw new Error('offline vendor always fails'); },
  }, opts.requiredBy ?? module);
}
const app = createOffline();
module.exports = { app, createOffline };
