// Generates fresh testnet wallets. Never prints or logs a private key.
const fs = require('fs');
const path = require('path');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const has = (k) => new RegExp(`^${k}=0x[0-9a-fA-F]{64}\s*$`, 'm').test(env);

const buyers = { beacon: 'BEACON_PRIVATE_KEY', spare: 'SPARE_BUYER_PRIVATE_KEY', replay: 'REPLAY_PRIVATE_KEY' };
const addresses = { buyers: {}, sellers: {} };
const addrFile = path.join(root, 'config', 'addresses.json');
if (fs.existsSync(addrFile)) Object.assign(addresses, JSON.parse(fs.readFileSync(addrFile, 'utf8')));

for (const [name, key] of Object.entries(buyers)) {
  if (has(key)) {
    const m = env.match(new RegExp(`^${key}=(0x[0-9a-fA-F]{64})`, 'm'));
    addresses.buyers[name] = privateKeyToAccount(m[1]).address;
    console.log(`${name}: key already present in .env, not overwritten`);
    continue;
  }
  const pk = generatePrivateKey();
  addresses.buyers[name] = privateKeyToAccount(pk).address;
  env = env.replace(new RegExp(`^${key}=.*$\n?`, 'm'), '');
  env += (env && !env.endsWith('\n') ? '\n' : '') + `${key}=${pk}\n`;
  console.log(`${name}: new key written to .env`);
}
fs.writeFileSync(envPath, env);

// Seller receive addresses: key is derived and immediately discarded (M-71).
for (const s of ['atlas', 'tremor', 'brief', 'overquote', 'redirect', 'redirect-decoy', 'hollow', 'offline']) {
  if (!addresses.sellers[s]) addresses.sellers[s] = privateKeyToAccount(generatePrivateKey()).address;
}
fs.mkdirSync(path.dirname(addrFile), { recursive: true });
fs.writeFileSync(addrFile, JSON.stringify(addresses, null, 2) + '\n');
console.log('\nPublic addresses (safe to share):');
console.log(JSON.stringify(addresses, null, 2));
