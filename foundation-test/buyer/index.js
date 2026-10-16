require("dotenv").config();
const { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } = require("@x402/fetch");
const { ExactEvmScheme } = require("@x402/evm/exact/client");
const { privateKeyToAccount } = require("viem/accounts");

const account = privateKeyToAccount(process.env.BUYER_PRIVATE_KEY);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:84532",
      client: new ExactEvmScheme(account),
    },
  ],
});

async function main() {
  console.log(`buyer address: ${account.address}`);
  console.log(`calling ${process.env.SELLER_URL} ...`);

  const res = await fetchWithPayment(process.env.SELLER_URL, { method: "GET" });

  console.log(`status: ${res.status}`);
  const body = await res.json();
  console.log("response body:", body);

  const paymentResponseHeader = res.headers.get("PAYMENT-RESPONSE");
  if (paymentResponseHeader) {
    const decoded = decodePaymentResponseHeader(paymentResponseHeader);
    console.log("payment settled:", decoded);
  } else {
    console.log("no PAYMENT-RESPONSE header — payment was not settled");
  }
}

main().catch((err) => {
  console.error("buyer failed:", err);
  process.exit(1);
});
