#!/usr/bin/env node
// Steps 2 + 3 in one call: rank suspects, snapshot the top one, print the
// FIREBREAK PLAN block. READ-ONLY in Flagsmith (writes a local snapshot only).
//
//   node plan.mjs [--at <ISO>] [--window 120] [--stack <file>] [--json]
//
// Prints either a ready-to-show FIREBREAK PLAN, or a NO FLAG block when the
// evidence is too weak to justify a kill (no change in window, or score < 0.5).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ago, die, parseArgs } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const a = parseArgs(process.argv.slice(2));
const pass = ["at", "window", "stack", "repo", "project", "env"].flatMap((k) => (typeof a[k] === "string" ? [`--${k}`, a[k]] : []));

const node = (script, args) => {
  const r = spawnSync(process.execPath, [join(here, script), ...args], { encoding: "utf8" });
  if (r.status !== 0) die(`${script} failed: ${(r.stderr || r.stdout).trim()}`.slice(0, 400));
  return r.stdout.trim();
};

const sus = JSON.parse(node("suspects.mjs", [...pass, "--json"]));
const top = sus.suspects?.[0];
const MIN_SCORE = 0.5;

if (!top || top.score < MIN_SCORE) {
  const why = !top ? sus.note ?? "no flag changed in the window" : `best suspect ${top.feature} scores ${top.score} (< ${MIN_SCORE})`;
  const out = { decision: "no_flag", reason: why, checked: sus.suspects ?? [] };
  if (a.json) process.stdout.write(`${JSON.stringify(out)}\n`);
  else process.stdout.write(`NO FLAG EXPLAINS THIS INCIDENT\nreason: ${why}\nrecommend: do not change any flag; check recent deploys (git log --since)\n`);
  process.exit(0);
}

// Smallest blast radius: a segment-scoped change is killed for that segment only.
const seg = /segment override (\S+)/.exec(top.log ?? "")?.[1];
const scope = `-p ${sus.projectId} -e ${sus.envKey}`;
const action = `flagsmith flag disable ${top.feature}${seg ? ` --segment ${seg}` : ""} ${scope}`;

const ctxArgs = ["project", "env"].flatMap((k) => (typeof a[k] === "string" ? [`--${k}`, a[k]] : []));
const snapOut = node("snapshot.mjs", [top.feature, ...(seg ? ["--segment", seg] : []), ...ctxArgs]);
const rollback = /^rollback: (.*)$/m.exec(snapOut)?.[1] ?? "(see snapshot)";
const snapshot = /^saved (.*)$/m.exec(snapOut)?.[1] ?? null;

const gapMs = new Date(sus.at) - new Date(top.changedAt);
// Flagsmith's clock and the app's clock differ by up to a second or two, so a
// change a few seconds "after" the first error is really simultaneous.
const when =
  gapMs >= 0
    ? `${ago(gapMs)} before the first errors`
    : gapMs > -60_000
      ? "at the same moment as the first errors"
      : `${ago(gapMs)} after the incident began`;
const code = top.stackRefs.length ? `read at ${top.stackRefs[0]}, which is in the stack trace` : top.refs ? `read in ${top.refs} place(s) in code, none in the stack trace` : "not found in code";
const evidence = `${top.log} at ${top.changedAt.slice(11, 16)}Z by ${top.by}, ${when}; ${code}`;
const others = sus.suspects.slice(1).map((s) => `${s.feature} ${s.score}`).join(", ");

if (a.json) {
  process.stdout.write(`${JSON.stringify({ decision: "kill", feature: top.feature, score: top.score, evidence, action, rollback, snapshot, env: sus.env, others: sus.suspects.slice(1) })}\n`);
  process.exit(0);
}
process.stdout.write(
  [
    "FIREBREAK PLAN",
    `suspect:  ${top.feature}  (score ${top.score.toFixed(2)})`,
    `evidence: ${evidence}`,
    `action:   ${action}`,
    `rollback: ${rollback}`,
    `env:      ${sus.env}`,
    ...(others ? [`others:   ${others}`] : []),
    `snapshot: ${snapshot}`,
    "Approve? (yes / no)",
  ].join("\n") + "\n",
);
