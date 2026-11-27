// Checks the skill against the Agent Skills spec (agentskills.io/specification).
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";

const DIR = new URL("../skills/", import.meta.url);

function frontmatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
  assert.ok(m, "SKILL.md must start with YAML frontmatter");
  const out = {};
  let parent = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const nested = /^ {2}([\w-]+):\s*(.*)$/.exec(line);
    if (nested && parent) {
      out[parent][nested[1]] = nested[2].replace(/^"(.*)"$/, "$1");
      continue;
    }
    const kv = /^([\w-]+):\s*(.*)$/.exec(line);
    assert.ok(kv, `unparseable frontmatter line: ${line}`);
    if (kv[2] === "") {
      parent = kv[1];
      out[parent] = {};
    } else {
      parent = null;
      out[kv[1]] = kv[2];
    }
  }
  return { fm: out, body: src.slice(m[0].length) };
}

for (const name of readdirSync(DIR)) {
  test(`skill ${name} can be loaded by any Agent Skills host`, () => {
    // Given
    const src = readFileSync(new URL(`${name}/SKILL.md`, DIR), "utf8");
    // When
    const { fm, body } = frontmatter(src);
    // Then
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, "name: lowercase letters, digits, single hyphens");
    assert.ok(fm.name.length <= 64, "name: max 64 chars");
    assert.equal(fm.name, name, "name must match the directory");

    assert.ok(fm.description && fm.description.length <= 1024, "description: 1-1024 chars");
    assert.match(fm.description, /\bUse when\b/i, "description should say when to use it");
    if (fm.compatibility) assert.ok(fm.compatibility.length <= 500, "compatibility: max 500 chars");
    if (fm.metadata) for (const v of Object.values(fm.metadata)) assert.equal(typeof v, "string");

    assert.ok(src.split("\n").length < 500, "SKILL.md under 500 lines");
    // Every script SKILL.md mentions must exist (references stay one level deep).
    for (const [, rel] of body.matchAll(/\b((?:scripts|references)\/[\w.-]+)/g)) {
      assert.doesNotThrow(() => readFileSync(new URL(`${name}/${rel}`, DIR)), `${rel} referenced but missing`);
    }
  });
}
