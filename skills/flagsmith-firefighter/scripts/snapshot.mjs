#!/usr/bin/env node
// Save a flag's current state before changing it, and print the exact rollback.
// Writes only to .firebreak/ locally. Makes no change in Flagsmith.
//
//   node snapshot.mjs <feature> [--segment <id|name>] [--project <id|name>] [--env <key>]
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { context, die, fsJson, parseArgs, scope, stateDir } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2));
const feature = a._[0];
if (!feature) die("usage: snapshot.mjs <feature> [--segment <id>]");

const ctx = context({ project: a.project, env: a.env });
const target = typeof a.segment === "string" ? ["--segment", a.segment] : [];
const state = fsJson(["flag", "get", feature, ...scope(ctx), ...target]);

const takenAt = new Date().toISOString();
const file = join(stateDir(), `snapshot-${takenAt.replace(/[:.]/g, "-")}-${feature}.json`);
writeFileSync(file, JSON.stringify({ feature, takenAt, ...ctx, segment: a.segment ?? null, state }, null, 2));

const enabled = state.enabled ?? state.feature_state?.enabled;
const value = state.value ?? state.feature_state_value ?? null;
const base = ["flagsmith flag update", feature, ...scope(ctx), ...target];
const rollback = [...base, enabled ? "--enable" : "--disable"];
if (value !== null && value !== undefined && value !== "") rollback.push("--value", JSON.stringify(String(value)));
const mv = state.multivariate_feature_state_values ?? state.variants ?? [];

const out = [
  `snapshot ${feature} @ ${ctx.envName}: ${enabled ? "ON" : "off"}${value != null ? ` value=${JSON.stringify(value)}` : ""}${mv.length ? ` variants=${mv.length}` : ""}`,
  `saved ${relative(process.cwd(), file)}`,
  `rollback: ${rollback.join(" ")} --yes`,
];
if (mv.length) out.push("rollback weights: see variants in the snapshot file (flag update --weight <key>=<pct>)");
process.stdout.write(`${out.join("\n")}\n`);
