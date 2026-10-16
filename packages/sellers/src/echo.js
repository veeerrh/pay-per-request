// THROWAWAY seller for Milestone 3.1 and 3.2 tests. Deleted in 5.1.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '..', '.env'), quiet: true });
const addrs = require('../../../config/addresses.json');
const { createSellerApp } = require('./kit');

const PORT = Number(process.env.PORT || 4001);
const app = createSellerApp({
  name: 'echo',
  method: 'GET',
  path: '/echo',
  priceUnits: process.env.ECHO_PRICE || '1000',
  payTo: process.env.PAY_TO || addrs.sellers.atlas,
  claimsDb: process.env.CLAIMS_DB || ':memory:',
  facilitatorUrl: process.env.FACILITATOR_URL,
  inputCheck: (req) => (typeof req.query.msg === 'string' && req.query.msg.length <= 100 ? null : 'msg is required (max 100 characters)'),
  handler: async (req) => {
    if (req.query.fail === '1') throw new Error('requested failure');
    if (req.query.junk === '1') return { junk: true };
    return { echo: req.query.msg, at: new Date().toISOString() };
  },
  outputCheck: (o) => (typeof o.echo === 'string' ? null : 'echo field missing'),
});
if (require.main === module) app.listen(PORT, () => console.log(`echo seller on :${PORT}`));
module.exports = { app };
