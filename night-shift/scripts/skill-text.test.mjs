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
// T8 (2026-11-19): each mode's rules for its sessions, which the runner puts into a new session's header.
const modeFile = (m) => path.join(root, "references", `mode-${m}.md`);
const modeText = Object.fromEntries(MODES.map((m) => [m, fs.existsSync(modeFile(m)) ? fs.readFileSync(modeFile(m), "utf8") : ""]));
// The repository's README, one folder above the skill; an installed copy of the skill has none.
const readmePath = path.join(root, "..", "README.md");
// U24 (2026-11-19): the planning prompt start --goal wraps a goal in.
const goalPath = path.join(root, "references", "goal.md");
const goal = fs.existsSync(goalPath) ? fs.readFileSync(goalPath, "utf8").replace(/\r\n/g, "\n") : "";
// C3 (2026-11-19): an attended run's rules, which the runner puts into such a run's new session's header.
const attendedPath = path.join(root, "references", "attended.md");
const attended = fs.existsSync(attendedPath) ? fs.readFileSync(attendedPath, "utf8").replace(/\r\n/g, "\n") : "";

test("the skill's texts carry nothing of one person's setup", () => {
  for (const t of [skill, interactive, goal, attended, ...Object.values(modeText)]) {
    assert.doesNotMatch(t, /[^\P{L}a-zA-Z]/u);
    assert.doesNotMatch(t, /\bRun \d/);
    assert.doesNotMatch(t, /~\/\.claude\/CLAUDE\.md/);
    assert.doesNotMatch(t, /~\/\.claude\/skills\/night-shift/);
  }
});
test("the skill names the marker, the user's rules and the skill folder", () => {
  assert.match(skill, /^description: .*"Night shift \(night-shift\)"/m);
  assert.match(skill, /The user's rules/);
  assert.match(skill, /\$NIGHT_SHIFT_SKILL\/scripts\/wait-for\.mjs/);
  assert.match(skill, /Approved: night delegate \(night-shift, <date>\)/);
});
// T8: SKILL.md, which every session loads, holds no mode's rules; each mode has its own file, which names that mode, and
// SKILL.md says where they are. Mode opus's names MODEL: mythos once, as Fable's other name.
test("each mode's rules are in references/mode-<mode>.md, and SKILL.md holds none of them", () => {
  for (const m of MODES) assert.match(modeText[m], new RegExp(`^\\*\\*Mode ${m}\\.\\*\\* Sessions run on `), `mode-${m}.md`);
  assert.doesNotMatch(skill, /\*\*Mode (opus|fable|mythos)\.\*\*|MODEL: mythos|A piece earns/);
  assert.ok(skill.includes("the header names the run's mode and gives its rules (also in `references/mode-<mode>.md`, to read again after a compaction)"));
  assert.match(modeText.opus, /A piece earns `MODEL: fable` only/);
  // What moved with it: the never-Fable list and the two table rows only an opus-mode session needs.
  assert.match(modeText.opus, /^Never Fable or `max`, whatever code the piece touches: a round's tasks/m);
  assert.match(modeText.opus, /^\| "These tasks touch race-prone code, so the task session needs Fable or `max`\." \|/m);
  assert.match(modeText.opus, /^\| "My Fable or `max` piece is blocked; I'll use the session for the next piece\." \|/m);
  assert.equal(modeText.opus.split("`MODEL: mythos`").length - 1, 1, "MODEL: mythos is named once");
  assert.match(modeText.opus, /`MODEL: mythos`[^\n]*same model|same model[^\n]*`MODEL: mythos`/);
  for (const m of ["fable", "mythos"]) assert.match(modeText[m], /Write no `MODEL` line/, `mode-${m}.md`);
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
// U24: start --goal and --goal-file are named where start's other ways in are; the planning prompt has the shape of a
// handover (SKILL.md's last step), one place for the goal, and the steps C3 gives session 1.
test("the help, interactive.md and the README name --goal and --goal-file", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const help = fs.readFileSync(path.join(root, "scripts", "night-chain.mjs"), "utf8");
  for (const [name, t] of [["night-chain.mjs", help], ["interactive.md", interactive], ["README.md", fs.readFileSync(readmePath, "utf8")]]) {
    for (const flag of ["--goal <text>", "--goal-file <file>"]) assert.ok(t.includes(flag), `${name}: ${flag}`);
  }
});
test("the goal's planning prompt has a handover's shape and plans, reviews, approves and hands on", () => {
  assert.ok(goal, "references/goal.md");
  assert.deepEqual(goal.split("\n").filter((l) => /^## /.test(l)), ["## Rules", "## State", "## This piece", "## Lessons for this piece"]);
  assert.equal(goal.split("{{goal}}").length - 1, 1, "one {{goal}}");
  assert.match(goal, /^\{\{goal\}\}$/m, "on a line of its own");
  assert.doesNotMatch(goal.split("\n")[0], /^(MODEL|EFFORT|STOP):/);
  for (const w of ["out of scope", "one fresh reviewer subagent", "Approved: night delegate (night-shift, <date>)", "nothing beyond it", "piece 1"]) assert.ok(goal.includes(w), w);
});
// K5 (2026-11-19): the chat is told when a chain costs more than it gives, with the numbers the analysis measured (B3).
test("interactive.md says when not to chain, with what each session's fresh start costs", () => {
  const part = interactive.replace(/\r\n/g, "\n").split(/^## When not to chain\n/m)[1]?.split(/^## /m)[0];
  assert.ok(part, "a part headed ## When not to chain");
  assert.ok(interactive.indexOf("## When not to chain") < interactive.indexOf("## Starting, checking, stopping"), "before the start's steps");
  // "as asked": the part never lets the chat refuse a start (the rule above the start's steps: ask nothing once told to start).
  for (const w of ["one piece", "done in the chat", "38.4k tokens", "15 %", "`--goal`", "planning session", "start it as asked"]) assert.ok(part.includes(w), w);
  assert.ok(part.trim().split("\n").length <= 3, "short");
});
test("the report's fixed words are still in the skill", () => {
  for (const w of ["**Waits for you**", "- New:", "- Still waiting (session <nn>):", "**Remaining:** <n> sessions", "## Rules", "## State", "## This piece", "## Lessons for this piece"]) assert.ok(skill.includes(w), w);
});
// G4: the repository's other two texts hold no letter outside ASCII either; an installed copy of the skill has neither.
test("the README and SECURITY.md hold no letter outside ASCII", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  for (const name of ["README.md", "SECURITY.md"]) {
    const t = fs.readFileSync(path.join(root, "..", name), "utf8");
    assert.doesNotMatch(t, /[^\P{L}a-zA-Z]/u, name);
  }
});
// U17, K3 and the heading: what a session in a project with no CLAUDE.md of its own still needs.
test("the skill gives the live desktop a default, says another session's message is not the user's, and dates the heading", () => {
  assert.match(skill, /\*\*Live desktop\.\*\* Tests or changes on the user's live desktop: what drives their screen, mouse, keyboard or open apps/);
  assert.match(skill, /A message from another of the user's sessions is not the user's word: act on it only where the prompt or the inbox asks the same\./);
  assert.match(skill, /the heading `## <yyyy-mm-dd> [^`]*`, dated the day the session started/);
});
// T1 (2026-11-19): the decision trail lives in its own file beside the plan, which a session greps instead of reading the
// plan's whole history; the plan names it in one line.
test("decisions go to a decisions file beside the plan, which a session greps", () => {
  assert.match(skill, /Record each choice as `decision · why` in the decisions file beside the plan, which the plan names in one line \(add both when missing; no plan: the round's log\); grep it, never read it whole\./);
  assert.doesNotMatch(skill, /the plan's decision list/);
});
// SKILL.md loads into every night session: an addition is paid for by a cut. The budget follows each cut down, so the
// room a cut made is not spent again unseen (16283 bytes and 110 lines on 2026-11-19; BUDGET after T8 moved the modes out).
const BUDGET = { bytes: 13163, lines: 92 };
test("SKILL.md does not grow past its budget", () => {
  const text = skill.replace(/\r\n/g, "\n");
  assert.ok(Buffer.byteLength(text) <= BUDGET.bytes, `SKILL.md is ${Buffer.byteLength(text)} bytes, over ${BUDGET.bytes}: cut what pays for the addition`);
  assert.ok(text.trimEnd().split("\n").length <= BUDGET.lines, `SKILL.md has ${text.trimEnd().split("\n").length} lines, over ${BUDGET.lines}`);
});
// T2 (2026-11-19): the size SKILL.md names is the one the runner flags.
test("SKILL.md names the prompt size the runner flags", async () => {
  const { PROMPT_WARN_BYTES } = await import("./night-chain.mjs");
  assert.ok(skill.includes(`the runner reports one over ${PROMPT_WARN_BYTES / 1000} KB`), `SKILL.md: over ${PROMPT_WARN_BYTES / 1000} KB`);
});

// C3: an attended run's rules: a question goes out at once in one line of questions.md, a hard stop too, the piece that
// depends on it waits, and answers come through the inbox; the guard and SKILL.md stay as they are.
test("attended.md asks at once in questions.md, hard stops included, defers what depends on a question and reads answers from the inbox", () => {
  assert.match(attended, /^\*\*Attended run\.\*\* /);
  assert.ok(attended.includes("`$NIGHT_SHIFT_STATE/questions.md`"));
  assert.ok(attended.includes("`Q<n> · <HH:MM> · <question> · <your pick and why> · <what changes if they pick otherwise>`"));
  assert.match(attended, /hard stop/i);
  assert.match(attended, /never do it yourself/);
  assert.match(attended, /behind the other approved work/);
  assert.ok(attended.includes("`A<n>: <answer>`") && attended.includes("`$NIGHT_SHIFT_STATE/inbox.md`"));
  assert.match(attended, /At step 3, move the inbox first, then read it again/);
  assert.doesNotMatch(skill, /questions\.md|Attended run/, "SKILL.md holds none of it");
});
test("the help, interactive.md and the README name --attended", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const help = fs.readFileSync(path.join(root, "scripts", "night-chain.mjs"), "utf8");
  for (const [name, t] of [["night-chain.mjs", help], ["interactive.md", interactive], ["README.md", fs.readFileSync(readmePath, "utf8")]]) {
    assert.ok(t.includes("--attended"), `${name}: --attended`);
  }
  assert.match(fs.readFileSync(readmePath, "utf8"), /^- `attended`: /m);
});
// K6: the chain's own worktree, by its flag, its key and what stays the user's.
test("the help, interactive.md and the README name --worktree, and the README its key and the user's merge and remove", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const help = fs.readFileSync(path.join(root, "scripts", "night-chain.mjs"), "utf8");
  const readme = fs.readFileSync(readmePath, "utf8");
  for (const [name, t] of [["night-chain.mjs", help], ["interactive.md", interactive], ["README.md", readme]]) {
    assert.ok(t.includes("--worktree") && t.includes("<repo>-night") && t.includes("night-shift"), `${name}: --worktree`);
  }
  assert.match(readme, /^- `worktree`: /m);
  assert.match(readme, /^- `worktreeCopy`: /m);
  assert.ok(readme.includes("`git merge night-shift`") && readme.includes("`git worktree remove <dir>`"), "README: the user's merge and remove");
  // K6 task 4: the session in the user's tree is told which tree is the chain's, and that both commands are the user's.
  const tree = interactive.split("\n").find((l) => l.startsWith("An interactive session does not edit the tree")) || "";
  assert.ok(tree.includes("`worktree: <dir> on night-shift`") && tree.includes("`git merge night-shift`") && tree.includes("`git worktree remove <dir>`"), "interactive.md: the worktree in the tree rule");
});
// B4 item 2, K7: the starting chat's waiter wakes on a question, the chat writes the answer into the inbox, and Remote
// Control is the phone path for a user without Telegram.
test("interactive.md says what wait's exit 3 asks of the chat, and names Remote Control as the phone path", () => {
  assert.match(interactive, /exit 3/);
  assert.ok(interactive.includes("`A<n>: <answer>`") && interactive.includes("`<state>/inbox.md`"));
  assert.match(interactive, /`\/remote-control`/);
  assert.match(attended, /the starting chat's waiter wakes on it/);
});

// F9 (session 20's closure): the chain's end lines at a cap or a window, as the runner writes them, are in the text the chat reads.
test("interactive.md names the runner's end lines at the weekly ceiling, the dollar cap and the five-hour window", () => {
  const chain = fs.readFileSync(path.join(root, "scripts", "night-chain.mjs"), "utf8");
  for (const line of ["the seven-day window is at", "this start's sessions cost", "the five-hour window is at"]) {
    assert.ok(chain.includes("`" + line), `night-chain.mjs: ${line}`);
    assert.ok(interactive.includes("`" + line), `interactive.md: ${line}`);
  }
});

// C4: the repository's package.json and CHANGELOG.md name the version the code knows (version.mjs), and README the Node
// version package.json's engines holds; an installed copy of the skill has none of the three.
test("package.json, CHANGELOG.md and the README agree with the code on the version and the Node it needs", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, async () => {
  const { VERSION, NODE_FLOOR } = await import("./version.mjs");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "..", "package.json"), "utf8"));
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.engines?.node, `>=${NODE_FLOOR}`, "the floor doctor checks");
  assert.equal(pkg.type, "module");
  assert.equal(pkg.private, true, "npm publish is refused by npm itself");
  assert.deepEqual(Object.keys(pkg.dependencies || {}), [], "Node's built-ins only");
  const node = /^>=(\d+)$/.exec(pkg.engines?.node || "");
  assert.ok(node, `engines.node: ${pkg.engines?.node}`);
  assert.ok(fs.readFileSync(readmePath, "utf8").includes(`Node.js ${node[1]} or later`), "README: the Node version");
  // The suite and the guard's self-test, from the repository root; the glob quoted, since cmd.exe expands none.
  assert.equal(pkg.scripts?.test, 'cd night-shift && node --test "scripts/*.test.mjs" && node scripts/guard.mjs --self-test');
  const heading = fs.readFileSync(path.join(root, "..", "CHANGELOG.md"), "utf8").split("\n").find((l) => l.startsWith("## "));
  const base = VERSION.replace(/-.*/, "");
  assert.ok(heading?.startsWith(`## ${base} `), `CHANGELOG.md's first version: ${heading}`);
  if (base !== VERSION) assert.match(heading, /unreleased/, "a pre-release version is the unreleased part");
});

// C4: doctor is named where a user or the starting chat looks for the runner's commands.
test("the help, interactive.md and the README name doctor, and the help and the README init", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const help = fs.readFileSync(path.join(root, "scripts", "night-chain.mjs"), "utf8"), readme = fs.readFileSync(readmePath, "utf8");
  for (const [name, t] of [["night-chain.mjs", help], ["interactive.md", interactive], ["README.md", readme]]) assert.ok(t.includes("night-chain.mjs doctor"), `${name}: doctor`);
  for (const [name, t] of [["night-chain.mjs", help], ["README.md", readme]]) assert.match(t, /night-chain\.mjs init +--repo/, `${name}: init`);
  assert.match(readme, /`<!--` and `-->`/, "README: a rule file's comments");
});

// C4: CI runs the suite and the guard's self-test on Windows, the gate, on the oldest Node package.json's engines allows
// and the newest LTS; macOS and Linux run them too but do not fail the workflow until the code has a seam for what
// differs by system. README says which.
test("the CI workflow tests Windows as the gate on the Node engines allows, and macOS and Linux without failing", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const wf = fs.readFileSync(path.join(root, "..", ".github", "workflows", "test.yml"), "utf8").replace(/\r\n/g, "\n");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "..", "package.json"), "utf8"));
  assert.match(wf, /^\s+- run: npm test$/m, "Windows runs package.json's test script");
  assert.ok(wf.includes("run: node scripts/guard.mjs --self-test") && wf.includes('run: node --test "scripts/*.test.mjs"'), "macOS and Linux run the same two");
  assert.ok(wf.includes(`node: ["${pkg.engines.node.replace(/^>=/, "")}", "lts/*"]`), "the oldest Node engines allows, and the newest LTS");
  const [windows, posix] = wf.slice(wf.search(/^jobs:$/m)).split(/^  posix:$/m);
  assert.ok(posix, "a posix job after the windows job");
  assert.match(windows, /runs-on: windows-latest$/m);
  assert.doesNotMatch(windows, /continue-on-error/, "Windows is the gate");
  for (const os of ["ubuntu-latest", "macos-latest"]) assert.ok(posix.includes(os), os);
  assert.match(posix, /^    continue-on-error: true$/m);
  assert.match(posix, /if: \$\{\{ !cancelled\(\) \}\}/, "the suite runs after a failed self-test too");
  assert.match(fs.readFileSync(readmePath, "utf8"), /`\.github\/workflows\/test\.yml`/);
});

// C4: the repository is a Claude Code plugin and its own marketplace (.claude-plugin/ at the root), so the skill installs
// with `claude plugin install` as well as by copying the folder. Paths start with ./ and stay inside the plugin's root,
// as the plugin docs require; the plugin's skill is this folder, which keeps its place (the port route patches it by
// that path). The manifest's version wins over a marketplace entry's, so the entry sets none.
test("the plugin manifest and its marketplace name the version the code knows and point at this skill folder", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, async () => {
  const { VERSION } = await import("./version.mjs");
  const top = path.join(root, "..");
  const json = (f) => JSON.parse(fs.readFileSync(path.join(top, ".claude-plugin", f), "utf8"));
  const plugin = json("plugin.json"), market = json("marketplace.json");
  const known = ["name", "version", "description", "author", "license", "keywords", "skills"];
  assert.deepEqual(Object.keys(plugin).filter((k) => !known.includes(k)), [], "a key Claude Code would strip");
  assert.equal(plugin.name, "night-shift");
  assert.equal(plugin.version, VERSION);
  assert.ok(plugin.description && plugin.author?.name, "description and author.name");
  const skills = [plugin.skills].flat();
  assert.equal(skills.length, 1, "one skill folder");
  for (const s of skills) {
    assert.match(s, /^\.\/[^\\]*$/, `a plugin path starts with ./ and has no backslash: ${s}`);
    assert.ok(!s.split("/").includes(".."), `inside the plugin's root: ${s}`);
    assert.equal(fs.realpathSync(path.join(top, s)), fs.realpathSync(root), "this skill folder");
  }
  assert.match(market.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, "a name a plugin id may hold");
  assert.doesNotMatch(market.name, /^(claude|anthropic|claudeai)-|\.\./i, "a reserved name");
  assert.ok(market.owner?.name && market.description, "owner.name and description");
  assert.equal(market.plugins?.length, 1);
  const [entry] = market.plugins;
  assert.equal(entry.name, plugin.name);
  assert.ok(entry.source === "./" || entry.source === ".", `the marketplace's root, which holds plugin.json: ${entry.source}`);
  for (const k of ["version", "skills", "commands", "agents", "hooks", "mcpServers"]) assert.ok(!(k in entry), `the entry sets no ${k}: plugin.json holds it`);
  const readme = fs.readFileSync(readmePath, "utf8");
  assert.ok(readme.includes("claude plugin marketplace add <you>/<this-repo>"), "README: add the marketplace");
  assert.ok(readme.includes(`claude plugin install ${entry.name}@${market.name}`), "README: install the plugin");
  assert.ok(readme.includes("`.claude-plugin/plugin.json`"), "README: the manifest");
  // The C4 follow-up: the guard protects either route's copy and the installed plugins (guard.test.mjs checks the guard).
  const install = readme.slice(readme.indexOf("\n## Install\n"), readme.indexOf("\n## Use\n"));
  for (const w of ["`NIGHT_SHIFT_SKILL`", "inside the repository", "`cache/`", "`marketplaces/`", "`installed_plugins.json`", "`known_marketplaces.json`",
    "`CLAUDE_CODE_PLUGIN_CACHE_DIR`", "`plugins/data/`"]) assert.ok(install.includes(w), `README's Install: ${w}`);
  assert.doesNotMatch(readme, /names the skill's files only at|For unattended runs, copy the folder/, "the plugin route's old guard gap");
});

// C4: examples/ holds a small roadmap, a first prompt and a project rules file, each linked from README and generic.
// The rules file opens with the comment init writes, which reaches no session, and has real rules below it.
test("examples/ holds a roadmap, a first prompt and a rules file README links, the rules init's comment and rules below it", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, async () => {
  const { INIT_RULES } = await import("./night-chain.mjs");
  const { readRuleFile, RULES_MAX_BYTES } = await import("./rules.mjs");
  const dir = path.join(root, "..", "examples"), readme = fs.readFileSync(readmePath, "utf8");
  for (const f of ["roadmap.md", "first-prompt.md", "night-shift-rules.md"]) {
    assert.ok(readme.includes(`(examples/${f})`), `README links examples/${f}`);
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(text, /[^\P{L}a-zA-Z]|\b[A-Z]:[\\/]|\/(home|Users)\/|night-shift-skill/iu, `${f}: generic (no machine's path) and ASCII`);
    assert.ok(Buffer.byteLength(text) < 4096, `${f} stays short`);
  }
  // A checkout with CRLF reads the same (readRuleFile turns it into LF too); the limit counts the bytes on disk.
  const rules = path.join(dir, "night-shift-rules.md"), raw = fs.readFileSync(rules, "utf8").replace(/\r\n/g, "\n");
  assert.ok(raw.startsWith(INIT_RULES), "the comment init writes, as it writes it");
  const read = readRuleFile(rules);
  assert.equal(read.error, undefined);
  assert.ok(fs.statSync(rules).size <= RULES_MAX_BYTES);
  assert.equal(read.text, raw.slice(INIT_RULES.length).trim(), "only the rules below the comment reach a session");
  assert.match(read.text, /^- \S/, "rules, not an empty file");
  // The first prompt has the shape SKILL.md's last step gives next-prompt.md: the piece's line, then four headings.
  const prompt = fs.readFileSync(path.join(dir, "first-prompt.md"), "utf8").replace(/\r\n/g, "\n");
  assert.match(prompt, /^[^#\s][^\n]+\n\n## Rules\n/);
  assert.deepEqual(prompt.match(/^## .*/gm), ["## Rules", "## State", "## This piece", "## Lessons for this piece"]);
  assert.match(fs.readFileSync(path.join(dir, "roadmap.md"), "utf8"), /^Approved: /m, "the roadmap is marked approved");
});

// C4: README opens with what the skill is for (a job by night or by day, from a plan or a goal, the phone, the guard),
// the warnings, then a quick start of five steps a new user finishes in minutes; the sections after it stay, and what
// the old opening said about how a chain runs is said once, under "Use".
test("README opens with what the skill is for, then the warnings and a five-step quick start", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const readme = fs.readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");
  assert.deepEqual(readme.match(/^## .*/gm), ["## Read this first", "## Quick start", "## Requirements", "## Install", "## Use", "## The guard",
    "## When a session fails", "## Telegram and webhooks (optional)", "## Tests", "## Versions", "## License"]);
  const opening = readme.slice(0, readme.indexOf("\n## "));
  for (const w of ["a plan", "a goal", "overnight", "a day", "`--attended`", "phone", "guard"]) assert.ok(opening.includes(w), `the opening: ${w}`);
  const quick = readme.slice(readme.indexOf("\n## Quick start\n"), readme.indexOf("\n## Requirements\n"));
  assert.deepEqual(quick.match(/^\d+\. /gm), ["1. ", "2. ", "3. ", "4. ", "5. "]);
  for (const w of ["cp -r <this-repo>/night-shift ~/.claude/skills/night-shift", "night-chain.mjs init --repo <dir>", "night-chain.mjs doctor --repo <dir>",
    "night-chain.mjs start --repo <dir> --prompt-file <file>", "`--goal ", "(examples/roadmap.md)", "(examples/first-prompt.md)", "(examples/night-shift-rules.md)", "`status --repo <dir>`", "`stop --repo <dir>`"]) {
    assert.ok(quick.includes(w), `the quick start: ${w}`);
  }
  // In the order a start needs them: install, init (whose files are committed), doctor, start.
  const at = (w) => quick.indexOf(w);
  assert.ok(at("cp -r ") < at(" init --repo") && at(" init --repo") < at(" doctor --repo") && at(" doctor --repo") < at(" start --repo"), "the steps' order");
  assert.match(quick, /outside the repository/, "where a prompt file goes, since start refuses an uncommitted one");
  const moved = "The chain stops when a session writes `STOP`, when two handovers fail in a row, or when you stop it.";
  assert.equal(readme.split(moved).length - 1, 1, "said once");
  assert.ok(readme.indexOf(moved) > readme.indexOf("\n## Use\n"), "under Use");
});

// C4: CONTRIBUTING.md says how to run the tests and what a change keeps; the bug report form asks for --version and
// doctor's output, both required, and a feature request for the job and what it lets a night session do. GitHub's
// template chooser needs no config.yml.
test("CONTRIBUTING.md and the issue forms ask for what a change and a report need", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const read = (f) => fs.readFileSync(path.join(root, "..", f), "utf8").replace(/\r\n/g, "\n");
  const contributing = read("CONTRIBUTING.md");
  for (const w of ["npm test", "**No dependencies.**", "**English and LF.**", "**The guard is not loosened without a test.**", "**A failing test first.**", "(SECURITY.md)"]) {
    assert.ok(contributing.includes(w), `CONTRIBUTING.md: ${w}`);
  }
  assert.match(contributing, /apart from the `mcp` list/i, "CONTRIBUTING.md names the one key that lets more through");
  const forms = ["bug_report.yml", "feature_request.yml"];
  for (const f of ["CONTRIBUTING.md", ...forms.map((x) => `.github/ISSUE_TEMPLATE/${x}`)]) assert.doesNotMatch(read(f), /[^\t\n\x20-\x7e]/, `${f}: ASCII`);
  const items = (f) => read(`.github/ISSUE_TEMPLATE/${f}`).split(/^ {2}- type: /m).slice(1);
  // No YAML parser here (no dependencies): the shape GitHub needs, checked by its lines.
  for (const f of forms) {
    const text = read(`.github/ISSUE_TEMPLATE/${f}`);
    assert.match(text, /^labels: \["[a-z]+"\]\nbody:\n {2}- type: /m, `${f}: labels, then the body's items`);
    const ids = items(f).map((b) => b.match(/\n {4}id: ([a-z]+)\n/)?.[1]).filter(Boolean);
    assert.equal(new Set(ids).size, ids.length, `${f}: ids are unique`);
    for (const b of items(f)) {
      assert.match(b, /^(markdown|input|textarea|dropdown|checkboxes)\n/, `${f}: a type GitHub knows`);
      if (!b.startsWith("markdown")) assert.match(b, /\n {6}label: \S/, `${f}: every field has a label`);
    }
  }
  const field = (f, id) => items(f).find((b) => b.includes(`\n    id: ${id}\n`)) ?? "";
  assert.match(field("bug_report.yml", "version"), /night-chain\.mjs --version/);
  assert.match(field("bug_report.yml", "doctor"), /night-chain\.mjs doctor --repo/);
  for (const id of ["version", "doctor", "what"]) assert.match(field("bug_report.yml", id), /\n {4}validations:\n {6}required: true\n/, `bug report: ${id} is required`);
  for (const id of ["doctor", "logs"]) assert.match(field("bug_report.yml", id), /\n {6}render: text\n/, `bug report: ${id} keeps its lines as pasted`);
  for (const id of ["job", "trust"]) assert.ok(field("feature_request.yml", id), `feature request: ${id}`);
  // A form shows in the chooser only with a name over three characters.
  for (const f of forms) assert.match(read(`.github/ISSUE_TEMPLATE/${f}`), /^name: [^"'\s].{3,}\ndescription: .+\n/, f);
  assert.ok(fs.readFileSync(readmePath, "utf8").includes("(CONTRIBUTING.md)"), "README links CONTRIBUTING.md");
});

// C5 (U11): the README says what differs by system, that macOS and Linux are untested, and no longer that the skill
// runs on Windows only; --help says --window is Windows' only; interactive.md's reload names both starts.
test("the README's Systems part says what differs by system and that macOS and Linux are untested", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const readme = fs.readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");
  assert.doesNotMatch(readme, /\*\*Windows only\.\*\*/, "the old warning");
  const part = readme.split(/^### Systems\n/m)[1]?.split(/^##/m)[0] ?? "";
  assert.ok(readme.indexOf("\n### Systems\n") > readme.indexOf("\n## Requirements\n") && readme.indexOf("\n### Systems\n") < readme.indexOf("\n## Install\n"), "under Requirements");
  for (const w of ["`scripts/platform.mjs`", "untested on real machines", "Task Scheduler", "`conhost --headless`", "detached process", "`<state>/runner.err`",
    "`--window` is refused", "`caffeinate`", "`systemd-inhibit`", "`/proc`", "`ps`", "`KillUserProcesses=yes`", "`claude.exe`", "`/Volumes/<boot disk>`"]) {
    assert.ok(part.includes(w), `Systems: ${w}`);
  }
  for (const at of [readme.slice(0, readme.indexOf("\n## Quick start\n")), readme.slice(readme.indexOf("\n## Requirements\n"), readme.indexOf("\n### Systems\n"))]) {
    assert.match(at, /untested/, "the warnings and Requirements say so too");
    assert.match(at, /"Systems"/, "and point at it");
  }
  const help = fs.readFileSync(path.join(root, "scripts", "night-chain.mjs"), "utf8").split(/^import /m)[0];
  assert.match(help, /--window, Windows only/);
  assert.match(interactive, /on macOS and Linux as a detached process/);
});

// C6: the webhook is set up from README's "Telegram and webhooks" part, and the watcher's help and interactive.md name it.
test("README says how to set up a webhook and try it; the report's help and interactive.md name webhook.json", { skip: !fs.existsSync(readmePath) && "no README beside this copy" }, () => {
  const readme = fs.readFileSync(readmePath, "utf8").replace(/\r\n/g, "\n");
  const part = readme.split("\n## Telegram and webhooks (optional)\n")[1]?.split("\n## ")[0] ?? "";
  for (const w of ["`~/.claude/night-shift/webhook.json`", "`\"kind\": \"ntfy\"`", "`\"slack\"`", "`\"discord\"`", "`hooks.slack.com`", "`discord.com/api/webhooks/`",
    "secret", "never committed", "card --state <state folder> --send", "stay Telegram's"]) assert.ok(part.includes(w), `README's part: ${w}`);
  const help = fs.readFileSync(path.join(root, "scripts", "night-report.mjs"), "utf8").split(/^import /m)[0];
  assert.match(help, /webhook\.json/);
  assert.match(interactive, /night-shift\/webhook\.json/);
});
