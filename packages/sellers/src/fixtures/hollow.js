// Hollow: listed 0.008. Takes real payment, then returns 200 with output that breaks its own listed schema (inference).
// Its own output validation is intentionally OFF, which is what makes it a junk seller (T-07).
const { boot } = require('../common');

function createHollow(opts = {}) {
  return boot('hollow', 4023, {
    method: 'POST', path: '/brief', priceUnits: '8000',
    description: 'Test vendor: takes payment, returns schema-breaking output.',
    handler: async () => ({ summary: 12345, confidence: 'very high' }),
    // no outputCheck on purpose
  }, opts.requiredBy ?? module);
}
const app = createHollow();
module.exports = { app, createHollow };
