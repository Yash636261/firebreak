# Firebreak

**A feature flag broke production. Firebreak finds which one, turns it off after a human says yes, proves it's off, and leaves the incident trail.**

Built for Toggle Wars, the Flagsmith hackathon. Tracks: **02 AI Agents and Feature Flags** and **04 Flagsmith Agent Skills**.

## What's in the repo

| Path | What it is | Track |
|---|---|---|
| [`skills/flagsmith-firefighter/`](skills/flagsmith-firefighter/SKILL.md) | Agent Skill: symptom → suspect flag → snapshot → approved kill → verify → incident issue, all through the Flagsmith CLI | 04 |
| [`bot/`](bot/) | Alert webhook → runs the skill headless (read-only) → Slack Approve / Reject (or a local board) → runs it again, allowed to touch only the approved flag → reports in thread | 02 |
| [`demo-app/`](demo-app/) | Tiny shop with a `new_checkout` flag whose "on" path has a planted bug, a traffic script, and an error-spike alert | demo |

## A real run (Flagsmith Cloud, free plan)

Flag off → 0% errors. Someone turns `new_checkout` on → ~30% of checkouts throw. The shop raises an alert with the stack trace. Then:

```
$ node scripts/suspects.mjs --at 2026-11-27T04:42:09Z --stack demo-app/logs/last-error.txt
env Production · incident 10:12 · flag changes since 08:12: 1 (from feature states)
1. new_checkout  score 1.00  now ON  changed 10:12 (3s before) by <author>  IN STACK demo-app/src/checkout.mjs:5
   "environment default now ON"
next: node scripts/snapshot.mjs new_checkout

$ node scripts/snapshot.mjs new_checkout
snapshot new_checkout @ Production: ON
rollback: flagsmith flag update new_checkout -p 56714 -e <envKey> --enable --yes

FIREBREAK PLAN … Approve? yes

$ flagsmith flag disable new_checkout -p 56714 -e <envKey> --yes --no-input
$ node scripts/verify.mjs new_checkout
VERIFIED new_checkout resolves OFF in Production (0s, reason STATIC)
```

Traffic right after: **0% errors**. `trail.mjs` then writes the incident issue body and prints the `gh issue create` and flag-annotation commands.

## Run the demo yourself

```bash
npm install -g @flagsmith/cli && flagsmith login
flagsmith init                      # at the repo root: pick your project + Production
# create a boolean feature `new_checkout`, off in Production
cd demo-app && npm install
npm start                           # shop on :4000
npm run traffic                     # 4 req/s of simulated shoppers
flagsmith flag enable new_checkout --yes   # the "bad deploy": errors start, alert fires
```

Then ask your agent: *"Checkout is throwing 500s, use the flagsmith-firefighter skill"* (stack trace is in `demo-app/logs/last-error.txt`).

## Install the skill

```bash
# prerequisites
npm install -g @flagsmith/cli && flagsmith login && flagsmith init
```

Claude Code, as a plugin:
```
/plugin marketplace add Yash636261/firebreak
/plugin install firebreak@firebreak
```
Or for one session from a clone: `claude --plugin-dir path/to/firebreak`. Any other Agent Skills host: copy `skills/flagsmith-firefighter/` into its skills folder.

## The bot (Track 02)

```
demo shop ──alert──▶ bot ──plan call (read-only tools)──▶ Claude Code + skill ──▶ FIREBREAK PLAN
                      │                                                               │
                      ◀───────────── Slack message with Approve / Reject ◀────────────┘
                      │ human clicks Approve (with a confirm dialog)
                      └──execute call (only `flagsmith flag disable <that flag>` allowed)──▶ kill → verify → trail ──▶ thread reply
```

```bash
cd bot && npm install && cp .env.example .env   # fill in Slack tokens (optional)
npm start                                       # board on http://127.0.0.1:4100, alerts on POST /alert
cd ../demo-app && ALERT_WEBHOOK_URL=http://127.0.0.1:4100/alert npm start
```

Slack app: create it from [`bot/slack-manifest.yml`](bot/slack-manifest.yml) (Socket Mode, so no public URL), install it, invite `@firebreak` to the channel. Without Slack tokens the bot uses the local board for approvals.

Guard rails in the bot, on top of the skill's own:
- The plan call is given only read tools. The execute call is given exactly one write permission, scoped to the approved verb and flag (`Bash(flagsmith flag disable new_checkout:*)`), so the model cannot touch any other flag even if it tried.
- Actions with `--enable`, delete/archive, or shell control characters are refused before the agent runs.
- Approve has a Slack confirm dialog, optional approver allow-list (`SLACK_APPROVERS`), and double clicks are ignored. Alerts for an already-open incident are de-duplicated.

Measured on the demo incident with `FIREBREAK_MODEL=sonnet`: plan **8 turns · 35 s · $0.36**, approved kill + verify + trail **10 turns · 55 s · $0.39**. About **$0.75 and 90 seconds** per incident, against minutes of digging through change history by hand.

## Headless (how the bot uses it)

```bash
# 1. investigate only: prints the FIREBREAK PLAN, changes nothing
FIREBREAK_MODE=plan claude -p "Checkout 500s since <time>, stack in <file>. Use the flagsmith-firefighter skill." \
  --plugin-dir . --output-format json --allowedTools Skill Read "Bash(node:*)" "Bash(git grep:*)"

# 2. after a human approves: kill + verify + trail
FIREBREAK_APPROVED=new_checkout claude -p "... approved killing new_checkout in Production." \
  --plugin-dir . --output-format json --allowedTools Skill Read "Bash(node:*)" "Bash(flagsmith flag disable:*)" "Bash(flagsmith eval:*)"
```

`flag disable` is only in the allowed tools of the second call, so the first call cannot change Flagsmith even if the model tried.

## Safety

- Read-only until approval. `allowed-tools` pre-approves only read commands, so the agent host also asks before any `flag disable`. And the Flagsmith CLI itself refuses non-interactive changes without `--yes`, which the skill only passes after a human says yes.
- Works on every Flagsmith plan: uses the audit log when it exists, and falls back to feature-state timestamps + feature versions on the free plan (where the audit log is empty).
- One change per approval, only in the incident's environment, only reversible operations (no deletes, no archive).
- Snapshot before every change; the rollback command is printed and written into the issue.
- Weak evidence (no flag changed in the window, or top score < 0.5) → the skill recommends *not* killing anything.

## Token efficiency

Each script prints ≤ 9 lines. The CLI is called with `--json` and filtered in-script, never dumped to the model. The change history is fetched once and only the top 3 suspects get a `flag get`. `plan.mjs` does ranking + snapshot + plan in a single tool call.

Measured on the demo incident (Claude Code headless, default model, Flagsmith Cloud free plan):

| Run | Turns | Time | Output tokens | Cache reads | Cost |
|---|---|---|---|---|---|
| Plan only, v1 (separate scripts) | 12 | 55 s | 3,256 | 465k | $0.92 |
| **Plan only, v2 (`plan.mjs`)** | **7** | **30 s** | **1,462** | **265k** | $0.85 |
| Approved: kill + verify + trail | 10 | 58 s | 2,918 | 509k | $0.64 |

The skill's own footprint (SKILL.md + every script output) is ~3k tokens per run; the rest is the agent host's baseline context re-read each turn, which is why cutting turns matters more than cutting output.

## How it meets the judging criteria

| Criterion | How |
|---|---|
| T4 Completes the whole job | Symptom → suspect → snapshot → approved kill → SDK-side verify → issue + flag annotation |
| T4 Token efficiency | See above; measured count recorded for the demo run |
| T4 Creative CLI use | `flagsmith api` (audit log, or feature states + versions + org users on free plans) + `flag get/disable/update --weight` + `eval` chained with `git grep` and `gh` |
| T4 Safety around production | Snapshot, single-env scope, approval gate, reversible-only, "don't kill on weak evidence" |
| T2 Uses CLI / API / MCP | The bot drives the same skill through the CLI |
| T2 Saves real time | Minutes of audit-log archaeology → one ranked answer in seconds |
| T2 Human approves | Slack Approve button is the only path to a change |
| T2 Clear output | One plan block / one Slack message: suspect, evidence, action, rollback |
