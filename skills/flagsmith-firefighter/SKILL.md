---
name: flagsmith-firefighter
description: Put out a production fire caused by a feature flag. Traces a broken feature or error spike to the Flagsmith flag that most likely caused it, snapshots its state, turns it off after a human approves, verifies the kill the way an SDK sees it, and leaves an incident issue with a one-line rollback. Use when something broke in production, errors spiked after a rollout, a user reports a feature misbehaving, or someone asks "which flag broke this" or "kill the flag".
license: MIT
compatibility: Requires the Flagsmith CLI v2 (`flagsmith`) logged in or FLAGSMITH_API_KEY set, Node 18+, git, and optionally the GitHub CLI (`gh`) for the incident issue.
metadata:
  author: firebreak
  version: "0.1.0"
allowed-tools: Bash(node:*) Bash(flagsmith flag get:*) Bash(flagsmith eval:*) Bash(flagsmith config:*) Bash(git grep:*) Bash(git log:*)
---

# Flagsmith firefighter

Goal: stop the bleeding fast and safely, then hand off. You find the flag, a human approves, you turn it off, you prove it is off, you leave a trail. You do **not** fix the bug.

All scripts live in `scripts/` next to this file. Run them from the root of the affected repository (the one with `flagsmith.json`). They print a few lines each; do not re-run CLI list commands to "see more".

## Safety rules (never break these)

1. **Read-only until a human says yes.** Steps 1–3 change nothing in Flagsmith.
2. **One change per approval.** Never batch kills. A second suspect needs a second yes.
3. **Smallest blast radius.** Only the environment from the incident. Never touch other environments.
4. **Reversible only.** Allowed: `flag disable`, `flag update --weight`, `flag update --disable --segment`. Forbidden: `flag delete`, `feature delete`, `feature update --archive`, `segment delete/update`, any `-X DELETE` via `flagsmith api`.
5. **Snapshot before every change.** No snapshot file, no change.
6. **Never pass `--yes` before approval.** After approval, pass `--yes --no-input` so nothing prompts mid-incident.
7. If the evidence is weak (top score < 0.5, or no flag changed in the window), say so and **recommend not killing anything**. A wrong kill is a second incident.

## Step 1: Get the symptom

You need: what broke (error message, failing route, or stack trace) and roughly when it started. If the user gave a stack trace, save it to `.firebreak/stack.txt`. If they gave no time, use now.

## Step 2: Find suspects

```bash
node scripts/suspects.mjs --at "<ISO start time>" --window 120 --stack .firebreak/stack.txt
```

Omit `--stack` if there is none. Output: up to 3 ranked flags with when each changed, by whom, whether it is ON now, and whether a file that reads it is in the stack trace. Score = 60% time proximity + 35% "read by a file in the stack" + 5% "used in code"; halved if the flag is already off.

For the top suspect only, if you need more certainty, look at the code that reads it:
`git grep -n "<feature>"` then read only the lines around the hit in a stack-trace file.

## Step 3: Snapshot and propose

```bash
node scripts/snapshot.mjs <feature>
```

Then pick the **smallest** action that matches what changed (the audit log line tells you):

| Audit log says | Action |
|---|---|
| A multivariate weight changed (rollout %) | `flagsmith flag update <f> --weight <control>=100 --weight <variant>=0` |
| A segment override changed | `flagsmith flag disable <f> --segment <segment>` |
| Flag state updated / enabled | `flagsmith flag disable <f>` |

Always append the scope from the snapshot: `-p <projectId> -e <envKey>`.

Present the plan in exactly this shape and **stop**:

```
FIREBREAK PLAN
suspect:  <feature>  (score 0.xx)
evidence: <one line: changed HH:MM by X, N min before errors; read in file:line which is in the stack>
action:   <exact command, without --yes>
rollback: <rollback line from snapshot.mjs>
env:      <env name>
Approve? (yes / no)
```

If running headless (env `FIREBREAK_MODE=plan`), print the plan block as above and exit. Do not wait, do not run the action. The caller collects approval and re-invokes you with `FIREBREAK_APPROVED=<feature>`.

## Step 4: Act (only after "yes")

Run the exact proposed command plus `--yes --no-input`. In headless mode, only act if `FIREBREAK_APPROVED` equals the suspect feature name.

## Step 5: Verify

```bash
node scripts/verify.mjs <feature>            # environment default
node scripts/verify.mjs <feature> --identity <affected user id>   # if you know one
```

`VERIFIED` means an SDK now resolves the flag off. `NOT VERIFIED` means an override is still on: report it, do not keep changing things without another approval.

For a weight change, verify with `flagsmith eval <f> -e <envKey> --identity <id> --jq .value` instead and check it returns the control value.

## Step 6: Leave a trail

```bash
node scripts/trail.mjs <feature> --snapshot <snapshot file> --symptom "<symptom>" --evidence "<evidence line>" --action "<command you ran>" --verified "<verify output>"
```

It writes the incident body and prints two commands. Run the `gh issue create` one if `gh` is authenticated (otherwise give the user the file path). Run the `annotate` one so the flag's description shows it was killed.

## Step 7: Report

Finish with at most 6 lines: what broke, which flag, what you changed, verified or not, the issue link, the rollback command. Nothing else.

## When it is not a flag

If `suspects.mjs` finds no flag changes in the window, or every suspect scores below 0.5: say "No flag explains this incident", list what you checked, and suggest looking at deploys (`git log --since`) instead. Do not change any flag.

More detail on the CLI calls the scripts make: [references/cli.md](references/cli.md).
