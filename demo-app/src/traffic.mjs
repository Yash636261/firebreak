// Simulated shoppers. ~30% of carts are restored from a saved session (`lines`
// instead of `items`), which is what trips the bug behind `new_checkout`.
//
//   node src/traffic.mjs [--rps 4] [--seconds 0 (=forever)] [--url http://localhost:4000]
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const RPS = Number(arg("rps", 4));
const SECONDS = Number(arg("seconds", 0));
const URL_ = arg("url", "http://localhost:4000");

const products = [
  { sku: "mug", price: 12 },
  { sku: "tee", price: 25 },
  { sku: "cap", price: 18 },
];
const cart = () => {
  const lines = products.filter(() => Math.random() < 0.6).map((p) => ({ ...p, qty: 1 + Math.floor(Math.random() * 3) }));
  return Math.random() < 0.3 ? { restored: true, lines } : { items: lines };
};

let ok = 0;
let err = 0;
const t0 = Date.now();
const timer = setInterval(async () => {
  try {
    const r = await fetch(`${URL_}/checkout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cart()) });
    r.ok ? ok++ : err++;
  } catch {
    err++;
  }
}, 1000 / RPS);

const report = setInterval(() => {
  const s = Math.round((Date.now() - t0) / 1000);
  console.warn(`${s}s  ok ${ok}  errors ${err}  (${ok + err ? Math.round((100 * err) / (ok + err)) : 0}%)`);
  ok = 0;
  err = 0;
  if (SECONDS && s >= SECONDS) {
    clearInterval(timer);
    clearInterval(report);
  }
}, 5000);
