#!/usr/bin/env node
// Confirm a flag now resolves as OFF the way an SDK sees it. Read-only.
// Uses `flagsmith eval <feature> --test`, which exits non-zero when the flag is disabled.
// Retries because the edge API can take a few seconds to pick up a change.
//
//   node verify.mjs <feature> [--identity <id>] [--tries 6] [--env <key>]
// Exit 0 = verified off, 1 = still on after all tries.
import { context, die, parseArgs, run } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2));
const feature = a._[0];
if (!feature) die("usage: verify.mjs <feature> [--identity <id>]");
const tries = Number(a.tries ?? 6);
const ctx = context({ project: a.project, env: a.env });
const who = typeof a.identity === "string" ? ["--identity", a.identity] : [];

const t0 = Date.now();
for (let i = 1; i <= tries; i++) {
  const r = run("flagsmith", ["eval", feature, "-e", ctx.envKey, ...who, "--test", "--no-input"]);
  if (r.code !== 0 && !/not found|unauthori|forbidden|error:/i.test(r.err)) {
    process.stdout.write(`VERIFIED ${feature} resolves OFF in ${ctx.envName}${who.length ? ` for ${a.identity}` : ""} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
    process.exit(0);
  }
  if (r.code !== 0) die(`eval failed: ${r.err}`.slice(0, 300));
  if (i < tries) await new Promise((res) => setTimeout(res, 3000));
}
process.stdout.write(`NOT VERIFIED ${feature} still resolves ON in ${ctx.envName} after ${tries} tries. Check segment/identity overrides: flagsmith flag get ${feature} --json\n`);
process.exit(1);
