#!/usr/bin/env node
// Write the incident record and print the commands that publish it. Local file only.
//
//   node trail.mjs <feature> --snapshot <file> --symptom "<what broke>"
//                  --action "<what was changed>" [--evidence "<why this flag>"]
//                  [--verified "<verify.mjs output line>"]
// Prints the body file path, a `gh issue create` command and a flag annotation command.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { die, liveVariants, parseArgs, rollbackCmd, run, stateDir } from "./lib.mjs";

const a = parseArgs(process.argv.slice(2));
const feature = a._[0];
if (!feature || typeof a.snapshot !== "string") die("usage: trail.mjs <feature> --snapshot <file> --symptom ... --action ...");
if (!existsSync(a.snapshot)) die(`snapshot not found: ${a.snapshot}. Run snapshot.mjs first; no snapshot, no change.`);
const snap = JSON.parse(readFileSync(a.snapshot, "utf8"));
const now = new Date().toISOString();
const was = snap.state.enabled;
const live = liveVariants(snap.state);
const rollback = rollbackCmd(snap);
const stateBefore = `${was ? "ON" : "off"}${live.length ? `, experiment ${live.map((v) => `${v.key ?? v.id}=${v.weight}%`).join(" ")}` : ""}`;
const outcome = live.length && was ? `experiment rolled back to control (${String(snap.state.value).replace(/["`$\\]/g, "")})` : "turned off";

const body = `## Incident: \`${feature}\` ${outcome} in ${snap.envName}

| | |
|---|---|
| Symptom | ${a.symptom ?? "(not given)"} |
| Suspect flag | \`${feature}\` |
| Evidence | ${a.evidence ?? "(see suspects output)"} |
| Action taken | ${a.action ?? "flag disabled"} at ${now} |
| Verified | ${a.verified ?? "(not verified)"} |
| State before | ${stateBefore} (snapshot \`${a.snapshot.split(/[\\/]/).pop()}\`) |

### Roll back (only once the bug is fixed)
\`\`\`
${rollback}
\`\`\`

### Follow-up
- [ ] Find and fix the bug in the code path behind \`${feature}\`
- [ ] Add a test that fails with the flag on
- [ ] Re-enable gradually (e.g. 10% → 50% → 100%) and watch the error rate
- [ ] Close this issue and remove the firebreak note from the flag description

_Recorded by the flagsmith-firefighter skill._
`;

const file = join(stateDir(), `incident-${now.replace(/[:.]/g, "-")}-${feature}.md`);
writeFileSync(file, body);

let oldDesc = "";
// Best effort: a failed lookup must not lose the incident file already written.
const got = run("flagsmith", ["feature", "get", feature, "-p", String(snap.projectId), "--json", "--no-input"]);
try {
  oldDesc = got.code === 0 ? (JSON.parse(got.out).description ?? "") : "";
} catch {}
const note = `[firebreak ${now.slice(0, 16)}Z: ${outcome} in ${snap.envName}, see incident issue]`;
const newDesc = oldDesc.includes("[firebreak") ? oldDesc : `${oldDesc} ${note}`.trim();

process.stdout.write(
  [
    `incident body: ${relative(process.cwd(), file)}`,
    `issue: gh issue create --title "Incident: ${feature} ${outcome} in ${snap.envName}" --body-file "${relative(process.cwd(), file)}"`,
    `annotate: flagsmith feature update ${feature} -p ${snap.projectId} --description ${JSON.stringify(newDesc)} --yes`,
  ].join("\n") + "\n",
);
