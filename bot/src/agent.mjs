// Runs the flagsmith-firefighter skill headless through Claude Code.
// Two calls, two permission sets:
//   plan()    read-only tools; FIREBREAK_MODE=plan  -> structured plan, no changes
//   execute() adds the approved command on the approved flag only + `eval`;
//             FIREBREAK_APPROVED=<feature> -> kill, verify, trail
// The model cannot change Flagsmith in plan() even if it tried: the tool is not allowed.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const MODEL = process.env.FIREBREAK_MODEL ?? "sonnet";
const BUDGET = process.env.FIREBREAK_MAX_USD ?? "1";

const READ_TOOLS = ["Skill", "Read", "Bash(node:*)", "Bash(git grep:*)", "Bash(flagsmith flag get:*)"];

// The only write the approved run may make: the approved verb on the approved
// flag, e.g. `Bash(flagsmith flag disable new_checkout:*)`. Not "any flag update".
export function writeToolFor(action) {
  // The plan text comes from the model: one plain command only, no chaining or substitution.
  if (/[;&|`$<>\n\r]/.test(action ?? "")) throw new Error(`refusing an action with shell control characters: ${action}`);
  const m = /^flagsmith flag (disable|update) ([\w.-]+)\b/.exec(action ?? "");
  if (!m) throw new Error(`refusing to execute an action that is not a flag disable/update: ${action}`);
  if (/\s--enable\b|\s(delete|archive)\b/.test(action)) throw new Error(`refusing a non-kill action: ${action}`);
  return `Bash(flagsmith flag ${m[1]} ${m[2]}:*)`;
}

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["kill", "no_flag"] },
    feature: { type: "string", description: "suspect flag key, empty if no_flag" },
    score: { type: "number" },
    evidence: { type: "string", description: "the evidence line from the FIREBREAK PLAN" },
    mechanism: { type: "string", description: "one sentence: how this flag causes this error, from reading the code" },
    effect: { type: "string", description: "the effect line from the FIREBREAK PLAN (what the action will do)" },
    action: { type: "string", description: "exact command from the plan, without --yes" },
    rollback: { type: "string" },
    env: { type: "string" },
    snapshot: { type: "string", description: "snapshot file path from the plan" },
  },
  required: ["decision", "feature", "evidence", "mechanism", "effect", "action", "rollback", "env"],
};

const EXEC_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "failed", "refused"] },
    command_run: { type: "string" },
    verified: { type: "boolean" },
    verify_line: { type: "string" },
    trail_file: { type: "string" },
    rollback: { type: "string" },
    summary: { type: "string", description: "at most 3 short lines for the on-call channel" },
  },
  required: ["status", "verified", "summary"],
};

function runClaude(prompt, { tools, schema, env }) {
  const args = [
    "-p", prompt,
    "--plugin-dir", REPO,
    "--output-format", "json",
    "--json-schema", JSON.stringify(schema),
    "--model", MODEL,
    "--max-budget-usd", BUDGET,
    "--allowedTools", ...tools,
  ];
  // --bare skips the host's hooks, memory and CLAUDE.md: less context per turn.
  // It needs ANTHROPIC_API_KEY (no OAuth), so only use it when one is set.
  if (process.env.ANTHROPIC_API_KEY) args.unshift("--bare");

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, args, { cwd: REPO, env: { ...process.env, ...env }, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      let j;
      try {
        j = JSON.parse(out);
      } catch {
        return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`));
      }
      if (j.is_error) return reject(new Error(`claude error: ${String(j.result ?? j.subtype).slice(0, 400)}`));
      const u = j.usage ?? {};
      resolve({
        data: j.structured_output ?? null,
        text: j.result ?? "",
        usage: {
          turns: j.num_turns,
          seconds: Math.round((j.duration_ms ?? 0) / 1000),
          costUsd: Number((j.total_cost_usd ?? 0).toFixed(3)),
          outputTokens: u.output_tokens ?? 0,
          inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        },
      });
    });
  });
}

export function plan(incident) {
  const prompt = [
    `Production alert from ${incident.service} (${incident.environment}): "${incident.title}".`,
    `Started at ${incident.startedAt}; ${Math.round(incident.errorRate * 100)}% of requests failing.`,
    `The stack trace is saved at ${incident.stackFile}.`,
    "Use the flagsmith-firefighter skill to find the flag behind it and build the FIREBREAK PLAN.",
    "You are running headless for a chat-ops bot: change nothing, and return the plan as structured output.",
  ].join(" ");
  return runClaude(prompt, { tools: READ_TOOLS, schema: PLAN_SCHEMA, env: { FIREBREAK_MODE: "plan" } });
}

export function execute(incident, approver) {
  const p = incident.plan;
  const prompt = [
    `Incident: ${incident.service} "${incident.title}" since ${incident.startedAt}. Stack trace: ${incident.stackFile}.`,
    `The flagsmith-firefighter plan was already built (snapshot ${p.snapshot ?? "in .firebreak/"}):`,
    `suspect ${p.feature}; action \`${p.action}\`; rollback \`${p.rollback}\`.`,
    `${approver} approved exactly this action. Skip steps 1-3: run step 4 (that action with --yes --no-input), step 5 (verify.mjs), and step 6 (trail.mjs, write the file only).`,
    "Do not create a GitHub issue and do not annotate the flag: the bot reports in chat.",
  ].join(" ");
  return runClaude(prompt, {
    tools: [...READ_TOOLS, writeToolFor(p.action), "Bash(flagsmith eval:*)"],
    schema: EXEC_SCHEMA,
    env: { FIREBREAK_APPROVED: p.feature },
  });
}
