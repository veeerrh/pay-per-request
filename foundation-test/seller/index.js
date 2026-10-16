require("dotenv").config();
const express = require("express");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");

const PORT = process.env.PORT || 4021;
const PAY_TO = process.env.SELLER_ADDRESS;
const NETWORK = "eip155:84532"; // Base Sepolia

const app = express();

const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402.org/facilitator" });
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());

const routes = {
  "GET /scrape": {
    accepts: [
      {
        scheme: "exact",
        price: "$0.001",
        network: NETWORK,
        payTo: PAY_TO,
        maxTimeoutSeconds: 60,
      },
    ],
    description: "Foundation test: one scrape call",
  },
};

app.use(paymentMiddleware(routes, resourceServer));

app.get("/scrape", (req, res) => {
  res.json({ title: "A Light in the Attic", price: "£51.77", scraped_at: new Date().toISOString() });
});

app.get("/health", (req, res) => res.json({ ok: true, payTo: PAY_TO, network: NETWORK }));

app.listen(PORT, () => {
  console.log(`seller listening on http://localhost:${PORT}`);
  console.log(`payTo: ${PAY_TO}`);
});
