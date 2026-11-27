// Flagsmith client for the demo shop.
// Uses remote evaluation with the environment key and caches environment flags
// for 3 seconds, so a kill switch takes effect within ~3s and steady traffic
// costs ~20 API calls a minute (fine for the free plan).
import { readFileSync } from "node:fs";
import { Flagsmith } from "flagsmith-nodejs";

function envKey() {
  if (process.env.FLAGSMITH_ENVIRONMENT_KEY) return process.env.FLAGSMITH_ENVIRONMENT_KEY;
  try {
    // flagsmith.json at the repo root, written by `flagsmith init`
    const cfg = JSON.parse(readFileSync(new URL("../../flagsmith.json", import.meta.url), "utf8"));
    if (cfg.environment) return cfg.environment;
  } catch {}
  throw new Error("Set FLAGSMITH_ENVIRONMENT_KEY or run `flagsmith init` at the repo root");
}

const client = new Flagsmith({ environmentKey: envKey() });
const TTL_MS = 3000;
let cached = null;
let fetchedAt = 0;

async function flags() {
  if (!cached || Date.now() - fetchedAt > TTL_MS) {
    cached = await client.getEnvironmentFlags();
    fetchedAt = Date.now();
  }
  return cached;
}

export async function isEnabled(feature) {
  return (await flags()).isFeatureEnabled(feature);
}

// Per-user evaluation, so a multivariate experiment splits users between variants.
const IDENTITY_TTL_MS = 10_000;
const byUser = new Map(); // userId -> { at, flags }

export async function valueFor(feature, userId) {
  let hit = byUser.get(userId);
  if (!hit || Date.now() - hit.at > IDENTITY_TTL_MS) {
    hit = { at: Date.now(), flags: await client.getIdentityFlags(userId) };
    byUser.set(userId, hit);
  }
  return hit.flags.isFeatureEnabled(feature) ? hit.flags.getFeatureValue(feature) : null;
}
