// HTTP side of the bot:
//   POST /alert                 alert webhook (the demo shop's ALERT_WEBHOOK_URL)
//   GET  /                      incident board with Approve / Reject (local fallback to Slack)
//   POST /i/:id/approve|reject  form actions from that page
//   GET  /api/incidents         JSON
// The board is for local demos only: anyone who can reach the port can approve.
// Bind it to localhost (the default) and use Slack for anything shared.
import { createServer } from "node:http";
import { approve, get, list, open, reject } from "./incidents.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const STATUS = {
  investigating: ["#b58900", "Investigating…"],
  awaiting_approval: ["#d33682", "Waiting for approval"],
  executing: ["#b58900", "Approved, applying…"],
  resolved: ["#2aa198", "Resolved"],
  rejected: ["#839496", "Rejected"],
  no_flag: ["#839496", "No flag explains this"],
  plan_failed: ["#dc322f", "Investigation failed"],
  exec_failed: ["#dc322f", "Execution failed"],
};

function card(i) {
  const [color, label] = STATUS[i.status] ?? ["#839496", i.status];
  const p = i.plan;
  const r = i.result;
  const u = (k) => (i.usage?.[k] ? `${k}: ${i.usage[k].turns} turns · ${i.usage[k].seconds}s · ${i.usage[k].outputTokens} out tok · $${i.usage[k].costUsd}` : "");
  return `<section style="border-left:6px solid ${color}">
  <h2>${esc(i.title)} <small>${esc(i.service)} · ${esc(i.environment)} · ${Math.round(i.errorRate * 100)}% errors since ${esc(i.startedAt.slice(11, 19))}Z</small></h2>
  <p class="status" style="color:${color}">${label}${i.approvedBy ? ` · approved by ${esc(i.approvedBy)}` : ""}${i.rejectedBy ? ` · by ${esc(i.rejectedBy)}` : ""}</p>
  ${p ? `<dl>
    <dt>Suspect</dt><dd><code>${esc(p.feature || "—")}</code> ${p.score != null ? `(score ${esc(p.score)})` : ""}</dd>
    <dt>Evidence</dt><dd>${esc(p.evidence)}</dd>
    <dt>Why</dt><dd>${esc(p.mechanism)}</dd>
    ${p.decision === "kill" && p.effect ? `<dt>Effect</dt><dd>${esc(p.effect)}</dd>` : ""}
    ${p.decision === "kill" ? `<dt>Action</dt><dd><code>${esc(p.action)}</code></dd><dt>Rollback</dt><dd><code>${esc(p.rollback)}</code></dd>` : ""}
  </dl>` : ""}
  ${i.status === "awaiting_approval" ? `<form method="post" action="/i/${i.id}/approve" style="display:inline"><button class="go">Approve${/--weight/.test(i.plan?.action ?? "") ? " rollback to control" : " kill"}</button></form>
  <form method="post" action="/i/${i.id}/reject" style="display:inline"><button>Reject</button></form>` : ""}
  ${r ? `<pre>${esc(r.summary)}${r.verify_line ? `\n${esc(r.verify_line)}` : ""}</pre>` : ""}
  ${i.error ? `<pre class="err">${esc(i.error)}</pre>` : ""}
  <p class="meta">${[u("plan"), u("execute")].filter(Boolean).map(esc).join("<br>")}</p>
</section>`;
}

function page() {
  const items = list();
  const live = items.some((i) => ["investigating", "executing"].includes(i.status));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Firebreak</title>
${live ? '<meta http-equiv="refresh" content="3">' : '<meta http-equiv="refresh" content="10">'}
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;background:#fdf6e3;color:#073642}
section{background:#fff;padding:.8rem 1.2rem;margin:1rem 0;border-radius:6px}
h2{font-size:1.1rem;margin:.2rem 0} small{color:#657b83;font-weight:normal}
dt{font-weight:600;float:left;width:6.5rem} dd{margin:0 0 .4rem 6.5rem}
code{background:#eee8d5;padding:0 .3rem;border-radius:3px;word-break:break-all}
button{font:inherit;padding:.4rem .9rem;border-radius:4px;border:1px solid #93a1a1;background:#fff;cursor:pointer}
.go{background:#dc322f;color:#fff;border-color:#dc322f}
pre{background:#eee8d5;padding:.6rem;white-space:pre-wrap} .err{background:#fdd} .meta{color:#93a1a1;font-size:.8rem}
</style></head><body><h1>🔥 Firebreak</h1>
${items.length ? items.map(card).join("") : "<p>No incidents. Waiting for alerts on <code>POST /alert</code>.</p>"}
</body></html>`;
}

async function body(req) {
  let raw = "";
  for await (const c of req) raw += c;
  return raw;
}

export function startWeb({ port, host }) {
  createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/alert") {
        const inc = open(JSON.parse(await body(req)));
        res.writeHead(inc ? 202 : 200, { "content-type": "application/json" });
        return res.end(JSON.stringify(inc ? { id: inc.id, status: inc.status } : { deduped: true }));
      }
      const m = /^\/i\/([\w-]+)\/(approve|reject)$/.exec(req.url);
      if (req.method === "POST" && m) {
        if (!get(m[1])) return res.writeHead(404).end();
        if (m[2] === "approve") approve(m[1], "web board (localhost)"); // runs in background
        else reject(m[1], "web board (localhost)");
        res.writeHead(303, { location: "/" });
        return res.end();
      }
      if (req.method === "GET" && req.url === "/api/incidents") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(list()));
      }
      if (req.method === "GET" && req.url === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page());
      }
      res.writeHead(404).end();
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  }).listen(port, host, () => console.warn(`firebreak board on http://${host}:${port}  (alerts: POST /alert)`));
}
