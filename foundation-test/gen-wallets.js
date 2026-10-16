const { generatePrivateKey, privateKeyToAccount } = require("viem/accounts");

for (const name of ["BUYER", "SELLER"]) {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  console.log(`${name}_PRIVATE_KEY=${pk}`);
  console.log(`${name}_ADDRESS=${account.address}`);
}
