// Incident lifecycle. Channels (Slack, the local web page) listen on `bus` and
// call approve()/reject(); only this module talks to the agent.
//
//   investigating -> awaiting_approval -> executing -> resolved | exec_failed
//                 -> no_flag                      (nothing to approve)
//                 -> plan_failed
//   awaiting_approval -> rejected
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO, execute, plan } from "./agent.mjs";

export const bus = new EventEmitter();
const DIR = join(REPO, ".firebreak", "alerts");
const DB = join(REPO, ".firebreak", "incidents.json");
mkdirSync(DIR, { recursive: true });

const incidents = new Map(existsSync(DB) ? JSON.parse(readFileSync(DB, "utf8")).map((i) => [i.id, i]) : []);
const save = () => writeFileSync(DB, JSON.stringify([...incidents.values()], null, 2));

const set = (inc, patch, event) => {
  Object.assign(inc, patch, { updatedAt: new Date().toISOString() });
  inc.log.push({ at: inc.updatedAt, event, ...(patch.error ? { error: patch.error } : {}) });
  save();
  bus.emit("change", inc, event);
};

export const list = () => [...incidents.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const get = (id) => incidents.get(id);

const DEDUPE_MS = 10 * 60_000;

/** Accept an alert. Returns the incident, or null if it duplicates an open one. */
export function open(alert) {
  const dupe = list().find(
    (i) => i.service === alert.service && !["resolved", "rejected", "no_flag", "plan_failed", "exec_failed"].includes(i.status) &&
      Date.now() - Date.parse(i.createdAt) < DEDUPE_MS,
  );
  if (dupe) return null;

  const id = `inc-${Date.now().toString(36)}`;
  const stackFile = join(DIR, `${id}.txt`);
  writeFileSync(stackFile, `${alert.stack ?? alert.title ?? ""}\n`);
  const inc = {
    id,
    service: alert.service ?? "unknown",
    environment: alert.environment ?? "Production",
    title: alert.title ?? "error spike",
    startedAt: alert.startedAt ?? new Date().toISOString(),
    errorRate: Number(alert.errorRate ?? 0),
    stackFile: stackFile.replace(REPO, "").replace(/^[\\/]/, ""),
    status: "investigating",
    createdAt: new Date().toISOString(),
    log: [],
    usage: {},
  };
  incidents.set(id, inc);
  set(inc, {}, "opened");
  investigate(inc);
  return inc;
}

async function investigate(inc) {
  try {
    const r = await plan(inc);
    if (!r.data) throw new Error(`no structured plan returned: ${r.text.slice(0, 200)}`);
    inc.usage.plan = r.usage;
    if (r.data.decision === "no_flag") set(inc, { status: "no_flag", plan: r.data }, "no_flag");
    else set(inc, { status: "awaiting_approval", plan: r.data }, "planned");
  } catch (e) {
    set(inc, { status: "plan_failed", error: e.message }, "plan_failed");
  }
}

export async function approve(id, approver) {
  const inc = incidents.get(id);
  if (!inc) throw new Error("no such incident");
  if (inc.status !== "awaiting_approval") return inc; // double click, or already handled
  set(inc, { status: "executing", approvedBy: approver }, "approved");
  try {
    const r = await execute(inc, approver);
    inc.usage.execute = r.usage;
    const ok = r.data?.status === "done" && r.data.verified;
    set(inc, { status: ok ? "resolved" : "exec_failed", result: r.data ?? { summary: r.text.slice(0, 500) } }, ok ? "resolved" : "exec_failed");
  } catch (e) {
    set(inc, { status: "exec_failed", error: e.message }, "exec_failed");
  }
  return inc;
}

export function reject(id, who) {
  const inc = incidents.get(id);
  if (!inc || inc.status !== "awaiting_approval") return inc;
  set(inc, { status: "rejected", rejectedBy: who }, "rejected");
  return inc;
}
