// Firebreak bot: alert in -> skill investigates (read-only) -> human approves in
// Slack (or on the local board) -> skill kills, verifies, records -> result in thread.
import { startSlack } from "./slack.mjs";
import { startWeb } from "./web.mjs";

const env = process.env;
startWeb({ port: Number(env.PORT ?? 4100), host: env.HOST ?? "127.0.0.1" });

if (env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN && env.SLACK_CHANNEL) {
  await startSlack({
    botToken: env.SLACK_BOT_TOKEN,
    appToken: env.SLACK_APP_TOKEN,
    channel: env.SLACK_CHANNEL,
    approvers: (env.SLACK_APPROVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  });
} else {
  console.warn("Slack not configured (SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_CHANNEL): approvals on the local board only");
}
console.warn(`agent: model ${env.FIREBREAK_MODEL ?? "sonnet"}${env.ANTHROPIC_API_KEY ? ", --bare (API key)" : ", Claude Code login"}`);
