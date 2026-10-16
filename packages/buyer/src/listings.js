// Seller listings for Beacon. For now they come from config/listings/*.json (local dev); in 6.3 the registry replaces this.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..', '..');
const addresses = require(path.join(ROOT, 'config', 'addresses.json'));

const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 16);

/** Typed fields only (M-12). Names and descriptions are display text and never influence selection. */
function loadLocalListings(host = 'http://localhost') {
  const dir = path.join(ROOT, 'config', 'listings');
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const id = f.replace(/\.json$/, '');
    const l = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const endpoint = `${host}:${l.port}${l.path}`;
    const base = { id, name: l.name, category: l.category, price: BigInt(l.price), payTo: addresses.sellers[id], endpoint, method: l.method || 'GET' };
    return { ...base, outputSchema: l.outputSchema, labels: l.labels || [], listingHash: hash({ ...base, price: l.price }) };
  });
}

module.exports = { loadLocalListings };
