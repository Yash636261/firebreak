// Runs suspects.mjs / plan.mjs end to end against a fake `flagsmith` CLI and a
// throwaway git repo, so the ranking logic is tested without a Flagsmith account.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SCRIPTS = fileURLToPath(new URL("../skills/flagsmith-firefighter/scripts/", import.meta.url));
const NOW = Date.parse("2026-11-27T10:00:00Z");
const iso = (minAgo) => new Date(NOW - minAgo * 60_000).toISOString();

// Fake CLI. `audit` = true serves the change history from the audit log (paid
// plans); false serves an empty audit log and feature states (free plan).
function fakeCli(dir, { audit, changes }) {
  const js = `
const a = process.argv.slice(2);
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const changes = ${JSON.stringify(changes)};
const audit = ${audit};
if (a[0] === "config") out({ project: { value: 42 }, environment: { value: "envKEY" } });
if (a[0] === "project") out({ id: 42, organisation: 7 });
if (a[0] === "environment") out({ id: 5, name: "Production", api_key: "envKEY" });
if (a[0] === "feature" && a[1] === "list") out(changes.map((c, i) => ({ id: i + 1, name: c.feature })));
if (a[0] === "api" && a[1].startsWith("api/v1/audit/")) out({ results: audit ? changes.map((c, i) => ({ id: i, created_date: c.at, log: "Flag state / Remote Config updated for feature: " + c.feature, author: { email: c.by } })) : [] });
if (a[0] === "api" && a[1].includes("/featurestates/")) out({ results: changes.map((c, i) => ({ feature: i + 1, enabled: true, updated_at: c.at, identity: null, feature_segment: null })) });
if (a[0] === "api" && a[1].includes("/versions/")) out({ results: [{ published_by: 99 }] });
if (a[0] === "api" && a[1].includes("/users/")) out([{ id: 99, email: "dev@shop.test" }]);
if (a[0] === "flag" && a[1] === "get") out({ enabled: true, value: null });
process.stderr.write("fake flagsmith: unhandled " + a.join(" ")); process.exit(3);
`;
  writeFileSync(join(dir, "fake.mjs"), js);
  writeFileSync(join(dir, "flagsmith"), `#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, "flagsmith.cmd"), `@node "%~dp0fake.mjs" %*\r\n`);
}

function setup(opts) {
  const root = mkdtempSync(join(tmpdir(), "firebreak-test-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(bin);
  mkdirSync(join(repo, "src"), { recursive: true });
  fakeCli(bin, opts);
  writeFileSync(join(repo, "src", "checkout.ts"), '// new_checkout comment\nif (flags.isFeatureEnabled("new_checkout")) total = cart.items.reduce(f)\n');
  writeFileSync(join(repo, "src", "theme.ts"), 'const dm = flags.isFeatureEnabled("dark_mode")\n');
  writeFileSync(join(repo, "stack.txt"), "TypeError: x\n    at newCheckout (src/checkout.ts:2:40)\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const run = (script, args) => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: repo, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  return { run };
}

const CHANGES = [
  { feature: "new_checkout", at: iso(2), by: "alice@shop.test" },
  { feature: "dark_mode", at: iso(50), by: "bob@shop.test" },
];

for (const audit of [true, false]) {
  const plan = audit ? "audit log" : "free plan";

  test(`${plan}: the flag read in a stack-trace file, changed just before, ranks first`, () => {
    const { run } = setup({ audit, changes: CHANGES });
    const out = JSON.parse(run("suspects.mjs", ["--at", iso(0), "--stack", "stack.txt", "--json"]));
    assert.equal(out.source, audit ? "audit log" : "feature states");
    assert.deepEqual(out.suspects.map((s) => s.feature), ["new_checkout", "dark_mode"]);
    assert.ok(out.suspects[0].score > 0.9);
    assert.equal(out.suspects[0].stackRefs[0], "src/checkout.ts:2", "quoted flag read beats the comment on line 1");
    assert.equal(out.suspects[0].by, audit ? "alice@shop.test" : "dev@shop.test");
  });

  test(`${plan}: plan.mjs proposes a kill of the top suspect with a rollback`, () => {
    const { run } = setup({ audit, changes: CHANGES });
    const p = JSON.parse(run("plan.mjs", ["--at", iso(0), "--stack", "stack.txt", "--json"]));
    assert.equal(p.decision, "kill");
    assert.equal(p.feature, "new_checkout");
    assert.equal(p.action, "flagsmith flag disable new_checkout -p 42 -e envKEY");
    assert.match(p.rollback, /--enable --yes$/);
    assert.match(p.evidence, /2m before the first errors/);
  });
}

test("no flag changed in the window: plan.mjs refuses to propose a kill", () => {
  const { run } = setup({ audit: true, changes: [{ feature: "old", at: iso(600), by: "x" }] });
  const p = JSON.parse(run("plan.mjs", ["--at", iso(0), "--window", "60", "--json"]));
  assert.equal(p.decision, "no_flag");
});

test("weak evidence (old change, not in stack): plan.mjs refuses to propose a kill", () => {
  const { run } = setup({ audit: true, changes: [{ feature: "dark_mode", at: iso(100), by: "x" }] });
  const p = JSON.parse(run("plan.mjs", ["--at", iso(0), "--stack", "stack.txt", "--json"]));
  assert.equal(p.decision, "no_flag");
  assert.match(p.reason, /< 0.5/);
});
