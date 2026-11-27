#!/usr/bin/env node
// Rank the flags most likely to have caused an incident. READ-ONLY.
//
//   node suspects.mjs [--at <ISO time incident began>] [--window <minutes>]
//                     [--stack <file>|-] [--repo <dir>] [--top 3] [--json]
//                     [--project <id|name>] [--env <client-side key>]
//
// Evidence used, cheapest first:
//   1. Flagsmith audit log: which flags changed in this environment shortly before --at
//   2. git grep: where each changed flag is read in the code
//   3. the stack trace: does a file that reads the flag appear in it
//   4. flag get: is the flag still on right now (top candidates only)
// Prints a short ranked table (or JSON with --json) and the next command to run.
import { readFileSync } from "node:fs";
import { ago, context, die, fsJson, hhmm, parseArgs, run, scope } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2));
const at = a.at ? new Date(a.at) : new Date();
if (Number.isNaN(at.getTime())) die(`--at is not a date: ${a.at}`);
const windowMin = Number(a.window ?? 120);
const top = Number(a.top ?? 3);
const repo = a.repo ?? process.cwd();

let stack = "";
if (a.stack === "-") stack = readFileSync(0, "utf8");
else if (typeof a.stack === "string") stack = readFileSync(a.stack, "utf8");

const ctx = context({ project: a.project, env: a.env });

// 1. Audit log for this project + environment, newest first.
const audit = fsJson([
  "api",
  `api/v1/audit/?project=${ctx.projectId}&environments=${ctx.envId}&page_size=100`,
]);
const from = at.getTime() - windowMin * 60_000;
const until = at.getTime() + 5 * 60_000; // allow 5 min of clock skew / late alerts

const FEATURE_RE = [/for feature:\s*([^\s;,'"]+)/i, /feature:\s*([^\s;,'"]+)/i, /created:\s*([^\s;,'"]+)/i];
const featureOf = (log) => {
  for (const re of FEATURE_RE) {
    const m = re.exec(log ?? "");
    if (m) return m[1];
  }
  return null;
};

const byFeature = new Map();
for (const r of audit.results ?? []) {
  const t = new Date(r.created_date).getTime();
  if (t < from || t > until) continue;
  const f = featureOf(r.log);
  if (!f) continue;
  const cur = byFeature.get(f) ?? { feature: f, changes: 0, last: null };
  cur.changes++;
  if (!cur.last || t > cur.last.t) {
    cur.last = { t, log: r.log, by: r.author?.email ?? "api-key", auditId: r.id };
  }
  byFeature.set(f, cur);
}

if (byFeature.size === 0) {
  const msg = `no flag changes in ${ctx.envName} between ${hhmm(from)} and ${hhmm(until)}. A flag is unlikely to be the cause; widen --window or check deploys.`;
  if (a.json) process.stdout.write(`${JSON.stringify({ env: ctx.envName, suspects: [], note: msg })}\n`);
  else process.stdout.write(`${msg}\n`);
  process.exit(0);
}

// 2 + 3. Code proximity.
const stackFiles = [...stack.matchAll(/([\w./\\@-]+\.(?:[cm]?[jt]sx?|py|go|rb|java|kt|php|cs|rs|swift))(?::\d+)?/g)]
  .map((m) => m[1].replace(/\\/g, "/"));
const inStack = (file) => stackFiles.some((s) => s.endsWith(file) || file.endsWith(s) || s.split("/").pop() === file.split("/").pop());

for (const s of byFeature.values()) {
  const g = run("git", ["grep", "-n", "-I", "-F", "--", s.feature], { cwd: repo });
  s.refs = g.code === 0
    ? g.out.trim().split("\n").filter((l) => !l.startsWith(".firebreak/")).slice(0, 20).map((l) => l.split(":").slice(0, 2).join(":"))
    : [];
  s.stackRefs = s.refs.filter((r) => inStack(r.split(":")[0]));
  const gap = at.getTime() - s.last.t;
  const timeScore = gap <= 0 ? 1 : Math.max(0, 1 - gap / (windowMin * 60_000));
  s.score = 0.6 * timeScore + (s.stackRefs.length ? 0.35 : 0) + (s.refs.length ? 0.05 : 0);
  s.gapMs = gap;
}

const ranked = [...byFeature.values()].sort((x, y) => y.score - x.score).slice(0, top);

// 4. Current state for the shortlist only (one call each).
for (const s of ranked) {
  const st = run("flagsmith", ["flag", "get", s.feature, ...scope(ctx), "--json", "--no-input"]);
  try {
    const j = JSON.parse(st.out);
    s.enabled = j.enabled ?? j.feature_state?.enabled ?? null;
    s.value = j.value ?? j.feature_state_value ?? null;
  } catch {
    s.enabled = null;
  }
  if (s.enabled === false) s.score *= 0.5; // already off: less likely to still be hurting
}
ranked.sort((x, y) => y.score - x.score);

if (a.json) {
  process.stdout.write(
    `${JSON.stringify({
      env: ctx.envName,
      envKey: ctx.envKey,
      projectId: ctx.projectId,
      at: at.toISOString(),
      suspects: ranked.map((s) => ({
        feature: s.feature,
        score: Number(s.score.toFixed(2)),
        changedAt: new Date(s.last.t).toISOString(),
        minutesBefore: Math.round(s.gapMs / 60000),
        by: s.by ?? s.last.by,
        log: s.last.log,
        changesInWindow: s.changes,
        enabled: s.enabled,
        stackRefs: s.stackRefs.slice(0, 3),
        refs: s.refs.length,
      })),
    })}\n`,
  );
  process.exit(0);
}

const lines = [`env ${ctx.envName} · incident ${hhmm(at)} · flag changes since ${hhmm(from)}: ${byFeature.size}`];
ranked.forEach((s, i) => {
  const when = s.gapMs >= 0 ? `${ago(s.gapMs)} before` : `${ago(s.gapMs)} after`;
  const state = s.enabled === true ? "ON" : s.enabled === false ? "off" : "?";
  const code = s.stackRefs.length ? `IN STACK ${s.stackRefs[0]}` : s.refs.length ? `${s.refs.length} refs e.g. ${s.refs[0]}` : "not in code";
  lines.push(`${i + 1}. ${s.feature}  score ${s.score.toFixed(2)}  now ${state}  changed ${hhmm(s.last.t)} (${when}) by ${s.last.by}  ${code}`);
  lines.push(`   "${s.last.log}"${s.changes > 1 ? ` (+${s.changes - 1} more changes)` : ""}`);
});
lines.push(`next: node scripts/snapshot.mjs ${ranked[0].feature}`);
process.stdout.write(`${lines.join("\n")}\n`);
