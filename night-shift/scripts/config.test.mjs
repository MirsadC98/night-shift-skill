// The one reader of .claude/night-shift.json. node --test config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProjectConfig, stateDirProblem, tempRoot, norm } from "./config.mjs";

const repoWith = (text) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "night-config-test-"));
  if (text !== undefined) {
    fs.mkdirSync(path.join(repo, ".claude"));
    fs.writeFileSync(path.join(repo, ".claude", "night-shift.json"), typeof text === "string" ? text : JSON.stringify(text));
  }
  return repo;
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
  const where = { home: "C:\\Users\\u", repo: "C:/Users/u/Masaüstü/My Game", temp: "C:/Users/u/AppData/Local/Temp" };
  for (const bad of ["C:/", "C:\\temp", "D:/x", "C:/Users/u", "C:/Users", "C:/Users/u/Masaüstü/My Game", "C:/Users/u/Masaüstü",
    "C:/Users/u/Masaüstü/My Game/.git/night", "C:/Users/u/.claude/night", "C:/Users/u/AppData/Local/Temp"])
    assert.ok(stateDirProblem(bad, where), bad);
  for (const good of ["C:/temp/my-game-night-20261116", "C:/Users/u/AppData/Local/Temp/night-shift-My Game-20261116", "C:/Users/u/Masaüstü/My Game/.night"])
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
