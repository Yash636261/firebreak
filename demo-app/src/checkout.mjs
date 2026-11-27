// Checkout for the demo shop. `new_checkout` switches between the old and new totals.
import { isEnabled } from "./flags.mjs";

export async function checkout(cart) {
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

const round = (n) => Math.round(n * 100) / 100;
