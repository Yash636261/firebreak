# 🔥 Firebreak

[![test](https://github.com/Yash636261/firebreak/actions/workflows/test.yml/badge.svg)](https://github.com/Yash636261/firebreak/actions/workflows/test.yml)

**A feature flag broke production. Firebreak finds which one, turns it off after a human says yes, proves it's off, and leaves the incident trail.**

Built for *Toggle Wars*, the Flagsmith hackathon · **Track 02** (AI Agents and Feature Flags) · **Track 04** (Flagsmith Agent Skills)

---

## The problem

Feature flags are the fastest kill switch a team has, but only if you know *which* flag to flip. When checkout starts failing at 2 a.m., the on-call engineer is digging through the audit log, grepping the code for flag keys, and guessing. Then they flip the switch in a hurry, in production, with no snapshot and no record.

Firebreak does the digging, and leaves the decision with a human:

1. **Finds the suspect.** Ranks flags that changed shortly before the errors, boosted when a file that reads the flag is in the stack trace.
2. **Proposes the smallest fix.** Snapshots the flag and writes a plan with the evidence, the exact command and the rollback.
3. **Waits for a yes.** Nothing changes in Flagsmith until a person approves.
4. **Kills, verifies, records.** Turns the flag off, checks an SDK now sees it off, and writes the incident record with the rollback.

## What's in the repo

| Path | What it is | Track |
|---|---|---|
| [`skills/flagsmith-firefighter/`](skills/flagsmith-firefighter/SKILL.md) | **Agent Skill.** The whole job above, through the Flagsmith CLI. Works in Claude Code or any Agent Skills host. | 04 |
| [`bot/`](bot/) | **Agent.** Alert webhook → skill runs headless (read-only) → Slack Approve / Reject → skill runs again, allowed to touch only the approved flag → result in thread. | 02 |
| [`demo-app/`](demo-app/) | A tiny shop whose `new_checkout` path has a planted bug, a traffic script and an error-spike alert. | demo |
| [`tests/`](tests/) | Spec check for the skill, the bot's guard rails, and the ranking logic against a fake Flagsmith CLI. | |

## A real run (Flagsmith Cloud, free plan)

Flag off: 0% errors. Someone turns `new_checkout` on in Production: ~30% of checkouts throw `TypeError: Cannot read properties of undefined (reading 'reduce')`. The shop raises an alert. Then:

```
$ node scripts/plan.mjs --at 2026-11-27T04:58:25Z --stack demo-app/logs/last-error.txt
FIREBREAK PLAN
suspect:  new_checkout  (score 1.00)
evidence: environment default now ON at 04:58Z by <author>, 6s before the first errors; read at demo-app/src/checkout.mjs:5, which is in the stack trace
action:   flagsmith flag disable new_checkout -p 56714 -e <envKey>
rollback: flagsmith flag update new_checkout -p 56714 -e <envKey> --enable --yes
env:      Production
Approve? (yes / no)
```

The agent adds the mechanism from reading the code: *"session-restored carts carry `lines`, not `items`, so `cart.items.reduce` throws."* After **yes**:

```
$ flagsmith flag disable new_checkout -p 56714 -e <envKey> --yes --no-input
$ node scripts/verify.mjs new_checkout
VERIFIED new_checkout resolves OFF in Production (0s, reason STATIC)
```

Traffic right after: **0% errors**. `trail.mjs` writes the incident record (symptom, evidence, action, verification, rollback, follow-ups).

## Install the skill

```bash
npm install -g @flagsmith/cli && flagsmith login && flagsmith init
```

Claude Code, as a plugin:
```
/plugin marketplace add Yash636261/firebreak
/plugin install firebreak@firebreak
```
Or for one session from a clone: `claude --plugin-dir path/to/firebreak`. Any other Agent Skills host: copy `skills/flagsmith-firefighter/` into its skills folder. Needs Node 18+ and git.

Then: *"Checkout is throwing 500s since 10:20, stack trace in logs/last-error.txt. Use the flagsmith-firefighter skill."*

## The bot (Track 02)

```
demo shop ──alert──▶ bot ──plan call (read-only tools)──▶ Claude Code + skill ──▶ FIREBREAK PLAN
                      │                                                               │
                      ◀───────────── Slack message with Approve / Reject ◀────────────┘
                      │ human clicks Approve (confirm dialog)
                      └──execute call (only `flagsmith flag disable <that flag>` allowed)──▶ kill → verify → trail ──▶ thread reply
```

```bash
cd bot && npm install && cp .env.example .env   # Slack tokens optional
npm start                                       # board on http://127.0.0.1:4100, alerts on POST /alert
cd ../demo-app && npm install && ALERT_WEBHOOK_URL=http://127.0.0.1:4100/alert npm start
```

Slack app: create it from [`bot/slack-manifest.yml`](bot/slack-manifest.yml) (Socket Mode, so no public URL), install it, invite `@firebreak` to the channel. Without Slack tokens the bot uses the local board for approvals.

**Guard rails, on top of the skill's own:**
- The plan call gets only read tools. The execute call gets exactly one write permission, scoped to the approved verb and flag (`Bash(flagsmith flag disable new_checkout:*)`). The model cannot touch any other flag even if it tried.
- Actions that enable a flag, delete or archive anything, or contain shell control characters are refused before the agent runs.
- Approve has a Slack confirm dialog and an optional approver allow-list (`SLACK_APPROVERS`); double clicks are ignored; alerts for an open incident are de-duplicated.

**Cost**, measured on the demo incident with `FIREBREAK_MODEL=sonnet`: plan **8 turns · 35 s · $0.36**, approved kill + verify + record **10 turns · 55 s · $0.39**. About **$0.75 and 90 seconds** per incident.

## Run the whole demo

```bash
npm install -g @flagsmith/cli && flagsmith login
flagsmith init                               # at the repo root: your project + Production
# in Flagsmith: create a boolean feature `new_checkout`, off in Production
(cd bot && npm install && npm start)         # terminal 1
(cd demo-app && npm install && ALERT_WEBHOOK_URL=http://127.0.0.1:4100/alert npm start)   # terminal 2
(cd demo-app && npm run traffic)             # terminal 3: simulated shoppers
flagsmith flag enable new_checkout --yes     # the bad release: errors start, the alert fires
```

Open http://127.0.0.1:4100 (or Slack), read the plan, click **Approve**.

## Safety

- **Read-only until approval.** The skill's `allowed-tools` pre-approves only read commands, so the agent host also asks before any `flag disable`. The Flagsmith CLI itself refuses non-interactive changes without `--yes`, which the skill passes only after a human says yes.
- **One change per approval**, only in the incident's environment, only reversible operations (no deletes, no archive).
- **Snapshot before every change**; the rollback command is printed and written into the record.
- **Weak evidence → no kill.** If no flag changed in the window, or the best score is below 0.5, it says "no flag explains this incident" and recommends changing nothing. A wrong kill is a second incident.
- **Works on every Flagsmith plan.** It uses the audit log when there is one, and falls back to feature-state timestamps + feature versions on the free plan, where the audit log is empty.

## Token efficiency

Each script prints ≤ 9 lines. The CLI is called with `--json` and filtered in-script, never dumped to the model. The change history is fetched once; only the top 3 suspects get a `flag get`. `plan.mjs` does ranking + snapshot + plan in one tool call.

Measured on the demo incident (Claude Code headless, default model):

| Run | Turns | Time | Output tokens | Cache reads | Cost |
|---|---|---|---|---|---|
| Plan only, v1 (separate scripts) | 12 | 55 s | 3,256 | 465k | $0.92 |
| **Plan only, v2 (`plan.mjs`)** | **7** | **30 s** | **1,462** | **265k** | $0.85 |
| Approved: kill + verify + record | 10 | 58 s | 2,918 | 509k | $0.64 |

The skill's own footprint (SKILL.md + every script output) is ~3k tokens per run. The rest is the agent host's baseline context, re-read each turn, which is why cutting turns matters more than cutting output.

## Headless use

```bash
# 1. investigate only: prints the FIREBREAK PLAN, changes nothing
FIREBREAK_MODE=plan claude -p "Checkout 500s since <time>, stack in <file>. Use the flagsmith-firefighter skill." \
  --plugin-dir . --output-format json --allowedTools Skill Read "Bash(node:*)" "Bash(git grep:*)"

# 2. after a human approves: kill + verify + record
FIREBREAK_APPROVED=new_checkout claude -p "... approved killing new_checkout in Production." \
  --plugin-dir . --output-format json \
  --allowedTools Skill Read "Bash(node:*)" "Bash(flagsmith flag disable new_checkout:*)" "Bash(flagsmith eval:*)"
```

## Tests

```bash
npm test
```

19 tests, no Flagsmith account needed: the skill against the Agent Skills spec; the bot's write-permission guard (kills allowed, enable/delete/archive/chained commands refused); and suspect ranking + plan decisions on both the audit-log and free-plan paths against a fake `flagsmith` CLI. CI runs them on Linux and Windows.

## How it meets the judging criteria

| Criterion | How |
|---|---|
| **T4** Completes the whole job | Symptom → suspect → snapshot → approved kill → SDK-side verify → incident record + rollback |
| **T4** Token efficiency | One-call `plan.mjs`, ≤ 9-line script outputs, measured per run (table above) |
| **T4** Creative CLI use | `flagsmith api` (audit log, or feature states + versions + org users on free plans), `flag get/disable/update --weight`, `eval`, chained with `git grep` and `gh` |
| **T4** Safety around production | Snapshot, single-env scope, approval gate, reversible-only, "don't kill on weak evidence" |
| **T2** Uses CLI / API / MCP | The bot drives the skill, which drives the Flagsmith CLI and API |
| **T2** Saves real time | Change-history digging + code search → a ranked answer with evidence in ~35 s |
| **T2** Human approves changes | Slack Approve (with confirm) is the only path to a change, and that change is permission-scoped to one flag |
| **T2** Clear output | One Slack message: suspect, evidence, why, action, rollback; result in thread |

## License

MIT
