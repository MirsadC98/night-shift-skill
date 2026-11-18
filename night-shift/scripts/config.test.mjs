// The one reader of .claude/night-shift.json. node --test config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readProjectConfig, readGlobalConfig, mergedConfig, globalConfigFile, CONFIG_KEYS, stateDirProblem, tempRoot, norm, isMain, isLangCode } from "./config.mjs";

const LANG_ERR = "must be a language code in lowercase, such as en or pt-br (a table at ~/.claude/night-shift/lang/<code>.mjs)";

const repoWith = (text) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "night-config-test-"));
  if (text !== undefined) {
    fs.mkdirSync(path.join(repo, ".claude"));
    fs.writeFileSync(path.join(repo, ".claude", "night-shift.json"), typeof text === "string" ? text : JSON.stringify(text));
  }
  return repo;
};

// A throwaway home: the global file is never read from the real one.
const emptyHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "night-config-home-"));
const tmpHome = (cfg) => {
  const home = emptyHome();
  fs.mkdirSync(path.dirname(globalConfigFile(home)), { recursive: true });
  fs.writeFileSync(globalConfigFile(home), JSON.stringify(cfg));
  return home;
};

test("a missing file is an empty config; a valid one is returned as written", () => {
  assert.deepEqual(readProjectConfig(repoWith()), { config: {}, errors: [] });
  const cfg = {
    stateDir: "C:/temp/x-night-{date}", report: "docs/N.md", lessons: "docs/NOTES.md", model: "opus", effort: "xhigh",
    fableCeiling: 0.6, fableSessions: 2, maxWaitHours: 6, mcp: ["github"],
    deny: [{ pattern: "deploy\\.ps1", reason: "no deploys", flags: "i" }, { pattern: "x" }],
    _note: "a comment", $schema: "ignored",
  };
  const { config, errors } = readProjectConfig(repoWith(cfg));
  assert.deepEqual(errors, []);
  const { _note, $schema, ...valid } = cfg;
  assert.deepEqual(config, valid);
  assert.equal(readProjectConfig(repoWith({ mcp: "none" })).config.mcp, "none");
  assert.equal(readProjectConfig(repoWith({ mcp: "inherit" })).config.mcp, "inherit");
});

test("broken JSON, a non-object and a bad regular expression are errors, not exceptions", () => {
  assert.match(readProjectConfig(repoWith('{ "report": "docs/N.md", }')).errors[0], /not valid JSON/);
  assert.match(readProjectConfig(repoWith("[1]")).errors[0], /must be a JSON object/);
  const bad = readProjectConfig(repoWith({ report: "r", deny: [{ pattern: "(", reason: "x" }] }));
  assert.match(bad.errors[0], /deny\[0\]\.pattern does not compile/);
  assert.equal(bad.errors.length, 1);
  assert.deepEqual(bad.config, { report: "r" });
});

test("a misspelt key and a wrong type are named", () => {
  const { config, errors } = readProjectConfig(repoWith({ modle: "fable", report: 5, mcp: "all", model: "opus" }));
  assert.deepEqual(errors, ['unknown key "modle"', '"report" must be a string', '"mcp" must be "none", "inherit" or a list of server names']);
  assert.deepEqual(config, { model: "opus" });
  const n = (cfg) => readProjectConfig(repoWith(cfg)).errors.length;
  assert.equal(n({ effort: "ultra" }), 1);
  assert.equal(n({ fableCeiling: 0 }), 1);
  assert.equal(n({ fableCeiling: 101 }), 1);
  assert.equal(n({ fableSessions: 1.5 }), 1);
  assert.equal(n({ fableSessions: -1 }), 1);
  assert.equal(n({ maxWaitHours: 0 }), 1);
  assert.equal(n({ deny: { pattern: "x" } }), 1);
  assert.equal(n({ deny: [{ reason: "no pattern" }] }), 1);
  assert.equal(n({ fableCeiling: 100, fableSessions: 0, maxWaitHours: 0.5 }), 0);
});

test("a state folder may not be a drive, the home folder, the repository, temp itself, .git or ~/.claude", () => {
  const where = { home: "C:\\Users\\u", repo: "C:/Users/u/Desktop/My Game", temp: "C:/Users/u/AppData/Local/Temp" };
  for (const bad of ["C:/", "C:\\temp", "D:/x", "C:/Users/u", "C:/Users", "C:/Users/u/Desktop/My Game", "C:/Users/u/Desktop",
    "C:/Users/u/Desktop/My Game/.git/night", "C:/Users/u/.claude/night", "C:/Users/u/AppData/Local/Temp"])
    assert.ok(stateDirProblem(bad, where), bad);
  for (const good of ["C:/temp/my-game-night-20261116", "C:/Users/u/AppData/Local/Temp/night-shift-My Game-20261116", "C:/Users/u/Desktop/My Game/.night"])
    assert.equal(stateDirProblem(good, where), null, good);
});

test("a state folder may not sit in AppData outside temp, in Windows, Program Files or ProgramData", () => {
  const where = { home: "C:\\Users\\u", repo: "C:/work/repo", temp: "C:/Users/u/AppData/Local/Temp" };
  for (const bad of ["C:/Users/u/AppData/Roaming/night", "C:/Users/u/AppData/Local/night", "C:/Users/u/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/n",
    "C:/Windows/Temp/n", "C:/Windows/n", "C:/Program Files/x/n", "C:/Program Files (x86)/x/n", "C:/ProgramData/n"])
    assert.ok(stateDirProblem(bad, where), bad);
  for (const good of ["C:/Users/u/AppData/Local/Temp/night-shift-My Game-20261116", "C:/temp/my-game-night", "C:/Users/u/Desktop/night-shift/n"])
    assert.equal(stateDirProblem(good, where), null, good);
  // The default (what night-chain builds from the temp folder) stays valid.
  assert.equal(stateDirProblem(path.join(tempRoot(), "night-shift-My Game-20261116"), { home: os.homedir(), repo: "C:/work/repo" }), null);
});

test("tempRoot is the temp folder in long form: a short-form TEMP resolves, one that cannot be resolved is kept", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "night-temproot-"));
  const long = path.join(base, "LongTempFolderName"), link = path.join(base, "LONGUS~1");
  fs.mkdirSync(long);
  fs.symlinkSync(long, link, "junction");
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  try {
    process.env.TEMP = process.env.TMP = link;
    assert.equal(tempRoot().toLowerCase(), fs.realpathSync.native(long).toLowerCase());
    assert.equal(norm("/tmp/x").toLowerCase(), `${fs.realpathSync.native(long).replace(/\\/g, "/")}/x`.toLowerCase());
    process.env.TEMP = process.env.TMP = path.join(base, "missing~1");
    assert.equal(tempRoot(), path.join(base, "missing~1"));
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the global file holds only run-wide keys", () => {
  const home = tmpHome({ lang: "xx", stateDir: "C:/x/y", nope: 1 });
  const { config, errors } = readGlobalConfig(home);
  assert.deepEqual(config, { lang: "xx" });
  assert.deepEqual(errors, ['"stateDir" belongs in a project\x27s .claude/night-shift.json', 'unknown key "nope"']);
});
test("a missing global file is no error", () => assert.deepEqual(readGlobalConfig(emptyHome()), { config: {}, errors: [] }));
test("the project file wins over the global one, key by key", () => {
  const home = tmpHome({ lang: "xx", effort: "high" }), repo = repoWith({ effort: "max" });
  assert.deepEqual(mergedConfig(repo, home).config, { lang: "xx", effort: "max" });
});
test("mergedConfig names the file each error is in", () => {
  const home = tmpHome({ lang: "TR" }), repo = repoWith({ mode: "sonnet" });
  assert.deepEqual(mergedConfig(repo, home).errors, [
    `${globalConfigFile(home)}: "lang" ${LANG_ERR}`,
    `${path.join(repo, ".claude", "night-shift.json")}: "mode" must be one of opus, fable, mythos`]);
});
test("mode takes mythos next to opus and fable", () => {
  for (const v of ["opus", "fable", "mythos"]) assert.equal(CONFIG_KEYS.mode(v), null);
  assert.equal(CONFIG_KEYS.mode("claude-mythos-5-2"), "must be one of opus, fable, mythos");
  assert.deepEqual(readGlobalConfig(tmpHome({ mode: "mythos" })), { config: { mode: "mythos" }, errors: [] });
});
test("mergedConfig keeps which file each value came from, the project winning", () => {
  const home = tmpHome({ mode: "opus", lang: "xx" }), repo = repoWith({ model: "fable", lang: "en" });
  assert.deepEqual(mergedConfig(repo, home).from, {
    mode: globalConfigFile(home), lang: path.join(repo, ".claude", "night-shift.json"), model: path.join(repo, ".claude", "night-shift.json") });
});
// Only the code's shape: whether its table exists is start's to check (this module also runs inside the guard).
test("lang takes a language code of the right shape, with or without a table", () => {
  for (const v of ["XX", "xx-XX", "Deutsch", "x", "", "../xx", "xx/yy", "xx.mjs", 5, null]) assert.equal(CONFIG_KEYS.lang(v), LANG_ERR, String(v));
  for (const v of ["en", "xx", "pt-br", "zh-hant", "fil"]) assert.equal(CONFIG_KEYS.lang(v), null, v);
  assert.equal(isLangCode("xx"), true);
  assert.equal(isLangCode("XX"), false);
});

// ---------------------------------------------------------------- a linked ~/.claude (2026-11-18)
// Node gives import.meta.url the real path and keeps process.argv[1] as typed, so a script started
// through a link (~/.claude as a junction) took itself for imported and did nothing.
const linkedDir = (prefix) => {
  const base = fs.mkdtempSync(path.join(tempRoot(), prefix));
  const real = path.join(base, "real"), link = path.join(base, "link");
  fs.mkdirSync(real);
  fs.symlinkSync(real, link, "junction");
  return { base, real, link };
};

test("isMain compares real paths, so a script started through a link knows itself", () => {
  const { base, real, link } = linkedDir("night-main-");
  try {
    for (const f of ["a.mjs", "b.mjs"]) fs.writeFileSync(path.join(real, f), "");
    // Node before 22.18 has no import.meta.main: the paths decide.
    const meta = { url: pathToFileURL(path.join(real, "a.mjs")).href };
    assert.equal(isMain(meta, path.join(real, "a.mjs")), true);
    assert.equal(isMain(meta, path.join(link, "a.mjs")), true);
    assert.equal(isMain(meta, path.join(link, "b.mjs")), false);
    for (const none of ["", null]) assert.equal(isMain(meta, none), false);
    // A path that cannot be resolved is compared as text; where that leaves a doubt, the caller's
    // `unknown` answers (the guard's is true: a hook that takes itself for imported allows every call).
    const gone = { url: pathToFileURL(path.join(base, "gone.mjs")).href };
    assert.equal(isMain(gone, path.join(base, "gone.mjs")), true);
    assert.equal(isMain(gone, path.join(link, "gone.mjs")), false);
    assert.equal(isMain(gone, path.join(link, "gone.mjs"), { unknown: true }), true);
    assert.equal(isMain(meta, path.join(link, "b.mjs"), { unknown: true }), false);
    // Where Node knows, its answer holds.
    assert.equal(isMain({ ...meta, main: false }, path.join(link, "a.mjs")), false);
    assert.equal(isMain({ ...meta, main: true }, path.join(base, "other.mjs")), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the runner, the report and the guard work when started through a linked folder", () => {
  const { base, link } = linkedDir("night-linked-scripts-");
  try {
    // The link stands for ~/.claude/skills/night-shift/scripts reached through a linked ~/.claude.
    fs.rmSync(link);
    fs.symlinkSync(path.dirname(fileURLToPath(import.meta.url)), link, "junction");
    const run = (script, args = [], input = "") => spawnSync(process.execPath, [path.join(link, script), ...args], { input, encoding: "utf8", cwd: base });
    assert.match(run("night-chain.mjs").stdout, /night-chain\.mjs start/);
    assert.match(run("night-report.mjs").stdout, /night-report\.mjs/);
    const r = run("guard.mjs", [], JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } }));
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout || "{}").hookSpecificOutput?.permissionDecision, "deny");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
