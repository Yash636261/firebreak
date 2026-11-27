// Shared helpers for the firefighter scripts. No dependencies: Node 18+ only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const WIN = process.platform === "win32";

// Quote one argument for cmd.exe. The npm-installed CLI is a .cmd shim on
// Windows, so it only runs through a shell, and `&` in an API path would
// otherwise split the command.
const q = (a) => (WIN ? `"${String(a).replace(/"/g, '""')}"` : a);

/** Run a command. Returns { code, out, err }. Never throws on non-zero exit. */
export function run(cmd, args, { cwd } = {}) {
  const r = spawnSync(cmd, args.map(q), {
    cwd,
    encoding: "utf8",
    shell: WIN,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) return { code: 127, out: "", err: String(r.error.message) };
  return { code: r.status ?? 1, out: r.stdout ?? "", err: (r.stderr ?? "").trim() };
}

/** Run the Flagsmith CLI with --json and parse the result. Exits on failure. */
export function fsJson(args) {
  const r = run("flagsmith", [...args, "--json", "--no-input"]);
  if (r.code !== 0) die(`flagsmith ${args.join(" ")} failed: ${r.err || r.out}`.slice(0, 400));
  try {
    return JSON.parse(r.out);
  } catch {
    die(`flagsmith ${args[0]} returned non-JSON output`);
  }
}

export function die(msg, code = 2) {
  process.stderr.write(`firebreak: ${msg}\n`);
  process.exit(code);
}

/** Minimal --flag value parser. Bare --flag becomes true. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * Resolve project id, environment key and environment id/name from the CLI's
 * own context (flagsmith.json, env vars, flags). Two cheap calls, cached per run.
 */
export function context(overrides = {}) {
  const cfg = fsJson(["config"]);
  const project = overrides.project ?? cfg.project?.value;
  const envKey = overrides.env ?? cfg.environment?.value;
  if (!project) die("no project: run `flagsmith init` or pass --project");
  if (!envKey) die("no environment: run `flagsmith init` or pass --env <client-side key>");
  const p = /^\d+$/.test(String(project)) ? { id: Number(project) } : fsJson(["project", "get", String(project)]);
  const e = fsJson(["environment", "get", String(envKey)]);
  return { projectId: p.id, envKey: e.api_key ?? envKey, envId: e.id, envName: e.name ?? String(envKey) };
}

/** Flags passed to every state-changing or env-scoped CLI call. */
export const scope = (ctx) => ["-p", String(ctx.projectId), "-e", ctx.envKey];

export function stateDir(repo = process.cwd()) {
  const d = join(repo, ".firebreak");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

/** "14:02" in local time, or "3m" style durations. */
export const hhmm = (d) => new Date(d).toTimeString().slice(0, 5);
export const ago = (ms) => {
  const m = Math.round(Math.abs(ms) / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
};
