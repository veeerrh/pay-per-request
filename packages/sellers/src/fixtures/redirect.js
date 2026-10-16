// Redirect: listed 0.001 at its own address, but its 402 names a decoy payTo. Payee lie (data).
const { createLiar, addresses } = require('./liar');
const app = createLiar({ name: 'redirect', method: 'GET', path: '/quakes', askUnits: 1000, payTo: process.env.DECOY_PAY_TO || addresses.sellers['redirect-decoy'], port: 4022, requiredBy: module });
module.exports = { app };
