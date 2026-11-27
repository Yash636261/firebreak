// Checkout for the demo shop.
//   new_checkout     boolean flag: old vs new totals (planted bug in the new path)
//   checkout_layout  multivariate experiment: "classic" (control) vs "express"
//                    (planted bug in the express path)
import { isEnabled, valueFor } from "./flags.mjs";

export async function checkout(cart, userId = "anonymous") {
  const layout = await valueFor("checkout_layout", userId);
  if (layout === "express") return expressCheckout(cart);
  if (await isEnabled("new_checkout")) return newCheckout(cart);
  return legacyCheckout(cart);
}

// Old path: handles both cart shapes.
function legacyCheckout(cart) {
  const lines = cart.items ?? cart.lines ?? [];
  const total = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  return { total: round(total), engine: "legacy" };
}

// New path: per-line discounts. PLANTED BUG: carts restored from a saved
// session use `lines`, not `items`, so `cart.items` is undefined for them.
function newCheckout(cart) {
  const total = cart.items.reduce((sum, l) => sum + l.price * l.qty * (1 - (l.discount ?? 0)), 0);
  return { total: round(total), engine: "new" };
}

// Express layout (experiment variant): one-click with saved shipping.
// PLANTED BUG: guest carts have no saved shipping address.
function expressCheckout(cart) {
  const lines = cart.items ?? cart.lines ?? [];
  const shipping = cart.shipping.express ? 9 : 4;
  return { total: round(lines.reduce((sum, l) => sum + l.price * l.qty, 0) + shipping), engine: "express" };
}

const round = (n) => Math.round(n * 100) / 100;
