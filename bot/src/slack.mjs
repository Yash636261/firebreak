// Slack channel for the bot (Socket Mode: no public URL needed).
// One message per incident, updated in place as it moves through the lifecycle;
// the result of the kill goes in a thread reply.
import bolt from "@slack/bolt";
import { approve, bus, reject } from "./incidents.mjs";

const { App } = bolt;

export async function startSlack({ botToken, appToken, channel, approvers }) {
  const app = new App({ token: botToken, appToken, socketMode: true });
  const posts = new Map(); // incident id -> Promise<{ channel, ts }>

  const canApprove = (user) => !approvers.length || approvers.includes(user);
  const pct = (i) => `${Math.round(i.errorRate * 100)}%`;
  const usage = (i) =>
    Object.entries(i.usage ?? {})
      .map(([k, u]) => `${k}: ${u.turns} turns · ${u.seconds}s · ${u.outputTokens} output tokens · $${u.costUsd}`)
      .join("   |   ");

  function blocks(i, statusLine) {
    const p = i.plan;
    const b = [
      { type: "header", text: { type: "plain_text", text: `🔥 ${i.service}: ${i.title}`.slice(0, 150) } },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `*${i.environment}* · ${pct(i)} of requests failing since ${i.startedAt.slice(11, 19)}Z · \`${i.id}\`` }],
      },
    ];
    if (p) {
      b.push({
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Suspect flag*\n\`${p.feature || "none"}\`${p.score != null ? ` (score ${p.score})` : ""}` },
          { type: "mrkdwn", text: `*Environment*\n${p.env || i.environment}` },
        ],
      });
      b.push({ type: "section", text: { type: "mrkdwn", text: `*Evidence*\n${p.evidence}` } });
      if (p.mechanism) b.push({ type: "section", text: { type: "mrkdwn", text: `*Why*\n${p.mechanism}` } });
      if (p.decision === "kill") {
        b.push({
          type: "section",
          text: { type: "mrkdwn", text: `*Proposed action*${p.effect ? `: ${p.effect}` : ""}\n\`\`\`${p.action}\`\`\`\n*Rollback*\n\`\`\`${p.rollback}\`\`\`` },
        });
      }
    }
    if (i.status === "awaiting_approval") {
      b.push({
        type: "actions",
        elements: [
          {
            type: "button",
            style: "danger",
            text: { type: "plain_text", text: /--weight/.test(p.action) ? `Approve: ${p.feature} back to control` : `Approve: kill ${p.feature}` },
            action_id: "fb_approve",
            value: i.id,
            confirm: {
              title: { type: "plain_text", text: /--weight/.test(p.action) ? "Roll back this experiment?" : "Kill this flag?" },
              text: { type: "mrkdwn", text: `This runs \`${p.action}\` in *${p.env}*.` },
              confirm: { type: "plain_text", text: "Do it" },
              deny: { type: "plain_text", text: "Cancel" },
            },
          },
          { type: "button", text: { type: "plain_text", text: "Reject" }, action_id: "fb_reject", value: i.id },
        ],
      });
    }
    b.push({ type: "context", elements: [{ type: "mrkdwn", text: statusLine }] });
    const u = usage(i);
    if (u) b.push({ type: "context", elements: [{ type: "mrkdwn", text: `_${u}_` }] });
    return b;
  }

  const STATUS = {
    opened: () => "🔎 Investigating with the flagsmith-firefighter skill… (read-only)",
    planned: () => "⏸️ Waiting for a human. Nothing has been changed in Flagsmith.",
    no_flag: () => "✅ No flag explains this incident. Nothing changed; check recent deploys.",
    plan_failed: (i) => `⚠️ Investigation failed: ${i.error}`,
    approved: (i) => `▶️ Approved by ${i.approvedBy}. Applying the approved action, then verifying…`,
    resolved: (i) => `✅ Resolved: approved action applied and verified with the SDK. Approved by ${i.approvedBy}.`,
    exec_failed: (i) => `⚠️ Execution failed after approval by ${i.approvedBy}: ${i.error ?? i.result?.summary ?? ""}`,
    rejected: (i) => `✋ Rejected by ${i.rejectedBy}. Nothing was changed.`,
  };

  bus.on("change", async (i, event) => {
    const status = STATUS[event]?.(i);
    if (!status) return;
    try {
      if (event === "opened") {
        posts.set(
          i.id,
          app.client.chat.postMessage({ channel, text: `🔥 ${i.service}: ${i.title}`, blocks: blocks(i, status) }).then((r) => ({ channel: r.channel, ts: r.ts })),
        );
        return;
      }
      const post = await posts.get(i.id);
      if (!post) return;
      await app.client.chat.update({ ...post, text: `🔥 ${i.service}: ${i.title}`, blocks: blocks(i, status) });
      if (event === "resolved" || event === "exec_failed") {
        const r = i.result ?? {};
        const lines = [r.summary, r.verify_line && `\`${r.verify_line}\``, r.rollback && `Rollback when fixed: \`${r.rollback}\``, r.trail_file && `Incident record: \`${r.trail_file}\``];
        await app.client.chat.postMessage({ channel: post.channel, thread_ts: post.ts, text: lines.filter(Boolean).join("\n") || status });
      }
    } catch (e) {
      console.error(`slack update failed (${event}): ${e.data?.error ?? e.message}`);
    }
  });

  app.action("fb_approve", async ({ ack, body, respond }) => {
    await ack();
    const user = body.user.id;
    if (!canApprove(user)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "You are not on this bot's approver list." });
      return;
    }
    approve(body.actions[0].value, `<@${user}>`);
  });

  app.action("fb_reject", async ({ ack, body, respond }) => {
    await ack();
    if (!canApprove(body.user.id)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "You are not on this bot's approver list." });
      return;
    }
    reject(body.actions[0].value, `<@${body.user.id}>`);
  });

  await app.start();
  console.warn(`slack connected (socket mode), posting to ${channel}`);
}
