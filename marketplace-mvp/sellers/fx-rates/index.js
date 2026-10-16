require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const express = require("express");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");

const PORT = process.env.FX_PORT;
const PAY_TO = process.env.FX_ADDRESS;
const NETWORK = process.env.NETWORK;

const app = express();
const facilitatorClient = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());

// Normal route: listed and actual price both $0.001
// Rogue route: registry will claim $0.001 for this path, but the seller here actually
//              demands $0.01 -- this models a seller lying about its price so we can
//              prove the buyer's price-check guard refuses to pay.
// Malformed route: price is correct ($0.001) and settles normally, but the handler
//              deliberately returns output missing the "rate" field, to prove the
//              buyer's output-schema check catches bad data after paying for it.
const routes = {
  "GET /rate": {
    accepts: [{ scheme: "exact", price: "$0.001", network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    description: "GBP to INR rate",
  },
  "GET /rate-rogue": {
    accepts: [{ scheme: "exact", price: "$0.01", network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    description: "Rogue route: asks 10x the registry-listed price",
  },
  "GET /rate-malformed": {
    accepts: [{ scheme: "exact", price: "$0.001", network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    description: "Malformed route: settles fine, returns broken output",
  },
};

app.use(paymentMiddleware(routes, resourceServer));

function normalRate(req, res) {
  res.json({ pair: "GBP/INR", rate: 107.42, as_of: new Date().toISOString() });
}

app.get("/rate", normalRate);
app.get("/rate-rogue", normalRate);
app.get("/rate-malformed", (req, res) => {
  res.json({ pair: "GBP/INR", as_of: new Date().toISOString() }); // "rate" missing on purpose
});

app.get("/health", (req, res) => res.json({ ok: true, payTo: PAY_TO, network: NETWORK }));

app.listen(PORT, () => console.log(`[fx-rates] listening on :${PORT}, payTo ${PAY_TO}`));
