// Demo shop API. POST /checkout with a cart; GET /stats for live error rate.
// When errors spike it raises an alert: logs it, writes the stack to
// logs/last-error.txt, and POSTs it to ALERT_WEBHOOK_URL if set (the Firebreak bot).
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { checkout } from "./checkout.mjs";
import { isEnabled } from "./flags.mjs";

const PORT = Number(process.env.PORT ?? 4000);
const WINDOW_MS = 60_000;
const ALERT_MIN_ERRORS = 5;
const ALERT_MIN_RATE = 0.1;
const ALERT_COOLDOWN_MS = 5 * 60_000;
const LOG_DIR = new URL("../logs/", import.meta.url);
mkdirSync(LOG_DIR, { recursive: true });

const events = []; // { at, ok, err? }
let lastAlertAt = 0;

function record(ok, err) {
  const now = Date.now();
  events.push({ at: now, ok, err });
  while (events.length && events[0].at < now - WINDOW_MS) events.shift();
}

function stats() {
  const errors = events.filter((e) => !e.ok);
  return { requests: events.length, errors: errors.length, errorRate: events.length ? errors.length / events.length : 0, firstErrorAt: errors[0]?.at ?? null };
}

async function maybeAlert(err) {
  const s = stats();
  if (s.errors < ALERT_MIN_ERRORS || s.errorRate < ALERT_MIN_RATE) return;
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return;
  lastAlertAt = Date.now();
  const alert = {
    service: "demo-shop",
    environment: "Production",
    title: `${err.name}: ${err.message}`,
    stack: err.stack,
    startedAt: new Date(s.firstErrorAt).toISOString(),
    errorRate: Number(s.errorRate.toFixed(2)),
    errors: s.errors,
    requests: s.requests,
  };
  writeFileSync(new URL("last-error.txt", LOG_DIR), `${alert.startedAt}\n${err.stack}\n`);
  console.warn(`ALERT ${alert.title} · ${Math.round(alert.errorRate * 100)}% errors since ${alert.startedAt}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(alert) }).catch((e) =>
      console.error(`alert webhook failed: ${e.message}`),
    );
  }
}

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/stats") {
    return json(res, 200, { ...stats(), new_checkout: await isEnabled("new_checkout").catch(() => null) });
  }
  if (req.method === "POST" && req.url === "/checkout") {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    try {
      const cart = JSON.parse(raw);
      const result = await checkout(cart, cart.user);
      record(true);
      return json(res, 200, result);
    } catch (err) {
      record(false, err);
      maybeAlert(err);
      return json(res, 500, { error: "checkout failed" });
    }
  }
  json(res, 404, { error: "not found" });
}).listen(PORT, () => console.warn(`demo shop on http://localhost:${PORT}`));
