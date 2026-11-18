// The skill's two texts carry no one person's setup. node --test skill-text.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
const interactive = fs.readFileSync(path.join(root, "references", "interactive.md"), "utf8");

test("the skill's texts carry nothing of one person's setup", () => {
  for (const t of [skill, interactive]) {
    assert.doesNotMatch(t, /[^\P{L}a-zA-Z]/u);
    assert.doesNotMatch(t, /\bRun \d/);
    assert.doesNotMatch(t, /~\/\.claude\/CLAUDE\.md/);
    assert.doesNotMatch(t, /~\/\.claude\/skills\/night-shift/);
  }
});
test("the skill names the marker, both modes, the user's rules and the skill folder", () => {
  assert.match(skill, /^description: .*"Night shift \(night-shift\)"/m);
  assert.match(skill, /\*\*Mode opus\.\*\*/); assert.match(skill, /\*\*Mode fable\.\*\*/);
  assert.match(skill, /The user's rules/);
  assert.match(skill, /\$NIGHT_SHIFT_SKILL\/scripts\/wait-for\.mjs/);
  assert.match(skill, /Approved: night delegate \(night-shift, <date>\)/);
});
test("the report's fixed words are still in the skill", () => {
  for (const w of ["**Waits for you**", "- New:", "- Still waiting (session <nn>):", "**Remaining:** <n> sessions", "## Rules", "## State", "## This piece", "## Lessons for this piece"]) assert.ok(skill.includes(w), w);
});
