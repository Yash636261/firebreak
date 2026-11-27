#!/usr/bin/env node
// Confirm a flag now resolves as OFF the way an SDK sees it. Read-only.
// Uses `flagsmith eval <feature> --json` and checks `.enabled === false`.
// (Do not rely on `eval --test`: CLI v2.0.0 prints "is disabled" but exits 0.)
// Retries because the edge API can take a few seconds to pick up a change.
//
//   node verify.mjs <feature> [--identity <id>] [--tries 6] [--env <key>]
// Exit 0 = verified off, 1 = still on after all tries, 2 = could not evaluate.
import { context, die, parseArgs, run } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2));
const feature = a._[0];
if (!feature) die("usage: verify.mjs <feature> [--identity <id>]");
const tries = Number(a.tries ?? 6);
const ctx = context({ project: a.project, env: a.env });
const who = typeof a.identity === "string" ? ["--identity", a.identity] : [];
const forWho = who.length ? ` for ${a.identity}` : "";

const t0 = Date.now();
let last = null;
for (let i = 1; i <= tries; i++) {
  const r = run("flagsmith", ["eval", feature, "-e", ctx.envKey, ...who, "--json", "--no-input"]);
  try {
    last = JSON.parse(r.out);
  } catch {
    die(`eval failed: ${r.err || r.out}`.slice(0, 300));
  }
  if (last.enabled === false) {
    process.stdout.write(`VERIFIED ${feature} resolves OFF in ${ctx.envName}${forWho} (${Math.round((Date.now() - t0) / 1000)}s, reason ${last.reason ?? "?"})\n`);
    process.exit(0);
  }
  if (i < tries) await new Promise((res) => setTimeout(res, 3000));
}
process.stdout.write(
  `NOT VERIFIED ${feature} still resolves ON in ${ctx.envName}${forWho} after ${tries} tries (reason ${last?.reason ?? "?"}). An override may still be on: flagsmith flag get ${feature} --json\n`,
);
process.exit(1);
