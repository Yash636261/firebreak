#!/usr/bin/env node
// Confirm the kill took effect the way an SDK sees it. Read-only.
//   disabled flag      -> `flagsmith eval <f> --json` reports enabled: false
//   experiment rollback -> sample identities all resolve the control value
// Identities are evaluated transiently (no --persist), so nothing is created.
// (Do not rely on `eval --test`: CLI v2.0.0 prints "is disabled" but exits 0.)
//
//   node verify.mjs <feature> [--identity <id>] [--tries 6] [--env <key>]
// Exit 0 = verified, 1 = not yet after all tries, 2 = could not evaluate.
import { context, die, fsJson, liveVariants, parseArgs, run, scope } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2));
const feature = a._[0];
if (!feature) die("usage: verify.mjs <feature> [--identity <id>]");
const tries = Number(a.tries ?? 6);
const ctx = context({ project: a.project, env: a.env });

const state = fsJson(["flag", "get", feature, ...scope(ctx)]);
const experiment = state.enabled && (state.variants ?? []).length > 0;
const ids = typeof a.identity === "string" ? [a.identity] : experiment ? ["fb-verify-1", "fb-verify-2", "fb-verify-3", "fb-verify-4", "fb-verify-5"] : [null];

function evalOnce(id) {
  const r = run("flagsmith", ["eval", feature, "-e", ctx.envKey, ...(id ? ["--identity", id] : []), "--json", "--no-input"]);
  try {
    return JSON.parse(r.out);
  } catch {
    die(`eval failed: ${r.err || r.out}`.slice(0, 300));
  }
}

const ok = (e) => (experiment ? e.enabled && e.value === state.value : e.enabled === false);
const t0 = Date.now();
let bad = [];
for (let i = 1; i <= tries; i++) {
  bad = ids.map((id) => [id, evalOnce(id)]).filter(([, e]) => !ok(e));
  if (!bad.length) {
    const what = experiment
      ? `all ${ids.length} sample users get control ${JSON.stringify(state.value)} (live variants: ${liveVariants(state).length})`
      : `resolves OFF${ids[0] ? ` for ${ids[0]}` : ""}`;
    process.stdout.write(`VERIFIED ${feature} ${what} in ${ctx.envName} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
    process.exit(0);
  }
  if (i < tries) await new Promise((res) => setTimeout(res, 3000));
}
const [id, e] = bad[0];
process.stdout.write(
  `NOT VERIFIED ${feature} in ${ctx.envName}: ${id ?? "default"} still gets enabled=${e.enabled} value=${JSON.stringify(e.value)} after ${tries} tries. An override may still be on: flagsmith flag get ${feature} --json\n`,
);
process.exit(1);
