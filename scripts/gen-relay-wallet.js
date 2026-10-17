// Creates Relay's own testnet wallet (the agent chain). Never prints or logs a private key.
// Writes RELAY_PRIVATE_KEY to .env (never committed) and the public address to config/addresses.json as sellers.relay.
const fs = require('fs');
const path = require('path');
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');
const addrFile = path.join(root, 'config', 'addresses.json');
let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const addresses = JSON.parse(fs.readFileSync(addrFile, 'utf8'));
const m = env.match(/^RELAY_PRIVATE_KEY=(0x[0-9a-fA-F]{64})\s*$/m);
let account;
if (m) { account = privateKeyToAccount(m[1]); console.log('RELAY_PRIVATE_KEY already present in .env, not overwritten'); }
else {
  const pk = generatePrivateKey();
  account = privateKeyToAccount(pk);
  env = env.replace(/^RELAY_PRIVATE_KEY=.*$\n?/m, '');
  env += `${env && !env.endsWith('\n') ? '\n' : ''}RELAY_PRIVATE_KEY=${pk}\n`;
  fs.writeFileSync(envPath, env);
  console.log('new Relay key written to .env');
}
addresses.sellers.relay = account.address;
fs.writeFileSync(addrFile, `${JSON.stringify(addresses, null, 2)}\n`);
console.log(`Relay address: ${account.address}`);
console.log('Fund it with test USDC at https://faucet.circle.com (Base Sepolia) so it has a working float.');
