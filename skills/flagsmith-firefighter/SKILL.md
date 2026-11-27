---
name: flagsmith-firefighter
description: Put out a production fire caused by a feature flag or experiment. Traces a broken feature or error spike to the Flagsmith flag that most likely caused it, snapshots its state, and after a human approves either turns it off or rolls a running experiment back to control; verifies the fix the way an SDK sees it, and leaves an incident issue with a one-line rollback. Use when something broke in production, errors spiked after a rollout or an A/B test launch, a user reports a feature misbehaving, or someone asks "which flag broke this", "kill the flag" or "stop the experiment".
license: MIT
compatibility: Requires the Flagsmith CLI v2 (`flagsmith`) logged in or FLAGSMITH_API_KEY set, Node 18+, git, and optionally the GitHub CLI (`gh`) for the incident issue.
metadata:
  author: firebreak
  version: "0.2.0"
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

You need: what broke (error message, failing route, or stack trace) and roughly when it started. If the stack trace is already in a file, pass that path; if it was pasted, save it to `.firebreak/stack.txt`. If they gave no time, use now.

## Steps 2–3: Find the suspect, snapshot it, build the plan (one call)

```bash
node scripts/plan.mjs --at "<ISO start time>" --stack <stack trace file>
```

Omit `--stack` if there is none. This ranks suspects, snapshots the top one and prints a finished **FIREBREAK PLAN** block (or a **NO FLAG EXPLAINS THIS INCIDENT** block: then go to "When it is not a flag"). Do not re-run the pieces it already ran.

How it decides, so you can explain it:
- Score = 60% time proximity + 35% "read by a file in the stack trace" + 5% "used in code"; halved if the flag is already off. Below 0.5 it refuses to propose a kill.
- Changes come from the audit log, which is a paid-plan feature; on the free plan (audit log empty) they come from each feature state's `updated_at`, with the author from the latest published feature version.
- Smallest blast radius, chosen for you (the `effect:` line says which):
  - a **running experiment** (multivariate flag with traffic on a variant) is rolled back to control with `flag update <f> --weight <variant>=0`: everyone gets the control value, the flag stays on, and the rollback restores the split;
  - a segment-override change is disabled for that segment only;
  - anything else is disabled.

Optional, at most one extra call: if the plan's `evidence` line names a file in the stack, read ~10 lines around it to explain the mechanism in one sentence.

Show the plan block to the human exactly as printed and **stop** until they answer.

If running headless (env `FIREBREAK_MODE=plan`), print the plan block and exit. Do not wait, do not run the action. The caller collects approval and re-invokes you with `FIREBREAK_APPROVED=<feature>`.

Manual route (only if `plan.mjs` fails): `scripts/suspects.mjs` (ranking, same flags) then `scripts/snapshot.mjs <feature>`, and write the block yourself in the same shape.

## Step 4: Act (only after "yes")

Run the exact proposed command plus `--yes --no-input`. In headless mode, only act if `FIREBREAK_APPROVED` equals the suspect feature name.

The CLI itself refuses state changes without `--yes` when it cannot prompt ("pass --yes to confirm …"). That refusal is a second guard, not an error to work around before approval.

## Step 5: Verify

```bash
node scripts/verify.mjs <feature>                                 # works for both kinds of kill
node scripts/verify.mjs <feature> --identity <affected user id>   # if you know one
```

`VERIFIED` means an SDK now sees the fix: the flag resolves off, or (experiment rollback) 5 sample users all get the control value. `NOT VERIFIED` means an override is still on: report it, do not keep changing things without another approval.

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
