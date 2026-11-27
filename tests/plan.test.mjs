// Suspect ranking and plan decisions, end to end against a fake `flagsmith` CLI
// and a throwaway git repo: no Flagsmith account needed.
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

// `audit: true` serves change history from the audit log (paid plans); false
// serves an empty audit log and feature states instead (free plan).
function fakeCli(dir, { audit, changes }) {
  const js = `
const a = process.argv.slice(2);
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
const changes = ${JSON.stringify(changes)};
const audit = ${audit};
const byName = (n) => changes.find((c) => c.feature === n) ?? {};
if (a[0] === "config") out({ project: { value: 42 }, environment: { value: "envKEY" } });
if (a[0] === "project") out({ id: 42, organisation: 7 });
if (a[0] === "environment") out({ id: 5, name: "Production", api_key: "envKEY" });
if (a[0] === "feature" && a[1] === "list") out(changes.map((c, i) => ({ id: i + 1, name: c.feature })));
if (a[0] === "api" && a[1].startsWith("api/v1/audit/")) out({ results: audit ? changes.map((c, i) => ({ id: i, created_date: c.at, log: "Flag state / Remote Config updated for feature: " + c.feature, author: { email: c.by } })) : [] });
if (a[0] === "api" && a[1].includes("/featurestates/")) out({ results: changes.map((c, i) => ({ feature: i + 1, enabled: true, updated_at: c.at, identity: null, feature_segment: null, multivariate_feature_state_values: (c.variants ?? []).map((v) => ({ percentage_allocation: v.weight })) })) });
if (a[0] === "api" && a[1].includes("/versions/")) out({ results: [{ published_by: 99 }] });
if (a[0] === "api" && a[1].includes("/users/")) out([{ id: 99, email: "dev@shop.test" }]);
if (a[0] === "flag" && a[1] === "get") { const c = byName(a[2]); out({ enabled: true, value: c.value ?? null, variants: c.variants ?? [] }); }
process.stderr.write("fake flagsmith: unhandled " + a.join(" ")); process.exit(3);
`;
  writeFileSync(join(dir, "fake.mjs"), js);
  writeFileSync(join(dir, "flagsmith"), `#!/bin/sh\nexec node "$(dirname "$0")/fake.mjs" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, "flagsmith.cmd"), `@node "%~dp0fake.mjs" %*\r\n`);
}

function shop(opts) {
  const root = mkdtempSync(join(tmpdir(), "firebreak-test-"));
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  mkdirSync(bin);
  mkdirSync(join(repo, "src"), { recursive: true });
  fakeCli(bin, opts);
  writeFileSync(join(repo, "src", "checkout.ts"), '// new_checkout comment\nif (flags.isFeatureEnabled("new_checkout")) total = cart.items.reduce(f)\n');
  writeFileSync(join(repo, "src", "layout.ts"), 'const layout = flags.getFeatureValue("checkout_layout")\n');
  writeFileSync(join(repo, "src", "theme.ts"), 'const dm = flags.isFeatureEnabled("dark_mode")\n');
  writeFileSync(join(repo, "checkout-stack.txt"), "TypeError: x\n    at newCheckout (src/checkout.ts:2:40)\n");
  writeFileSync(join(repo, "layout-stack.txt"), "TypeError: x\n    at expressCheckout (src/layout.ts:1:20)\n");
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  return (script, args) => {
    const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { cwd: repo, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
}

const RELEASE_THEN_UNRELATED = [
  { feature: "new_checkout", at: iso(2), by: "alice@shop.test" },
  { feature: "dark_mode", at: iso(50), by: "bob@shop.test" },
];

for (const audit of [true, false]) {
  const plan = audit ? "with an audit log" : "on the free plan";

  test(`${plan}, the flag released just before the errors and read in the crashing file is the top suspect`, () => {
    // Given
    const run = shop({ audit, changes: RELEASE_THEN_UNRELATED });
    // When
    const out = run("suspects.mjs", ["--at", iso(0), "--stack", "checkout-stack.txt", "--json"]);
    // Then
    assert.equal(out.source, audit ? "audit log" : "feature states");
    assert.deepEqual(out.suspects.map((s) => s.feature), ["new_checkout", "dark_mode"]);
    assert.ok(out.suspects[0].score > 0.9);
    assert.equal(out.suspects[0].stackRefs[0], "src/checkout.ts:2");
    assert.equal(out.suspects[0].by, audit ? "alice@shop.test" : "dev@shop.test");
  });

  test(`${plan}, the plan turns the suspect off and keeps a rollback`, () => {
    // Given
    const run = shop({ audit, changes: RELEASE_THEN_UNRELATED });
    // When
    const p = run("plan.mjs", ["--at", iso(0), "--stack", "checkout-stack.txt", "--json"]);
    // Then
    assert.equal(p.decision, "kill");
    assert.equal(p.kind, "disable");
    assert.equal(p.action, "flagsmith flag disable new_checkout -p 42 -e envKEY");
    assert.equal(p.rollback, "flagsmith flag update new_checkout -p 42 -e envKEY --enable --yes");
    assert.match(p.evidence, /2m before the first errors/);
  });
}

test("a broken experiment variant is rolled back to control instead of switching the flag off", () => {
  // Given
  const run = shop({
    audit: false,
    changes: [{ feature: "checkout_layout", at: iso(1), by: "x", value: "classic", variants: [{ id: 1, key: "express", value: "express", weight: 50 }] }],
  });
  // When
  const p = run("plan.mjs", ["--at", iso(0), "--stack", "layout-stack.txt", "--json"]);
  // Then
  assert.equal(p.kind, "experiment_to_control");
  assert.equal(p.action, "flagsmith flag update checkout_layout --weight express=0 -p 42 -e envKEY");
  assert.equal(p.rollback, "flagsmith flag update checkout_layout -p 42 -e envKEY --enable --weight express=50 --yes");
  assert.match(p.effect, /everyone gets "classic"/);
  assert.match(p.evidence, /experiment sending 50% of users to variants/);
});

test("when no flag changed around the incident, nothing is proposed", () => {
  // Given
  const run = shop({ audit: true, changes: [{ feature: "old", at: iso(600), by: "x" }] });
  // When
  const p = run("plan.mjs", ["--at", iso(0), "--window", "60", "--json"]);
  // Then
  assert.equal(p.decision, "no_flag");
});

test("when the only change is old and unrelated to the crash, nothing is proposed", () => {
  // Given
  const run = shop({ audit: true, changes: [{ feature: "dark_mode", at: iso(100), by: "x" }] });
  // When
  const p = run("plan.mjs", ["--at", iso(0), "--stack", "checkout-stack.txt", "--json"]);
  // Then
  assert.equal(p.decision, "no_flag");
  assert.match(p.reason, /< 0.5/);
});
