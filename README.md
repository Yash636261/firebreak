# 🔥 Firebreak

[![test](https://github.com/Yash636261/firebreak/actions/workflows/test.yml/badge.svg)](https://github.com/Yash636261/firebreak/actions/workflows/test.yml)

**A feature flag broke production. Firebreak finds which one, turns it off after a human says yes, proves it's off, and leaves the incident trail.**

Built for *Toggle Wars*, the Flagsmith hackathon · **Track 02** (AI Agents and Feature Flags) · **Track 04** (Flagsmith Agent Skills)

**▶ [Demo video (2:44)](https://youtu.be/XOT2aATlkdI)** · **[Project site with an interactive replay](https://firebreak-site-eight.vercel.app)**

[![Firebreak demo video](https://img.youtube.com/vi/XOT2aATlkdI/maxresdefault.jpg)](https://youtu.be/XOT2aATlkdI)

---

## The problem

Feature flags are the fastest kill switch a team has, but only if you know *which* flag to flip. When checkout starts failing at 2 a.m., the on-call engineer is digging through the audit log, grepping the code for flag keys, and guessing. Then they flip the switch in a hurry, in production, with no snapshot and no record.

Firebreak does the digging, and leaves the decision with a human:

1. **Finds the suspect.** Ranks flags that changed shortly before the errors, boosted when a file that reads the flag is in the stack trace.
2. **Proposes the smallest fix.** A broken **A/B test variant** is rolled back to control (the flag and the experiment stay on); a broken release is turned off; a segment override is turned off for that segment only. Snapshots the flag and writes a plan with the evidence, the exact command and the rollback.
3. **Waits for a yes.** Nothing changes in Flagsmith until a person approves.
4. **Fixes, verifies, records.** Applies the change, checks an SDK now sees it (flag off, or sample users all on control), and writes the incident record with the rollback.

### What the agent decides alone, and where it stops for a person

| The agent does on its own | A person decides |
|---|---|
| Read change history, code and the stack trace | Whether to change anything in Flagsmith at all |
| Rank suspects and explain the mechanism | Approve or reject the one proposed change |
| Pick the smallest fix (control rollback / segment / disable) | Anything beyond that one change (a second suspect needs a second yes) |
| Snapshot state, write the rollback command | When to roll back, once the bug is fixed |
| Verify the fix through an SDK, write the incident record | Publishing: GitHub issue and flag annotation are offered, not done |
| **Refuse** when evidence is weak (score < 0.5): "no flag explains this" | |

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

### And when it's an A/B test

The demo shop also runs an experiment, `checkout_layout`: control `classic` vs variant `express`. Launch it at 50% and guest shoppers on `express` crash. Firebreak doesn't kill the experiment's flag; it sends everyone back to control and keeps the split in the rollback:

```
FIREBREAK PLAN
suspect:  checkout_layout  (score 1.00)
evidence: environment default now ON, experiment sending 50% of users to variants at 06:33Z by <author>, 5s before the first errors; read at demo-app/src/checkout.mjs:8, which is in the stack trace
effect:   roll the experiment back to control: everyone gets "classic"; the flag stays on
action:   flagsmith flag update checkout_layout --weight express=0 -p 56714 -e <envKey>
rollback: flagsmith flag update checkout_layout -p 56714 -e <envKey> --enable --weight express=50 --yes
others:   new_checkout 0.35

VERIFIED checkout_layout all 5 sample users get control "classic" (live variants: 0) in Production (1s)
```

Once the variant is fixed, the rollback line relaunches the experiment exactly as it was.

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

**Cost**, measured with `FIREBREAK_MODEL=sonnet`:

| Incident | Plan (read-only) | Approved fix + verify + record |
|---|---|---|
| Broken release (`new_checkout` → disable) | 8 turns · 35 s · $0.36 | 10 turns · 55 s · $0.39 |
| Broken A/B variant (`checkout_layout` → control) | 10 turns · 57 s · $0.40 | 8 turns · 43 s · $0.37 |

About **$0.75 and 90 seconds** per incident.

## Run the whole demo

```bash
npm install -g @flagsmith/cli && flagsmith login
flagsmith init                               # at the repo root: your project + Production
flagsmith feature create new_checkout --yes                                   # boolean, off
flagsmith feature create checkout_layout --value classic --yes                # experiment: control "classic"
flagsmith feature variant add checkout_layout --key express --value express --weight 0 --yes
(cd bot && npm install && npm start)         # terminal 1
(cd demo-app && npm install && ALERT_WEBHOOK_URL=http://127.0.0.1:4100/alert npm start)   # terminal 2
(cd demo-app && npm run traffic)             # terminal 3: simulated shoppers
flagsmith flag enable new_checkout --yes     # scenario 1, bad release: errors start, the alert fires
# or
flagsmith flag update checkout_layout --enable --weight express=50 --yes     # scenario 2, bad A/B variant
```

Open http://127.0.0.1:4100 (or Slack), read the plan, click **Approve**.

## Safety

- **Read-only until approval.** The skill's `allowed-tools` pre-approves only read commands, so the agent host also asks before any `flag disable`. The Flagsmith CLI itself refuses non-interactive changes without `--yes`, which the skill passes only after a human says yes.
- **One change per approval**, only in the incident's environment, only reversible operations (no deletes, no archive).
- **Snapshot before every change**; the rollback command is printed and written into the record.
- **Weak evidence → no kill.** If no flag changed in the window, or the best score is below 0.5, it says "no flag explains this incident" and recommends changing nothing. A wrong kill is a second incident.
- **Works on every Flagsmith plan.** The audit log is a paid-plan feature; when it is empty (free plan) Firebreak falls back to feature-state timestamps + feature versions.

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

20 tests, no Flagsmith account needed: the skill against the Agent Skills spec; the bot's write-permission guard (kills and control rollbacks allowed, enable/delete/archive/chained commands refused); and suspect ranking + plan decisions (disable, experiment back to control, refuse on weak evidence) on both the audit-log and free-plan paths against a fake `flagsmith` CLI. Tests follow Flagsmith's own conventions (`# Given / # When / # Then`, product-readable names). CI runs them on Linux and Windows.

## How it meets the judging criteria

| Criterion | How |
|---|---|
| **T4** Completes the whole job | Symptom → suspect → snapshot → approved fix (disable, or A/B test back to control) → SDK-side verify → incident record + rollback |
| **T4** Token efficiency | One-call `plan.mjs`, ≤ 9-line script outputs, measured per run (table above) |
| **T4** Creative CLI use | `flagsmith api` (audit log, or feature states + versions + org users on free plans), `flag get/disable/update --weight`, `eval`, chained with `git grep` and `gh` |
| **T4** Safety around production | Snapshot, single-env scope, approval gate, reversible-only, smallest blast radius (experiments keep running on control), "don't kill on weak evidence" |
| **T2** Uses CLI / API / MCP | The bot drives the skill, which drives the Flagsmith CLI and API |
| **T2** Saves real time | Change-history digging + code search → a ranked answer with evidence in ~35 s |
| **T2** Human approves changes | Slack Approve (with confirm) is the only path to a change, and that change is permission-scoped to one flag |
| **T2** Clear output | One Slack message: suspect, evidence, why, action, rollback; result in thread |

## License

MIT
