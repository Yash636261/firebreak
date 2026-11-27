#!/usr/bin/env node
// Save a flag's current state before changing it, and print the exact rollback.
// Writes only to .firebreak/ locally. Makes no change in Flagsmith.
//
//   node snapshot.mjs <feature> [--segment <id|name>] [--project <id|name>] [--env <key>]
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { context, die, fsJson, liveVariants, parseArgs, rollbackCmd, scope, stateDir } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2));
const feature = a._[0];
if (!feature) die("usage: snapshot.mjs <feature> [--segment <id>]");

const ctx = context({ project: a.project, env: a.env });
const segment = typeof a.segment === "string" ? a.segment : null;
const state = fsJson(["flag", "get", feature, ...scope(ctx), ...(segment ? ["--segment", segment] : [])]);

const takenAt = new Date().toISOString();
const file = join(stateDir(), `snapshot-${takenAt.replace(/[:.]/g, "-")}-${feature}.json`);
const snap = { feature, takenAt, ...ctx, segment, state };
writeFileSync(file, JSON.stringify(snap, null, 2));

const live = liveVariants(state);
const desc = [
  state.enabled ? "ON" : "off",
  state.value != null ? `value=${JSON.stringify(state.value)}` : "",
  live.length ? `experiment running: ${live.map((v) => `${v.key ?? v.id}=${v.weight}%`).join(" ")}` : "",
].filter(Boolean);

process.stdout.write(
  [`snapshot ${feature} @ ${ctx.envName}: ${desc.join(" ")}`, `saved ${relative(process.cwd(), file)}`, `rollback: ${rollbackCmd(snap)}`].join("\n") + "\n",
);
