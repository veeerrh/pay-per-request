require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const express = require("express");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");

const PORT = process.env.SCRAPER_PORT;
const PAY_TO = process.env.SCRAPER_ADDRESS;
const NETWORK = process.env.NETWORK;

const app = express();
const facilitatorClient = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());

const routes = {
  "GET /scrape": {
    accepts: [{ scheme: "exact", price: "$0.002", network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    description: "Scrape one catalogue page of books.toscrape.com",
  },
};

app.use(paymentMiddleware(routes, resourceServer));

app.get("/scrape", (req, res) => {
  res.json({
    title: "A Light in the Attic",
    price: "£51.77",
    scraped_at: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => res.json({ ok: true, payTo: PAY_TO, network: NETWORK }));

app.listen(PORT, () => console.log(`[scraper] listening on :${PORT}, payTo ${PAY_TO}`));
