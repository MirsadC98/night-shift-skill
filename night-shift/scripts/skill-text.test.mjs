// The skill's two texts carry no one person's setup. node --test skill-text.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODES } from "./config.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = fs.readFileSync(path.join(root, "SKILL.md"), "utf8");
const interactive = fs.readFileSync(path.join(root, "references", "interactive.md"), "utf8");
// The repository's README, one folder above the skill; an installed copy of the skill has none.
const readmePath = path.join(root, "..", "README.md");

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
test("the skill names mode mythos, and MODEL: mythos once, as Fable's other name", () => {
  assert.match(skill, /\*\*Mode mythos\.\*\*/);
  assert.match(skill, /A piece earns `MODEL: fable` only/);
  assert.equal(skill.split("`MODEL: mythos`").length - 1, 1, "MODEL: mythos is named once");
  assert.match(skill, /`MODEL: mythos`[^\n]*same model|same model[^\n]*`MODEL: mythos`/);
  assert.ok(skill.includes('No Agent call passes `model: "fable"` in a night session'));
});
// The modes the runner takes (config.mjs) are the ones its help, the interactive text and the README name.
test("the help, interactive.md and the README name every mode", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const flag = `--mode ${MODES.join("|")}`;
  const help = fs.readFileSync(path.join(root, "scripts", "night-chain.mjs"), "utf8");
  for (const [name, t] of [["night-chain.mjs", help], ["interactive.md", interactive], ["README.md", fs.readFileSync(readmePath, "utf8")]]) assert.ok(t.includes(flag), `${name}: ${flag}`);
  const readme = fs.readFileSync(readmePath, "utf8");
  for (const m of MODES) assert.match(readme, new RegExp(`^- \\*\\*\`${m}\`\\*\\*`, "m"), `README "Modes": ${m}`);
});
test("the report's fixed words are still in the skill", () => {
  for (const w of ["**Waits for you**", "- New:", "- Still waiting (session <nn>):", "**Remaining:** <n> sessions", "## Rules", "## State", "## This piece", "## Lessons for this piece"]) assert.ok(skill.includes(w), w);
});
