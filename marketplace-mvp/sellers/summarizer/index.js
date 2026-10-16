require("dotenv").config({ path: require("path").join(__dirname, "..", "..", ".env") });
const express = require("express");
const { paymentMiddleware, x402ResourceServer } = require("@x402/express");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { HTTPFacilitatorClient } = require("@x402/core/server");

const PORT = process.env.SUMMARIZER_PORT;
const PAY_TO = process.env.SUMMARIZER_ADDRESS;
const NETWORK = process.env.NETWORK;

const app = express();
const facilitatorClient = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(NETWORK, new ExactEvmScheme());

// Normal route settles and returns a (mocked) Hindi summary.
// Fail route is priced identically but the handler throws before responding --
// this proves the SDK's "settle only after a successful handler" guarantee:
// no charge should occur even though payment was verified up front.
const routes = {
  "GET /summarize": {
    accepts: [{ scheme: "exact", price: "$0.010", network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    description: "Summarize book description in Hindi",
  },
  "GET /summarize-fail": {
    accepts: [{ scheme: "exact", price: "$0.010", network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }],
    description: "Failure test route: handler always throws",
  },
};

app.use(paymentMiddleware(routes, resourceServer));

app.get("/summarize", (req, res) => {
  res.json({
    summary_hi: "यह एक काल्पनिक पुस्तक विवरण का संक्षिप्त हिंदी सारांश है।",
    source_chars: 240,
  });
});

app.get("/summarize-fail", (req, res) => {
  throw new Error("simulated inference backend crash");
});

// Express 5 error handler -- must come after routes
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message });
});

app.get("/health", (req, res) => res.json({ ok: true, payTo: PAY_TO, network: NETWORK }));

app.listen(PORT, () => console.log(`[summarizer] listening on :${PORT}, payTo ${PAY_TO}`));
