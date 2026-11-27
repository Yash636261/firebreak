# Firebreak

**A feature flag broke production. Firebreak finds which one, turns it off after a human says yes, proves it's off, and leaves the incident trail.**

Built for Toggle Wars, the Flagsmith hackathon. Tracks: **02 AI Agents and Feature Flags** and **04 Flagsmith Agent Skills**.

## What's in the repo

| Path | What it is | Track |
|---|---|---|
| [`skills/flagsmith-firefighter/`](skills/flagsmith-firefighter/SKILL.md) | Agent Skill: symptom → suspect flag → snapshot → approved kill → verify → incident issue, all through the Flagsmith CLI | 04 |
| `bot/` *(next)* | Alert webhook → runs the skill headless → Slack Approve / Reject → executes and reports | 02 |
| `demo-app/` *(next)* | Tiny shop with a `new_checkout` flag whose "on" path has a planted bug, plus a traffic script | demo |

## The skill in one run

```
$ node scripts/suspects.mjs --stack .firebreak/stack.txt
env Production · incident 09:48 · flag changes since 07:48: 2
1. new_checkout  score 0.98  now ON  changed 09:44 (4m before) by alice@shop.dev  IN STACK src/checkout.ts:1
2. dark_mode     score 0.40  now ON  changed 08:58 (50m before) by bob@shop.dev   1 refs e.g. src/theme.ts:1
next: node scripts/snapshot.mjs new_checkout
```

Then: `snapshot.mjs` (saves state + prints rollback) → **FIREBREAK PLAN, human approves** → `flagsmith flag disable … --yes --no-input` → `verify.mjs` (`flagsmith eval --test`) → `trail.mjs` (`gh issue create` + flag description note).

## Install the skill

```bash
# Claude Code
cp -r skills/flagsmith-firefighter ~/.claude/skills/
# prerequisites
npm install -g @flagsmith/cli && flagsmith init
```

## Safety

- Read-only until approval. `allowed-tools` pre-approves only read commands, so the agent host also asks before any `flag disable`.
- One change per approval, only in the incident's environment, only reversible operations (no deletes, no archive).
- Snapshot before every change; the rollback command is printed and written into the issue.
- Weak evidence (no flag changed in the window, or top score < 0.5) → the skill recommends *not* killing anything.

## Token efficiency

Each script prints ≤ 8 lines. The CLI is called with `--json` and filtered in-script, never dumped to the model. The audit log is fetched once and only the top 3 suspects get a `flag get`.
*(Token count for the demo run: TODO)*

## How it meets the judging criteria

| Criterion | How |
|---|---|
| T4 Completes the whole job | Symptom → suspect → snapshot → approved kill → SDK-side verify → issue + flag annotation |
| T4 Token efficiency | See above; measured count recorded for the demo run |
| T4 Creative CLI use | `flagsmith api` (audit log) + `flag get/disable/update --weight` + `eval --test` chained with `git grep` and `gh` |
| T4 Safety around production | Snapshot, single-env scope, approval gate, reversible-only, "don't kill on weak evidence" |
| T2 Uses CLI / API / MCP | The bot drives the same skill through the CLI |
| T2 Saves real time | Minutes of audit-log archaeology → one ranked answer in seconds |
| T2 Human approves | Slack Approve button is the only path to a change |
| T2 Clear output | One plan block / one Slack message: suspect, evidence, action, rollback |
