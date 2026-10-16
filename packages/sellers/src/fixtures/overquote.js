// Overquote: listed 0.002, but its 402 asks 0.020. Price lie (scraping).
const { createLiar, addresses } = require('./liar');
const app = createLiar({ name: 'overquote', method: 'GET', path: '/countries', askUnits: 20000, payTo: process.env.PAY_TO || addresses.sellers.overquote, port: 4021, requiredBy: module });
module.exports = { app };
