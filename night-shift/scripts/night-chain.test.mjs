// node --test night-chain.test.mjs — runs `run` for real against a stand-in claude (a .mjs),
// in a throwaway repo, state folder and home, so no real session. NIGHT_SHIFT_LAUNCH=direct
// starts the next runner as a plain detached process instead of through Task Scheduler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// A CLAUDE_CONFIG_DIR of the user's own would move every file these tests read or write (claudeHome in config.mjs).
delete process.env.CLAUDE_CONFIG_DIR;

const CHAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "night-chain.mjs");
// T8: a mode's rules as a new session's header carries them.
const modeText = (m) => fs.readFileSync(path.join(path.dirname(path.dirname(CHAIN)), "references", `mode-${m}.md`), "utf8").replace(/\r\n/g, "\n").trim();
// A header without its mode's rules: what the runner itself says to the session (its notes name the model in play).
const ownLines = (input, m) => input.replace(modeText(m), "");
// A made-up language table, "xx", copied into a throwaway home as the user's own (lang/index.mjs).
const XX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lang-xx.mjs");
const putTable = (home, code = "xx", text) => {
  const file = path.join(home, ".claude", "night-shift", "lang", `${code}.mjs`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (text === undefined) fs.copyFileSync(XX, file); else fs.writeFileSync(file, text);
  return file;
};
const setLang = (state, lang) => {
  const f = path.join(state, "run.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), lang }));
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Session 1 waits for the watcher, asks for a reload with the real command, and hands over;
// session 2 notes the watcher that replaced it and ends the chain. Each notes which runner pid
// started it.
const FAKE = `import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
const st = process.env.NIGHT_SHIFT_STATE, n = Number(process.env.NIGHT_SHIFT_SESSION);
fs.appendFileSync(path.join(st, "fake.log"), n + " " + process.ppid + "\\n");
if (n === 1) {
  for (let i = 0; i < 100 && !fs.existsSync(path.join(st, "watch.pid")); i++) await new Promise((r) => setTimeout(r, 100));
  fs.writeFileSync(path.join(st, "watcher-1.txt"), fs.readFileSync(path.join(st, "watch.pid"), "utf8"));
  fs.writeFileSync(path.join(st, "reload-out.txt"), execFileSync(process.execPath, [process.env.TEST_CHAIN, "reload", "--repo", process.cwd()], { encoding: "utf8", windowsHide: true }));
  fs.writeFileSync(path.join(st, "next-prompt.md"), "second");
} else {
  const first = fs.readFileSync(path.join(st, "watcher-1.txt"), "utf8");
  for (let i = 0; i < 100; i++) {
    const w = fs.existsSync(path.join(st, "watch.pid")) ? fs.readFileSync(path.join(st, "watch.pid"), "utf8") : "";
    if (w && w !== first) { fs.writeFileSync(path.join(st, "watcher-2.txt"), w); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done\\n\\nWaiting for the user:\\n\\n1. **Push.** 12 local commits\\n2. Physical acceptance");
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`;

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "night-chain-test-"));
  const home = path.join(root, "home"), repoDir = path.join(root, "repo"), state = path.join(root, "state");
  for (const d of [home, repoDir, path.join(state, "prompts")]) fs.mkdirSync(d, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repoDir });
  const repo = path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoDir, encoding: "utf8" }).trim());
  const fake = path.join(root, "fake-claude.mjs");
  fs.writeFileSync(fake, FAKE);
  fs.writeFileSync(path.join(state, "next-prompt.md"), "first");
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ repo, state, until: null, deadline: null, maxSessions: 4,
    sessionHours: 1, model: null, effort: "xhigh", lang: "en", claude: fake, report: "NIGHT_RUNS.md", path: process.env.PATH, startedAt: "test" }));
  const env = { ...process.env, USERPROFILE: home, HOME: home, TEST_CHAIN: CHAIN, NIGHT_SHIFT_LAUNCH: "direct" };
  delete env.NIGHT_SHIFT_RELOADED;
  return { root, home, repo, state, env };
}

// Runs `run` and resolves with its exit code; the chain itself may go on in the runner it starts.
// From the throwaway root: with USERPROFILE moved, PowerShell writes its module cache into the cwd.
const runOnce = (args, env, cwd) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [CHAIN, "run", ...args], { env, cwd, stdio: "ignore" });
  const t = setTimeout(() => { p.kill(); reject(new Error("run did not exit in 90 s")); }, 90_000);
  p.on("exit", (c) => { clearTimeout(t); resolve({ code: c, pid: p.pid }); });
});
const waitForLog = async (state, re, ms = 90_000) => {
  const f = path.join(state, "chain.log");
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    const log = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    if (re.test(log)) return log;
  }
  throw new Error(`chain.log never matched ${re}:\n${fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "(none)"}`);
};
const pointerOf = (home) => {
  const dir = path.join(home, ".claude", "night-shift", "runs");
  return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), "utf8"));
};

test("reload: the next session runs in a fresh runner, the watcher is replaced, and the chain ends normally", async () => {
  const { state, env, home, root } = setup();
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  assert.equal(code, 0);
  const log = await waitForLog(state, /chain ends: /);
  // The second runner's own process ends a moment after its last line.
  await new Promise((r) => setTimeout(r, 1000));
  assert.match(fs.readFileSync(path.join(state, "reload-out.txt"), "utf8"), /takes up its new code/);
  const runners = fs.readFileSync(path.join(state, "fake.log"), "utf8").trim().split("\n").map((l) => l.split(" "));
  assert.deepEqual(runners.map((r) => r[0]), ["1", "2"]);
  assert.notEqual(runners[0][1], runners[1][1], "session 2 must come from a new runner process");
  const first = Number(fs.readFileSync(path.join(state, "watcher-1.txt"), "utf8"));
  assert.match(log, new RegExp(`runner reloads its code; watcher ${first} replaced`));
  assert.equal(alive(first), false, "the old watcher must be gone");
  assert.ok(fs.existsSync(path.join(state, "watcher-2.txt")), "session 2 must have a new watcher");
  assert.match(log, /chain starts in .* \(runner reloaded\)/);
  assert.match(log, /chain ends: STOP: done/);
  assert.equal(fs.existsSync(path.join(state, "RELOAD-REQUEST")), false);
  const ptr = pointerOf(home);
  assert.equal(ptr.finished, true);
  assert.equal(ptr.reason, "STOP: done");
  assert.equal(ptr.pid, Number(runners[1][1]));
});

test("a reload that cannot start the next runner leaves this one going, with a new watcher", async () => {
  const { state, env, root } = setup();
  const { code } = await runOnce(["--state", state, "--headless"], { ...env, NIGHT_SHIFT_LAUNCH: "fail" }, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  assert.match(log, /reload failed \(launch refused \(test\)\); this runner goes on/);
  assert.doesNotMatch(log, /runner reloads its code/);
  const runners = fs.readFileSync(path.join(state, "fake.log"), "utf8").trim().split("\n").map((l) => l.split(" "));
  assert.deepEqual(runners.map((r) => r[0]), ["1", "2"]);
  assert.equal(runners[0][1], runners[1][1], "session 2 runs in the same runner");
  assert.ok(fs.existsSync(path.join(state, "watcher-2.txt")), "the killed watcher must be started again");
  assert.match(log, /chain ends: STOP: done/);
});

test("reload refuses a runner from before reload, which would ignore the request", () => {
  const { repo, state, env, home } = setup();
  const ptrDir = path.join(home, ".claude", "night-shift", "runs");
  fs.mkdirSync(ptrDir, { recursive: true });
  // The pointer of an older runner: alive, its command line names night-chain.mjs, no "reloadable".
  const older = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "night-chain.mjs"], { stdio: "ignore" });
  const slugged = execFileSync(process.execPath, ["-e",
    `const c=require("crypto"),p=require("path");console.log(p.basename(process.argv[1])+"-"+c.createHash("sha1").update(process.argv[1].toLowerCase()).digest("hex").slice(0,8))`, repo], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(ptrDir, `${slugged}.json`), JSON.stringify({ pid: older.pid, state, finished: false }));
  let out;
  try { out = execFileSync(process.execPath, [CHAIN, "reload", "--repo", repo], { env, encoding: "utf8" }); } finally { older.kill(); }
  assert.match(out, /predates reload/);
  assert.equal(fs.existsSync(path.join(state, "RELOAD-REQUEST")), false);
});

test("cutOffSession: only a session that started (or resumed) and never ended counts", async () => {
  const { cutOffSession } = await import("./night-chain.mjs");
  const { state } = setup();
  const log = (lines) => fs.writeFileSync(path.join(state, "chain.log"), lines.map((l) => `[2026-11-01 19:26:17] ${l}`).join("\n") + "\n");
  fs.writeFileSync(path.join(state, "session-35.jsonl"), '{"type":"system","session_id":"00000000-0000-4000-8000-000000000035"}\n');
  log(["chain starts in x", "session 34 ends: success", "session 35 starts: Zincir 2"]);
  assert.deepEqual(cutOffSession(state), { nn: "35", sessionId: "00000000-0000-4000-8000-000000000035" });
  log(["session 35 resumes 00000000-0000-4000-8000-000000000035 after the usage limit"]);
  assert.deepEqual(cutOffSession(state), { nn: "35", sessionId: "00000000-0000-4000-8000-000000000035" });
  log(["session 35 starts: x", "session 35 ends: success"]);
  assert.equal(cutOffSession(state), null);
  log(["session 35 starts: x", "chain ends: stop requested"]);
  assert.equal(cutOffSession(state), null);
  log(["session 36 starts: x"]);
  assert.equal(cutOffSession(state), null, "no stream, no conversation to resume");
  // From 2026-11-15 the runs line says what it ran on, so the resume goes on on the same model.
  log(["session 35 starts: x", "session 35 runs Fable at high"]);
  assert.deepEqual(cutOffSession(state), { nn: "35", sessionId: "00000000-0000-4000-8000-000000000035", model: "fable", effort: "high" });
  log(["session 35 starts: x", "session 35 asked for Fable, but its allowance is used up until 2026-11-18 10:00; it runs on Opus at max",
    "session 35 runs Opus (claude-opus-5-5) at max"]);
  assert.deepEqual(cutOffSession(state), { nn: "35", sessionId: "00000000-0000-4000-8000-000000000035", model: "claude-opus-5-5", effort: "max" });
});

test("a resumed session's header is English throughout, for every reason it resumes", async () => {
  for (const why of ["stopped", "limit", "error"]) {
    const { state, env, root, home } = setup();
    putTable(home);
    setLang(state, "xx");
    const fake = path.join(root, "fake-resume-header.mjs");
    fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE; let input = "";
for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "seen.json"), JSON.stringify({ input }));
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "00000000-0000-4000-8000-000000000035", result: "ok" }));
`);
    const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
    fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null }));
    fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "35", sessionId: "00000000-0000-4000-8000-000000000035", why }));
    const { code } = await runOnce(["--state", state, "--headless"], env, root);
    assert.equal(code, 0, fs.readFileSync(path.join(state, "chain.log"), "utf8"));
    const { input } = JSON.parse(fs.readFileSync(path.join(state, "seen.json"), "utf8"));
    assert.match(input, /\(commit, night report, .*next-prompt\.md\)\./, why);
    assert.doesNotMatch(input, /xx·|Xxish/, why);   // the run is in the user's own language; what the model reads is not
  }
});

test("a stopped session resumes with its own header, and settings added by hand survive run", async () => {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-resume.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE; let input = "";
for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "seen.json"), JSON.stringify({ args: process.argv.slice(2), input }));
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "00000000-0000-4000-8000-000000000035", result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null }));
  fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "35", sessionId: "00000000-0000-4000-8000-000000000035", why: "stopped" }));
  fs.writeFileSync(path.join(state, "night-settings.json"), JSON.stringify({ crossSessionInbound: "accept",
    env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" },
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "cleanup.ps1" }] }], PreToolUse: [] },
    modelSettings: { opus: { effortLevel: "high" }, sonnet: { effortLevel: "medium" } } }));
  const mark = path.join(root, "hide-mark.txt");
  const { code } = await runOnce(["--state", state, "--headless"], { ...env, NIGHT_SHIFT_HIDE_MARK: mark }, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  assert.match(log, /session 35 resumes 00000000-0000-4000-8000-000000000035 where the last runner stopped/);
  assert.ok(fs.existsSync(mark), "the session's Node processes must load hide-windows.cjs");
  const seen = JSON.parse(fs.readFileSync(path.join(state, "seen.json"), "utf8"));
  assert.deepEqual(seen.args.slice(seen.args.indexOf("--resume"), seen.args.indexOf("--resume") + 2), ["--resume", "00000000-0000-4000-8000-000000000035"]);
  assert.match(seen.input, /^The session was cut off: the runner stopped/);
  assert.doesNotMatch(seen.input, /The usage limit has reset/);
  assert.equal(fs.existsSync(path.join(state, "resume.json")), false);
  const s = JSON.parse(fs.readFileSync(path.join(state, "night-settings.json"), "utf8"));
  assert.equal(s.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "0");
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, "cleanup.ps1");
  assert.match(s.hooks.PreToolUse[0].hooks[0].args[0], /guard\.mjs$/);
  // The Mythos id too: the run may start a Mythos session, whose level only its id's key sets (D6).
  assert.deepEqual(s.modelSettings, { opus: { effortLevel: "xhigh" }, fable: { effortLevel: "high" }, sonnet: { effortLevel: "medium" }, haiku: { effortLevel: "high" },
    "claude-mythos-5-2": { effortLevel: "high" } });
  assert.equal(s.autoContinueAtUsageLimit, true);
  assert.equal(s.outputStyle, "default");
  assert.equal(s.crossSessionInbound, "refuse", "a resumed session takes no other session's message either");
});

test("a STOP handover written by the last session --max-sessions allows ends the chain with the STOP reason, not the session cap", async () => {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-cap-stop.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = process.env.NIGHT_SHIFT_SESSION;
for await (const c of process.stdin);
fs.writeFileSync(path.join(st, "next-prompt.md"), n === "1" ? "plain piece" : "STOP: both pieces done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: 2 }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), "first piece");
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  assert.match(log, /chain ends: STOP: both pieces done/);
  assert.doesNotMatch(log, /reached 2 sessions/);
});

test("without a STOP handover the session cap still ends the chain", async () => {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-cap-plain.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = process.env.NIGHT_SHIFT_SESSION;
for await (const c of process.stdin);
fs.writeFileSync(path.join(st, "next-prompt.md"), "piece after " + n);
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: 2 }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), "first piece");
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  assert.match(log, /chain ends: reached 2 sessions/);
});

// A session that ends after --until: its fake waits for the deadline in run.json to pass, then writes its handover.
async function pastDeadlineRun(handover) {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-past-deadline.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE;
for await (const c of process.stdin);
const { deadline } = JSON.parse(fs.readFileSync(path.join(st, "run.json"), "utf8"));
while (Date.now() <= deadline + 100) await new Promise((r) => setTimeout(r, 50));
fs.writeFileSync(path.join(st, "next-prompt.md"), ${JSON.stringify(handover)});
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null, until: "09:00", deadline: Date.now() + 4000 }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), "first piece");
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  assert.match(log, /session 01 starts: first piece/, "the session must start before the deadline");
  return log;
}

test("a STOP handover written after --until has passed ends the chain with the STOP reason, not the deadline", async () => {
  const log = await pastDeadlineRun("STOP: all pieces done");
  assert.match(log, /chain ends: STOP: all pieces done/);
  assert.doesNotMatch(log, /reached 09:00/);
});

test("without a STOP handover a passed --until still ends the chain", async () => {
  const log = await pastDeadlineRun("next piece");
  assert.match(log, /chain ends: reached 09:00/);
  assert.doesNotMatch(log, /session 02 starts/);
});

test("the runner picks model and effort: Opus unless a prompt asks for Fable, max only for a prompt that opens with EFFORT: max", async () => {
  const { state, env, root, home, repo } = setup();
  const fake = path.join(root, "fake-effort.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = process.env.NIGHT_SHIFT_SESSION; let input = "";
for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "seen-" + n + ".json"), JSON.stringify({ args: process.argv.slice(2), input, effortEnv: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
  noFallback: process.env.CLAUDE_CODE_NO_MODEL_FALLBACK ?? null }));
fs.writeFileSync(path.join(st, "next-prompt.md"), n === "1" ? "plain piece" : "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), "EFFORT: max\nhard piece");
  // What the user picked in VS Code or Desktop, and what the project pins: none of it reaches the chain.
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-fable-5-2",
    modelSettings: { "claude-opus-5-5": { effortLevel: "high" }, "claude-fable-5-2": { effortLevel: "medium" } } }));
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "settings.local.json"), JSON.stringify({ modelSettings: { "claude-sonnet-5-5": { effortLevel: "low" } } }));
  const { code } = await runOnce(["--state", state, "--headless"], { ...env, CLAUDE_CODE_EFFORT_LEVEL: "low" }, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  const [one, two] = ["1", "2"].map((n) => JSON.parse(fs.readFileSync(path.join(state, `seen-${n}.json`), "utf8")));
  const flag = (s, f) => (s.args.includes(f) ? s.args[s.args.indexOf(f) + 1] : null);
  assert.equal(flag(one, "--model"), "opus");
  assert.equal(flag(one, "--effort"), "max");
  assert.doesNotMatch(one.input, /^EFFORT:/m);
  assert.match(one.input, /\n---\nhard piece\n$/);
  assert.match(one.input, /Sonnet "medium", work that matters "high"/);
  // Max is for that one piece: finished or blocked, the session takes no other work at max.
  assert.match(one.input, /only for this piece/);
  assert.match(one.input, /take no other work/);
  assert.equal(one.effortEnv, null);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(flag(two, "--effort"), null);
  assert.doesNotMatch(two.input, /work that matters "high"/);
  assert.doesNotMatch(two.input, /take no other work/);
  assert.match(log, /session 01 starts: hard piece/);
  assert.match(log, /session 01 runs Opus at max/);
  const s = JSON.parse(fs.readFileSync(path.join(state, "night-settings.json"), "utf8"));
  assert.equal(s.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.deepEqual(s.modelSettings, {
    opus: { effortLevel: "xhigh" }, "claude-opus-5-5": { effortLevel: "xhigh" },
    fable: { effortLevel: "high" }, "claude-fable-5-2": { effortLevel: "high" }, "claude-mythos-5-2": { effortLevel: "high" },
    sonnet: { effortLevel: "medium" }, "claude-sonnet-5-5": { effortLevel: "medium" }, haiku: { effortLevel: "high" } });
  assert.match(log, /session 02 runs Opus at xhigh\n/);
  assert.equal(one.noFallback, null, "the model fallback stays on for Opus");
});

test("a retry keeps the EFFORT line of the prompt it retries on top, so the same piece runs at the same level", async () => {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-retry.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = process.env.NIGHT_SHIFT_SESSION; let input = "";
for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "seen-" + n + ".json"), JSON.stringify({ args: process.argv.slice(2), input }));
if (n === "2") fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), "EFFORT: max\nNeden: a race across two subsystems.\nhard piece");
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  const two = JSON.parse(fs.readFileSync(path.join(state, "seen-2.json"), "utf8"));
  assert.equal(two.args[two.args.indexOf("--effort") + 1], "max");
  assert.match(two.input, /ended without writing a continuation prompt/);
  assert.match(two.input, /Neden: a race across two subsystems\.\nhard piece/);
  assert.doesNotMatch(two.input, /^EFFORT:/m);
  assert.match(log, /session 02 runs Opus at max/);
  assert.match(fs.readFileSync(path.join(state, "prompts", "02.md"), "utf8"), /^EFFORT: max\n/);
});

// ---------------------------------------------------------------- Fable
test("the hook covers MCP tools; a session starts no server, every one (inherit), or only the listed ones", async () => {
  // One session per run mode; the stand-in writes its argv and ends the chain. home: the user's files to put first.
  const argvOf = async (patch, homeFiles = {}) => {
    const { state, env, root, home } = setup();
    for (const [f, data] of Object.entries(homeFiles)) fs.writeFileSync(path.join(home, f), JSON.stringify(data));
    const fake = path.join(root, "fake-mcp.mjs");
    fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE; for await (const c of process.stdin);
fs.writeFileSync(path.join(st, "argv-1.json"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
    const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
    fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null, ...patch }));
    const { code } = await runOnce(["--state", state, "--headless"], env, root);
    assert.equal(code, 0, fs.readFileSync(path.join(state, "chain.log"), "utf8"));
    return { argv: JSON.parse(fs.readFileSync(path.join(state, "argv-1.json"), "utf8")),
      settings: JSON.parse(fs.readFileSync(path.join(state, "night-settings.json"), "utf8")),
      log: fs.readFileSync(path.join(state, "chain.log"), "utf8") };
  };
  const none = await argvOf({});
  assert.equal(none.settings.hooks.PreToolUse[0].matcher, "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*");
  assert.ok(none.argv.includes("--strict-mcp-config"), "no mcp in run.json means none");
  assert.ok(!none.argv.includes("--mcp-config"));
  assert.doesNotMatch(none.log, /\] mcp: /, "a run without MCP says nothing about it");
  assert.ok((await argvOf({ mcp: "none" })).argv.includes("--strict-mcp-config"));
  // inherit: every server of the user's loads, as in an interactive session.
  assert.ok(!(await argvOf({ mcp: "inherit" })).argv.includes("--strict-mcp-config"));
  // A list: only its servers, each with its own config, the other servers of the user's not at all.
  const servers = { github: { type: "stdio", command: "gh-mcp", args: [] }, blender: { command: "blender-mcp" } };
  const listed = await argvOf({ mcp: ["github", "plugin_x_y"], effort: "max" }, { ".claude.json": { mcpServers: servers } });
  assert.ok(listed.argv.includes("--strict-mcp-config"));
  const at = listed.argv.indexOf("--mcp-config");
  assert.deepEqual(JSON.parse(listed.argv[at + 1]), { mcpServers: { github: servers.github } });
  // --mcp-config takes several values: the next word after its one value is a flag of its own.
  assert.deepEqual(listed.argv.slice(at + 2, at + 4), ["--effort", "max"]);
  // A listed server that left every config since start: the session starts without it, and chain.log says so once.
  assert.match(listed.log, /\] mcp: "plugin_x_y" is in no MCP config any more; sessions start without it\n/);
  const gone = await argvOf({ mcp: ["plugin_x_y"] });
  assert.ok(gone.argv.includes("--strict-mcp-config"));
  assert.ok(!gone.argv.includes("--mcp-config"));
});

test("start copies the project's mcp setting into run.json", () => {
  const modeOf = (cfg) => {
    const c = pointerCase();
    fs.mkdirSync(path.join(c.repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(c.repo, ".claude", "night-shift.json"), JSON.stringify(cfg));
    // The launch is refused (NIGHT_SHIFT_LAUNCH=fail), but run.json is written before it.
    c.run("start", ["--state", c.state, "--allow-dirty", "--prompt", "x"]);
    return JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")).mcp;
  };
  assert.equal(modeOf({}), "none");
  assert.equal(modeOf({ mcp: "inherit" }), "inherit");
  assert.deepEqual(modeOf({ mcp: [] }), []);
});

test("start refuses a listed MCP server that no config holds, and prints where each listed one comes from", () => {
  const c = pointerCase();
  fs.mkdirSync(path.join(c.repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(c.repo, ".claude", "night-shift.json"), JSON.stringify({ mcp: ["github", "plugin:ctx:ctx", "claude.ai Docs"] }));
  fs.writeFileSync(path.join(c.home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));
  const refused = c.run("start", ["--state", c.state, "--allow-dirty", "--prompt", "x"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"mcp" in .*night-shift\.json names "plugin:ctx:ctx", "claude\.ai Docs", which no MCP config holds \(looked in .*\.claude\.json, .*\.mcp\.json and the installed plugins\); a claude\.ai connector or a server in an \.mcpb bundle starts only with "mcp": "inherit"/);
  assert.doesNotMatch(refused.stderr, /launch refused/, "refused before anything is scheduled");
  const root = path.join(c.home, ".claude", "plugins", "cache", "m", "ctx");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { ctx: { type: "http", url: "https://ctx.example/mcp" } } }));
  fs.writeFileSync(path.join(c.home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "ctx@m": [{ scope: "user", installPath: root }] } }));
  fs.writeFileSync(path.join(c.repo, ".claude", "night-shift.json"), JSON.stringify({ mcp: ["github", "plugin:ctx:ctx"] }));
  const ok = c.run("start", ["--state", c.state, "--allow-dirty", "--prompt", "x"]);
  assert.match(ok.stderr, /launch refused \(test\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")).mcp, ["github", "plugin:ctx:ctx"]);
  // Configs too long for a session's command line are refused too.
  fs.writeFileSync(path.join(c.home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "gh-mcp", args: ["x".repeat(25_000)] } } }));
  const long = c.run("start", ["--state", c.state, "--allow-dirty", "--prompt", "x"]);
  assert.equal(long.status, 1);
  assert.match(long.stderr, /the configs of the MCP servers "mcp" lists take \d+ characters, more than a session's command line holds \(20000\); list fewer, or set "mcp": "inherit"/);
});

test("start prints the MCP servers a list starts, and inherit, but nothing without MCP", async () => {
  const listed = await startPrints(({ repo, home }) => {
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "night-shift.json"), JSON.stringify({ mcp: ["github", "db"] }));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));
    fs.writeFileSync(path.join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }));
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "/.mcp.json\n");
  });
  assert.match(listed, /^ {2}mcp: {4}github \(yours\), db \(this repository's \.mcp\.json\); no other server starts$/m);
  const inherit = await startPrints(({ repo }) => {
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "night-shift.json"), JSON.stringify({ mcp: "inherit" }));
  });
  assert.match(inherit, /^ {2}mcp: {4}inherit: every MCP server you have starts in each session/m);
  assert.doesNotMatch(await startPrints(() => {}), /^ {2}mcp:/m);
});

// A stand-in that notes what each session got (its flags, input, env and the settings layer) and
// then does what the test's SCRIPT says for its session number: write a next prompt, send a limit
// event, end refused.
const FABLE_FAKE = `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = process.env.NIGHT_SHIFT_SESSION; let input = "";
for await (const c of process.stdin) input += c;
const settings = JSON.parse(fs.readFileSync(path.join(st, "night-settings.json"), "utf8")).modelSettings;
fs.writeFileSync(path.join(st, "seen-" + n + ".json"), JSON.stringify({ args: process.argv.slice(2), input, settings,
  noFallback: process.env.CLAUDE_CODE_NO_MODEL_FALLBACK ?? null }));
const step = JSON.parse(process.env.TEST_SCRIPT)[n] || {};
// step.stream: a recorded stream (a fixture) is the whole session, as the CLI wrote it.
if (step.stream) { process.stdout.write(fs.readFileSync(step.stream, "utf8")); process.exit(0); }
// step.rules: { global, project } rewrites the user's rule files (null deletes one), as a session or an editor may.
for (const [k, v] of Object.entries(step.rules || {})) {
  const f = k === "global" ? path.join(process.env.USERPROFILE, ".claude", "night-shift", "rules.md") : path.join(process.cwd(), ".claude", "night-shift-rules.md");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (v == null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, v);
}
if (step.fable != null) console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed",
  unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.3 }, seven_day_overage_included: { utilization: step.fable, resetsAt: step.resets } } } }));
// step.week: a limit event whose seven-day window is at that share, resetting at step.weekResets (epoch s).
if (step.week != null) console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed",
  unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: step.week, resetsAt: step.weekResets ?? null } } } }));
// step.lines: stream lines written as they are.
for (const l of step.lines || []) console.log(l);
// step.model: one main-conversation turn on that model, at step.effort, as the CLI reports a turn.
if (step.model) console.log(JSON.stringify({ type: "assistant", perTurnEffort: step.effort, message: { model: step.model, usage: { input_tokens: 1, output_tokens: 1 }, content: [] } }));
if (step.next != null) fs.writeFileSync(path.join(st, "next-prompt.md"), step.next);
console.log(JSON.stringify(step.refuse
  ? { type: "result", subtype: "success", is_error: true, api_error: step.refuse, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "refused" }
  : { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: step.cost ?? 0, session_id: step.id ?? "fake-" + n, result: "ok" }));
`;
async function fableRun(first, script, runPatch = {}, before = null) {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-fable.mjs");
  fs.writeFileSync(fake, FABLE_FAKE);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null, ...runPatch }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), first);
  if (before) before(state, { home: env.USERPROFILE, repo: run.repo });
  // A short look at the clock, so a wait of a few seconds (the five-hour window's) ends on time.
  const { code } = await runOnce(["--state", state, "--headless"], { ...env, TEST_SCRIPT: JSON.stringify(script), NIGHT_SHIFT_LIMIT_TICK_MS: "50" }, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  const seen = (n) => JSON.parse(fs.readFileSync(path.join(state, `seen-${n}.json`), "utf8"));
  const flag = (s, f) => (s.args.includes(f) ? s.args[s.args.indexOf(f) + 1] : null);
  const fable = () => JSON.parse(fs.readFileSync(path.join(state, "fable.json"), "utf8"));
  return { state, log, seen, flag, fable };
}

// One headless session of a run in lang, its home prepared by prep; what the session read and chain.log.
async function headerOf(lang, prep = () => {}) {
  const { root, state, env, home } = setup();
  prep(home);
  setLang(state, lang);
  const fake = path.join(root, "fake-marker.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE; let input = "";
for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "seen-1.json"), JSON.stringify({ input, skill: process.env.NIGHT_SHIFT_SKILL ?? null }));
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), "hard piece");
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  return { ...JSON.parse(fs.readFileSync(path.join(state, "seen-1.json"), "utf8")), log };
}

test("a session's header opens with the marker and names the user's language and the skill folder", async () => {
  const one = await headerOf("xx", (home) => putTable(home));
  const skillDir = path.dirname(path.dirname(CHAIN));
  assert.match(one.input, /^Night shift \(night-shift\), session 1, \d{4}-\d\d-\d\d /);
  assert.match(one.input, /The user reads Xxish: /, "the language's name comes from the user's table");
  assert.ok(one.input.includes(`Skill folder: ${skillDir}.`));
  assert.equal(one.skill, skillDir);
  assert.ok(one.input.endsWith("\n---\nhard piece\n"));
  // T8: its own mode's rules follow the mode's line; no other mode's.
  assert.ok(one.input.includes(`Mode: opus.\n${modeText("opus")}\nSkill folder: `));
  assert.doesNotMatch(one.input, /\*\*Mode (fable|mythos)\.\*\*/);
  assert.doesNotMatch(one.log, /language table/);
  assert.match((await headerOf("en")).input, /The user reads English: /);
});

test("a runner whose language table is gone reads English and says so once in chain.log", async () => {
  const gone = await headerOf("xx");
  assert.match(gone.input, /The user reads English: /);
  const lines = gone.log.split("\n").filter((l) => /language table/.test(l));
  assert.equal(lines.length, 1, gone.log);
  assert.match(lines[0], /^\[[^\]]+\] language table: no language table at .*lang[\\/]xx\.mjs; what the user reads is in English$/);
  const broken = await headerOf("xx", (home) => putTable(home, "xx", "export default {,};\n"));
  assert.match(broken.input, /The user reads English: /);
  assert.match(broken.log, /language table: .*xx\.mjs does not load: .*; what the user reads is in English/);
});

test("a MODEL: fable prompt runs that session on Fable at high without the model fallback; the next one on Opus", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { state, log, seen, flag, fable } = await fableRun("MODEL: fable — the parser resisted Opus twice\nhard piece", {
    1: { fable: 0.2, resets, next: `plain piece\n${"x".repeat(13_000)}` }, 2: { next: "STOP: done" } });
  const [one, two] = [seen(1), seen(2)];
  assert.equal(flag(one, "--model"), "fable");
  assert.equal(flag(one, "--effort"), null, "high goes through the settings layer");
  assert.equal(one.settings.fable.effortLevel, "high");
  assert.equal(one.settings.opus.effortLevel, "xhigh");
  assert.equal(one.noFallback, "1");
  assert.doesNotMatch(one.input, /^MODEL:/m);
  assert.match(one.input, /\n---\nthe parser resisted Opus twice\nhard piece\n$/);
  assert.match(one.input, /This session runs on Fable, only for this piece/);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(two.noFallback, null);
  assert.doesNotMatch(two.input, /runs on Fable/);
  assert.match(log, /session 01 starts: the parser resisted Opus twice\n/);
  assert.match(log, /session 01 runs Fable at high\n/);
  assert.match(log, /session 01 limits: 5h 40%→40% · 7d 30%→30% · fable 20%→20%; it ran on no model reply/);
  // T2: flagged from 12 KB, with what it costs, before the end line, at which the watcher makes the session's card.
  assert.match(log, /session 01 wrote a next-prompt\.md of 13 KB \(over 12 KB\): every call of the next session reads all of it again, about 5k tokens a call\n\[[^\]]+\] session 01 ends: /);
  assert.doesNotMatch(log, /session 02 wrote a next-prompt/);
  const { sessionMessage } = await import("./night-report.mjs");
  assert.match(sessionMessage(state, "01", process.pid).text, /continuation prompt is 13 KB \(over 12 KB; every call reads it again, about 5k tokens each\)/);
  assert.match(log, /session 02 runs Opus at xhigh\n/);
  assert.deepEqual(fable(), { sessions: 1, ratio: 0.2, ratioResetsAt: resets, ratioAt: fable().ratioAt });
});

test("a Fable session its allowance cuts off goes on from its prompt on Opus at max, and so do later Fable requests", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { state, log, seen, flag, fable } = await fableRun("MODEL: fable\nhard piece", {
    1: { fable: 1, resets, refuse: "model_requires_usage_credits" },
    2: { next: "MODEL: fable\nanother hard piece" }, 3: { next: "STOP: done" } });
  const [two, three] = [seen(2), seen(3)];
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(flag(two, "--effort"), "max");
  assert.equal(two.noFallback, null);
  assert.match(two.input, /The previous Fable session \(01\) was cut off/);
  assert.match(two.input, /git status and git diff/);
  assert.match(two.input, /\n\nhard piece\n$/);
  assert.doesNotMatch(two.input, /^(MODEL|EFFORT):/m);
  assert.match(fs.readFileSync(path.join(state, "prompts", "02.md"), "utf8"), /^EFFORT: max\n/);
  assert.equal(fs.existsSync(path.join(state, "resume.json")), false);
  assert.equal(fable().outUntil, resets * 1000 + 60_000);
  assert.match(log, /session 01: Fable's allowance is used up \(model_requires_usage_credits\) until \S+ \S+; limit record null/);
  assert.match(log, /session 01's piece goes on in the next session on Opus at max/);
  assert.match(log, /session 02 runs Opus at max \(its prompt asks for it\)/);
  // The next Fable request runs on Opus at max until the allowance resets.
  assert.equal(flag(three, "--model"), "opus");
  assert.equal(flag(three, "--effort"), "max");
  assert.match(three.input, /The prompt asked for MODEL: fable/);
  assert.match(three.input, /\n---\nanother hard piece\n$/);
  assert.match(log, /session 03 asked for Fable, but its allowance is used up until \S+ \S+; it runs on Opus at max\n/);
  assert.match(log, /session 03 runs Opus at max\n/);
  const { sessionMessage } = await import("./night-report.mjs");
  assert.match(sessionMessage(state, "01", process.pid).text, /cut off because Fable's share ran out/);
  assert.match(sessionMessage(state, "03", process.pid).text, /asked for Fable, ran on Opus at max \(Fable's share is used up until \S+ \S+\)/);
  assert.doesNotMatch(sessionMessage(state, "03", process.pid).text, /should be/);
});

test("over the Fable ceiling, or past the count while the share is unknown, a Fable request runs on Opus at max", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const over = await fableRun("MODEL: fable\nfirst", { 1: { fable: 0.55, resets, next: "MODEL: fable\nsecond" }, 2: { next: "STOP: done" } },
    { fableCeiling: 0.5 });
  assert.equal(over.flag(over.seen(1), "--model"), "fable");
  assert.equal(over.flag(over.seen(2), "--model"), "opus");
  assert.equal(over.flag(over.seen(2), "--effort"), "max");
  assert.match(over.log, /session 02 asked for Fable, but its allowance is at 55%, at or over the 50% ceiling; it runs on Opus at max/);
  const count = await fableRun("MODEL: fable\nfirst", { 1: { next: "MODEL: fable\nsecond" }, 2: { next: "STOP: done" } }, { fableSessions: 1 });
  assert.equal(count.flag(count.seen(2), "--model"), "opus");
  assert.match(count.log, /session 02 asked for Fable, but 1 session on its allowance already ran in this chain while the allowance's share is unknown; it runs on Opus at max\n/);
  assert.equal(count.fable().sessions, 1);
});

test("a retry keeps both MODEL and EFFORT; a resume goes on on the model it ran on", async () => {
  const retry = await fableRun("MODEL: fable\nEFFORT: xhigh\nhard piece", { 2: { next: "STOP: done" } });
  const two = retry.seen(2);
  assert.equal(retry.flag(two, "--model"), "fable");
  assert.equal(retry.flag(two, "--effort"), null);
  assert.equal(two.settings.fable.effortLevel, "xhigh");
  assert.match(two.input, /ended without writing a continuation prompt[^]*\n\nhard piece\n$/);
  assert.match(fs.readFileSync(path.join(retry.state, "prompts", "02.md"), "utf8"), /^MODEL: fable\nEFFORT: xhigh\nThe previous night session/);
  assert.match(retry.log, /session 02 runs Fable at xhigh\n/);

  const { state, env, root } = setup();
  const fake = path.join(root, "fake-fable.mjs");
  fs.writeFileSync(fake, FABLE_FAKE);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), "plain piece");
  fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "03", sessionId: "fake-3", why: "limit", model: "fable", effort: "high" }));
  const { code } = await runOnce(["--state", state, "--headless"], { ...env, TEST_SCRIPT: JSON.stringify({ 3: { next: "STOP: done" } }) }, root);
  assert.equal(code, 0, fs.readFileSync(path.join(state, "chain.log"), "utf8"));
  const three = JSON.parse(fs.readFileSync(path.join(state, "seen-3.json"), "utf8"));
  assert.deepEqual(three.args.slice(three.args.indexOf("--model"), three.args.indexOf("--model") + 2), ["--model", "fable"]);
  assert.ok(three.args.includes("--resume"));
  assert.equal(three.noFallback, "1");
  assert.match(fs.readFileSync(path.join(state, "chain.log"), "utf8"), /session 03 runs Fable at high\n/);
  assert.equal(fs.existsSync(path.join(state, "fable.json")), false, "a resumed Fable session is not a new one");
});

// Fable mode: Fable is every session's model, Opus at xhigh stands in only while Fable is out or over the ceiling.
const FM = { mode: "fable", model: "fable", opusModel: "opus", effort: "high", lang: "en" };

test("fable mode: every session runs on Fable at high, past the count, with no only-this-piece note", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { log, seen, flag, fable } = await fableRun("first piece", {
    1: { fable: 0.2, resets, next: "second" }, 2: { next: "third" }, 3: { next: "STOP: done" } }, { ...FM, fableSessions: 1 });
  for (const n of [1, 2, 3]) {
    const s = seen(n);
    assert.equal(flag(s, "--model"), "fable", `session ${n}`);
    assert.equal(flag(s, "--effort"), null);
    assert.equal(s.settings.fable.effortLevel, "high");
    assert.equal(s.noFallback, "1");
  }
  assert.ok(seen(1).input.includes(`Mode: fable.\n${modeText("fable")}\nSkill folder: `));
  assert.doesNotMatch(seen(1).input, /\*\*Mode (opus|mythos)\.\*\*|A piece earns/);
  assert.doesNotMatch(seen(1).input, /only for this piece/);
  assert.match(log, /Fable as the main model under 60% of its allowance, else opus at xhigh\n/);
  assert.equal(fable().sessions, undefined);
});

test("fable mode: at the ceiling the next session runs on Opus at xhigh and says why", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { state, log, seen, flag } = await fableRun("first piece", {
    1: { fable: 0.65, resets, next: "second" }, 2: { next: "STOP: done" } }, { ...FM, fableCeiling: 0.6 });
  const two = seen(2);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(flag(two, "--effort"), null);
  assert.equal(two.settings.opus.effortLevel, "xhigh");
  assert.match(two.input, /main model is Fable/);
  assert.doesNotMatch(ownLines(two.input, "fable"), /\bmax\b/);
  assert.match(log, /session 02: Fable is the main model, but its allowance is at 65%, at or over the 60% ceiling; it runs on Opus at xhigh\n/);
  assert.match(log, /session 02 runs Opus at xhigh\n/);
  const { sessionMessage } = await import("./night-report.mjs");
  const card = sessionMessage(state, "02", process.pid).text;
  assert.match(card, /xhigh/);
  assert.doesNotMatch(card, /should be/);
  assert.doesNotMatch(card, /max/);
});

test("fable mode: a session the allowance cuts off goes on on Opus at xhigh, with no EFFORT line", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { state, log, seen, flag } = await fableRun("hard piece", {
    1: { fable: 1, resets, refuse: "model_requires_usage_credits" }, 2: { next: "STOP: done" } }, FM);
  const two = seen(2);
  assert.doesNotMatch(fs.readFileSync(path.join(state, "prompts", "02.md"), "utf8"), /^EFFORT:/m);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(flag(two, "--effort"), null);
  assert.match(two.input, /was cut off/);
  assert.ok(two.input.endsWith("\n\nhard piece\n"));
  assert.match(log, /session 01's piece goes on in the next session on Opus at xhigh/);
  const { sessionMessage } = await import("./night-report.mjs");
  const card = sessionMessage(state, "01", process.pid).text;
  assert.match(card, /xhigh/);
  assert.doesNotMatch(card, /max/);
});

test("fable mode: a fallback whose prompt asks for EFFORT: max is told one level and one next-prompt rule", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { log, seen, flag } = await fableRun("first piece", { 1: { fable: 0.65, resets, next: "EFFORT: max\nhard piece" }, 2: { next: "STOP: done" } }, FM);
  const two = seen(2);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(flag(two, "--effort"), "max");
  assert.doesNotMatch(two.input, /at xhigh|without a MODEL or EFFORT line/);
  assert.match(two.input, /main model is Fable/);
  assert.match(two.input, /This session runs at max effort, only for this piece/);
  assert.match(log, /session 02 runs Opus at max \(its prompt asks for it\)\n/);
});

test("fable mode: Fable comes back once the reset has passed", async () => {
  const { seen, flag } = await fableRun("first piece", { 1: { next: "STOP: done" } }, FM,
    (state) => fs.writeFileSync(path.join(state, "fable.json"), JSON.stringify({ outUntil: Date.now() - 1000 })));
  assert.equal(flag(seen(1), "--model"), "fable");
});

test("fable mode: MODEL: opus runs that one session on the stand-in Opus at xhigh", async () => {
  const { log, seen, flag } = await fableRun("MODEL: opus\nmechanical piece", { 1: { next: "second" }, 2: { next: "STOP: done" } },
    { ...FM, opusModel: "claude-opus-5-5" });
  assert.equal(flag(seen(1), "--model"), "claude-opus-5-5");
  assert.match(log, /session 01 runs Opus \(claude-opus-5-5\) at xhigh/);
  assert.equal(flag(seen(2), "--model"), "fable");
});

test("a run.json from before modes with model fable runs as fable mode", async () => {
  const { log, seen, flag } = await fableRun("first piece", { 1: { next: "second" }, 2: { next: "third" }, 3: { next: "STOP: done" } }, { model: "fable" });
  for (const n of [1, 2, 3]) {
    assert.equal(flag(seen(n), "--model"), "fable", `session ${n}`);
    assert.equal(seen(n).settings.fable.effortLevel, "high");
  }
  assert.doesNotMatch(log, /at max/);
});

// Mythos (2026-11-18): Fable's seat under another name. The CLI knows it only by its id, and it draws on
// Fable's weekly allowance, so every Fable rule holds for it and the two share one state (fable.json).
const MYTHOS = "claude-mythos-5-2";
const MM = { mode: "mythos", model: MYTHOS, opusModel: "opus", effort: "high" };
// A session the account cannot run: refused as not found before any turn (claude 2.1.327, `--model mythos`).
const NOT_FOUND = path.join(path.dirname(CHAIN), "fixtures", "session-mythos-word-2026-11-18.jsonl");

test("a MODEL: mythos prompt runs that session as Mythos's id at high, with its own note and no model fallback", async () => {
  const { log, seen, flag, fable } = await fableRun("MODEL: mythos\nhard piece", { 1: { next: "plain piece" }, 2: { next: "STOP: done" } });
  const [one, two] = [seen(1), seen(2)];
  assert.equal(flag(one, "--model"), MYTHOS);
  assert.equal(flag(one, "--effort"), null, "high goes through the settings layer");
  assert.equal(one.settings[MYTHOS].effortLevel, "high", "the level is keyed by the id: a family word is not read for Mythos");
  assert.equal(one.settings.opus.effortLevel, "xhigh");
  assert.equal(one.noFallback, "1");
  assert.match(one.input, /This session runs on Mythos, only for this piece: .* Mythos's weekly allowance is the user's/);
  assert.match(one.input, /keeps MODEL: mythos\)/);
  assert.doesNotMatch(ownLines(one.input, "opus"), /Fable/);
  assert.match(one.input, /\n---\nhard piece\n$/);
  assert.match(log, /session 01 runs Mythos \(claude-mythos-5-2\) at high\n/);
  assert.equal(fable().sessions, 1);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(two.noFallback, null);
  assert.doesNotMatch(two.input, /runs on Mythos/);
  assert.equal(two.settings[MYTHOS].effortLevel, "high", "an Opus session's layer keeps Mythos's level too");
  assert.match(log, /Fable or Mythos on request under 60% of their shared allowance \(2 sessions while unknown\)\n/);
});

test("Fable and Mythos share one allowance: the count, the share and a used-up allowance stop either name", async () => {
  const count = await fableRun("MODEL: fable\nfirst", { 1: { next: "MODEL: mythos\nsecond" }, 2: { next: "MODEL: mythos\nthird" }, 3: { next: "STOP: done" } });
  assert.equal(count.flag(count.seen(1), "--model"), "fable");
  assert.equal(count.flag(count.seen(2), "--model"), MYTHOS);
  assert.equal(count.flag(count.seen(3), "--model"), "opus");
  assert.equal(count.flag(count.seen(3), "--effort"), "max");
  assert.match(count.seen(3).input, /The prompt asked for MODEL: mythos, but Mythos's weekly allowance does not cover it tonight; this piece runs on Opus at max\./);
  assert.match(count.log, /session 03 asked for Mythos, but 2 sessions on its allowance already ran in this chain while the allowance's share is unknown; it runs on Opus at max\n/);
  assert.equal(count.fable().sessions, 2);
  // The cards name the model each line is about, and the allowance as the asked model's.
  const { sessionMessage } = await import("./night-report.mjs");
  const card = (r, nn) => sessionMessage(r.state, nn, process.pid).text;
  assert.match(card(count, "03"), /asked for Mythos, ran on Opus at max \(the chain already ran 2 sessions on Mythos's allowance, the share is unknown\)/);

  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const share = await fableRun("MODEL: mythos\nfirst", { 1: { fable: 0.65, resets, next: "MODEL: fable\nsecond" }, 2: { next: "STOP: done" } });
  assert.equal(share.flag(share.seen(2), "--model"), "opus");
  assert.match(share.log, /session 01 limits: .* · fable 65%→65%/);
  assert.match(share.log, /session 02 asked for Fable, but its allowance is at 65%, at or over the 60% ceiling; it runs on Opus at max\n/);
  assert.match(card(share, "01"), /7d 30% · Mythos 65%/, "a Mythos session's share is Mythos's");
  assert.match(card(share, "02"), /asked for Fable, ran on Opus at max \(Fable's share is 65%, at the 60% ceiling\)/);

  const out = await fableRun("MODEL: mythos\nhard piece", {
    1: { fable: 1, resets, refuse: "model_requires_usage_credits" }, 2: { next: "MODEL: fable\nanother hard piece" }, 3: { next: "STOP: done" } });
  const two = out.seen(2);
  assert.equal(out.flag(two, "--model"), "opus");
  assert.equal(out.flag(two, "--effort"), "max");
  assert.match(two.input, /The previous Mythos session \(01\) was cut off because the Mythos allowance ran out; this piece goes on at Opus max\./);
  assert.match(out.log, /session 01: Mythos's allowance is used up \(model_requires_usage_credits\) until \S+ \S+; limit record null/);
  assert.match(out.log, /session 01's piece goes on in the next session on Opus at max/);
  assert.equal(out.flag(out.seen(3), "--model"), "opus");
  assert.match(out.log, /session 03 asked for Fable, but its allowance is used up until \S+ \S+; it runs on Opus at max\n/);
  assert.match(card(out, "01"), /cut off because Mythos's share ran out; the rest goes on Opus at max/);
  assert.match(card(out, "03"), /asked for Fable, ran on Opus at max \(Fable's share is used up until \S+ \S+\)/);
});

test("--fable-sessions 0: the count refuses the first ask, and the log and the card count 0 sessions", async () => {
  const { state, log, seen, flag } = await fableRun("MODEL: mythos\nhard piece", { 1: { next: "STOP: done" } }, { fableSessions: 0 });
  assert.equal(flag(seen(1), "--model"), "opus");
  assert.equal(flag(seen(1), "--effort"), "max");
  assert.match(log, /\(0 sessions while unknown\)\n/);
  assert.match(log, /session 01 asked for Mythos, but 0 sessions on its allowance already ran in this chain while the allowance's share is unknown; it runs on Opus at max\n/);
  const { sessionMessage } = await import("./night-report.mjs");
  assert.match(sessionMessage(state, "01", process.pid).text, /asked for Mythos, ran on Opus at max \(the chain already ran 0 sessions on Mythos's allowance, the share is unknown\)/);
});

test("opus mode: a Mythos session's card and report name Mythos: its share, its level, and turns on another model", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { state, log } = await fableRun("MODEL: mythos\nhard piece", {
    1: { fable: 0.2, resets, model: MYTHOS, effort: "high", next: "MODEL: mythos\nsecond hard piece" },
    2: { model: "claude-opus-5-5", effort: "high", next: "STOP: done" } });
  assert.match(log, /session 01 runs Mythos \(claude-mythos-5-2\) at high\n/);
  assert.match(log, /session 02 was to run on Mythos, but its turns ran on claude-opus-5-5\n/);
  const { sessionMessage, buildReport } = await import("./night-report.mjs");
  const one = sessionMessage(state, "01", process.pid).text;
  assert.doesNotMatch(one, /should be|Fable/);
  assert.match(one, /7d 30% · Mythos 20%/);
  const two = sessionMessage(state, "02", process.pid).text;
  assert.match(two, /did not run on Mythos: its turns ran on claude-opus-5-5/);
  assert.doesNotMatch(two, /should be/);
  const plain = buildReport(state, { focus: "all", pid: 0 }).plain;
  assert.match(plain, /limit 5h 40%→40% · 7d 30%→30% · Mythos 20%→20%/);
  assert.match(plain, /#01 start 5h 40%  7d 30%  M 20%/);
  assert.match(plain, /resets: .* · Mythos [A-Z][a-z]{2} \d{1,2} \d\d:\d\d/);
  assert.doesNotMatch(plain, /Fable/);
});

test("mythos mode: every session runs on Mythos's id at high, past the count; MODEL: fable stays on it", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { state, log, seen, flag, fable } = await fableRun("MODEL: fable\nfirst piece", {
    1: { fable: 0.2, resets, next: "second" }, 2: { next: "third" }, 3: { next: "STOP: done" } }, { ...MM, fableSessions: 1 });
  for (const n of [1, 2, 3]) {
    const s = seen(n);
    assert.equal(flag(s, "--model"), MYTHOS, `session ${n}`);
    assert.equal(flag(s, "--effort"), null);
    assert.equal(s.settings[MYTHOS].effortLevel, "high");
    assert.equal(s.noFallback, "1");
  }
  assert.ok(seen(1).input.includes(`Mode: mythos.\n${modeText("mythos")}\nSkill folder: `));
  assert.doesNotMatch(seen(1).input, /\*\*Mode (opus|fable)\.\*\*/);
  assert.doesNotMatch(seen(1).input, /only for this piece/);
  assert.match(log, /Mythos as the main model under 60% of its allowance, else opus at xhigh\n/);
  assert.match(log, /session 01: MODEL: fable is the same model as Mythos, this run's main model; it runs on claude-mythos-5-2\n/);
  assert.match(log, /session 01 runs Mythos \(claude-mythos-5-2\) at high\n/);
  assert.equal(fable().sessions, undefined);
  const { sessionMessage } = await import("./night-report.mjs");
  const one = sessionMessage(state, "01", process.pid).text;
  assert.match(one, /MODEL: fable is Mythos under another name, ran on Mythos/);
  assert.match(one, /7d 30% · Mythos 20%/, "the main model's share is named after it");
});

test("mythos mode: at the ceiling, and when the allowance is used up, the session runs on Opus at xhigh and says why", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const ceiling = await fableRun("first piece", { 1: { fable: 0.65, resets, next: "second" }, 2: { next: "STOP: done" } }, MM);
  const two = ceiling.seen(2);
  assert.equal(ceiling.flag(two, "--model"), "opus");
  assert.equal(ceiling.flag(two, "--effort"), null);
  assert.equal(two.settings.opus.effortLevel, "xhigh");
  assert.equal(two.noFallback, null);
  assert.match(two.input, /This run's main model is Mythos, but it cannot run this session: its allowance is at 65%/);
  assert.match(two.input, /goes back to Mythos when it can/);
  assert.doesNotMatch(ownLines(two.input, "mythos"), /\bmax\b|Fable/);
  assert.match(ceiling.log, /session 02: Mythos is the main model, but its allowance is at 65%, at or over the 60% ceiling; it runs on Opus at xhigh\n/);
  const { sessionMessage } = await import("./night-report.mjs");
  const fell = sessionMessage(ceiling.state, "02", process.pid).text;
  assert.match(fell, /Mythos is the main model, but ran on Opus at xhigh \(Mythos's share is 65%, at the 60% ceiling\)/);
  assert.doesNotMatch(fell, /Fable|\bmax\b|should be/);

  const out = await fableRun("hard piece", { 1: { fable: 1, resets, refuse: "model_requires_usage_credits" }, 2: { next: "STOP: done" } }, MM);
  const next = out.seen(2);
  assert.equal(out.flag(next, "--model"), "opus");
  assert.equal(out.flag(next, "--effort"), null);
  assert.doesNotMatch(fs.readFileSync(path.join(out.state, "prompts", "02.md"), "utf8"), /^EFFORT:/m);
  assert.match(next.input, /The previous Mythos session \(01\) was cut off because the Mythos allowance ran out; this piece goes on at Opus xhigh\./);
  assert.match(out.log, /session 01: Mythos's allowance is used up \(model_requires_usage_credits\)/);
  assert.match(out.log, /session 01's piece goes on in the next session on Opus at xhigh/);
  const cut = sessionMessage(out.state, "01", process.pid).text;
  assert.match(cut, /cut off because Mythos's share ran out; the rest goes on Opus at xhigh/);
  assert.match(cut, /Mythos 100%/);
  assert.doesNotMatch(cut, /Fable|\bmax\b/);
});

test("mythos mode at the ceiling: a MODEL line's note names Opus, the model the session runs on, in the log and the card", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { state, log, seen, flag } = await fableRun("MODEL: fable\nfirst piece", { 1: { next: "MODEL: sonnet\nsecond piece" }, 2: { next: "STOP: done" } }, MM,
    (st) => fs.writeFileSync(path.join(st, "fable.json"), JSON.stringify({ ratio: 0.65, ratioResetsAt: resets })));
  for (const n of [1, 2]) assert.equal(flag(seen(n), "--model"), "opus", `session ${n}`);
  assert.match(log, /session 01: MODEL: fable is the same model as Mythos, this run's main model; it runs on opus\n/);
  assert.match(log, /session 02: MODEL: sonnet is not a model the runner runs \(opus, fable, mythos\); it runs on opus\n/);
  assert.match(log, /session 02: Mythos is the main model, but its allowance is at 65%, at or over the 60% ceiling; it runs on Opus at xhigh\n/);
  assert.doesNotMatch(log, /it runs on claude-mythos-5-2/);
  const { sessionMessage } = await import("./night-report.mjs");
  const one = sessionMessage(state, "01", process.pid).text, two = sessionMessage(state, "02", process.pid).text;
  assert.match(one, /MODEL: fable is Mythos under another name, ran on Opus/);
  assert.match(two, /MODEL: sonnet not recognised, ran on Opus/);
  for (const card of [one, two]) assert.doesNotMatch(card, /ran on Mythos/);
});

test("a run.json from before modes with Mythos's id runs as mythos mode", async () => {
  const { seen, flag } = await fableRun("first piece", { 1: { next: "STOP: done" } }, { model: MYTHOS });
  assert.equal(flag(seen(1), "--model"), MYTHOS);
  assert.equal(seen(1).settings[MYTHOS].effortLevel, "high");
  assert.match(seen(1).input, /Mode: mythos\./);
});

// high is Mythos's own level, so only another level shows that the run's and the session's level reach its id.
test("a level other than high reaches Mythos's id: mode mythos at --effort xhigh, and MODEL: mythos with EFFORT: xhigh", async () => {
  const mm = await fableRun("first piece", { 1: { next: "MODEL: opus\nmechanical piece" }, 2: { next: "STOP: done" } }, { ...MM, effort: "xhigh" });
  assert.equal(mm.flag(mm.seen(1), "--model"), MYTHOS);
  assert.equal(mm.seen(1).settings[MYTHOS].effortLevel, "xhigh");
  // On the stand-in only the run's level for its main model keeps the id at xhigh.
  assert.equal(mm.flag(mm.seen(2), "--model"), "opus");
  assert.equal(mm.seen(2).settings[MYTHOS].effortLevel, "xhigh", "the run's level for its main model");
  const asked = await fableRun("MODEL: mythos\nEFFORT: xhigh\nhard piece", { 1: { next: "STOP: done" } });
  assert.equal(asked.flag(asked.seen(1), "--model"), MYTHOS);
  assert.equal(asked.seen(1).settings[MYTHOS].effortLevel, "xhigh", "the session's own level");
  assert.match(asked.log, /session 01 runs Mythos \(claude-mythos-5-2\) at xhigh\n/);
});

test("opus mode: a Mythos session the account cannot run hands its piece to Opus at max, and later asks are refused at the gate", async () => {
  const { state, log, seen, flag, fable } = await fableRun("MODEL: mythos\nhard piece", {
    1: { stream: NOT_FOUND }, 2: { next: "MODEL: mythos\nanother hard piece" }, 3: { next: "MODEL: fable\nfable piece" }, 4: { next: "STOP: done" } });
  assert.equal(flag(seen(1), "--model"), MYTHOS);
  // The piece goes on, on Opus at max, from its own prompt.
  const two = seen(2);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(flag(two, "--effort"), "max");
  assert.match(fs.readFileSync(path.join(state, "prompts", "02.md"), "utf8"), /^EFFORT: max\nThe previous session \(01\) could not run on Mythos: this account cannot run it/);
  assert.match(two.input, /\n\nhard piece\n$/);
  assert.match(log, /session 01: this account cannot run Mythos \(There's an issue with the selected model/);
  assert.match(log, /session 01's piece goes on in the next session on Opus at max\n/);
  assert.match(log, /session 02 runs Opus at max \(its prompt asks for it\)\n/);
  // The next ask is refused at the gate, without another try on Mythos; the finding is said once.
  const three = seen(3);
  assert.equal(flag(three, "--model"), "opus");
  assert.equal(flag(three, "--effort"), "max");
  assert.equal(three.noFallback, null);
  assert.match(three.input, /The prompt asked for MODEL: mythos, but this account cannot run Mythos \(a session on it was refused earlier in this chain\); this piece runs on Opus at max\./);
  assert.match(log, /session 03 asked for Mythos, but this account cannot run it \(found earlier in this chain\); it runs on Opus at max\n/);
  assert.equal((log.match(/this account cannot run Mythos/g) || []).length, 1);
  // Fable is another name the account may run: its gate is not touched, and the failed try is not counted.
  assert.equal(flag(seen(4), "--model"), "fable");
  assert.deepEqual([fable().unavailable, fable().sessions], [["mythos"], 1]);
  assert.match(log, /chain ends: STOP: done/);
  // The cards say it in a few words: the finding on the session that found it, the reason on a later ask.
  const { sessionMessage } = await import("./night-report.mjs");
  assert.match(sessionMessage(state, "01", process.pid).text, /this account cannot run Mythos; MODEL: mythos runs on Opus at max for the rest of the chain/);
  assert.match(sessionMessage(state, "03", process.pid).text, /asked for Mythos, ran on Opus at max \(this account cannot run Mythos, found earlier in this chain\)/);
});

test("opus mode: a resumed Mythos session goes on on Opus at max once the account is found unable to run Mythos", async () => {
  const resumeMythos = (state) => fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "03", sessionId: "fake-3", why: "limit", model: MYTHOS, effort: "high" }));
  // Found earlier in the chain: the resume is moved to Opus at max at the gate, in the same conversation.
  const gated = await fableRun("plain piece", { 3: { next: "STOP: done" } }, {}, (state) => {
    resumeMythos(state);
    fs.writeFileSync(path.join(state, "fable.json"), JSON.stringify({ unavailable: ["mythos"] }));
  });
  const three = gated.seen(3);
  assert.deepEqual([gated.flag(three, "--model"), gated.flag(three, "--effort"), gated.flag(three, "--resume")], ["opus", "max", "fake-3"]);
  assert.match(gated.log, /session 03 asked for Mythos, but this account cannot run it \(found earlier in this chain\); it runs on Opus at max\n/);
  // Found by the resume itself: the piece goes on in a new session, told to look for unfinished work, and nothing is taken off the count.
  const found = await fableRun("plain piece", { 3: { stream: NOT_FOUND }, 4: { next: "STOP: done" } }, {}, resumeMythos);
  assert.equal(found.flag(found.seen(3), "--model"), MYTHOS);
  assert.match(fs.readFileSync(path.join(found.state, "prompts", "04.md"), "utf8"),
    /^EFFORT: max\nThe previous session \(03\) could not run on Mythos: [^\n]* First look at git status and git diff/);
  assert.deepEqual([found.flag(found.seen(4), "--model"), found.flag(found.seen(4), "--effort"), found.flag(found.seen(4), "--resume")], ["opus", "max", null]);
  assert.deepEqual(found.fable(), { unavailable: ["mythos"] });
});

test("mythos mode: a main model the account cannot run ends the chain by name", async () => {
  const { state, log } = await fableRun("first piece", { 1: { stream: NOT_FOUND } }, MM);
  assert.match(log, /chain ends: session 01 cannot run: There's an issue with the selected model/);
  assert.equal(fs.existsSync(path.join(state, "seen-2.json")), false);
});

test("start's model line names the mode, the main model and its stand-in or the premium rule", async () => {
  const { modelLine } = await import("./night-chain.mjs");
  const base = { fableCeiling: 0.6, fableSessions: 2 };
  assert.equal(modelLine({ ...base, mode: "opus", model: "opus", opusModel: "opus", effort: "xhigh" }),
    "  model:  Opus at xhigh (mode opus); MODEL: fable or MODEL: mythos runs one piece at high while their shared weekly allowance is under 60% (at most 2 such sessions while its share is unknown), else on Opus at max");
  assert.equal(modelLine({ ...base, mode: "mythos", model: MYTHOS, opusModel: "opus", effort: "high" }),
    "  model:  Mythos (claude-mythos-5-2) at high (mode mythos); Opus at xhigh while Mythos's weekly allowance is at or over 60% or used up");
  assert.equal(modelLine({ ...base, mode: "fable", model: "fable", opusModel: "claude-opus-5-5", effort: "high", fableCeiling: 0.5 }),
    "  model:  Fable at high (mode fable); Opus (claude-opus-5-5) at xhigh while Fable's weekly allowance is at or over 50% or used up");
});

test("start takes --model mythos or --mode mythos as mode mythos on Mythos's id at high", () => {
  const runOf = (extra) => {
    const c = pointerCase();
    const r = c.run("start", ["--state", c.state, "--allow-dirty", "--prompt", "x", ...extra]);
    assert.match(r.stderr, /launch refused \(test\)/);
    return JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8"));
  };
  for (const extra of [["--model", "mythos"], ["--mode", "mythos"], ["--model", MYTHOS]]) {
    const j = runOf(extra);
    assert.deepEqual([j.mode, j.model, j.opusModel, j.effort], ["mythos", MYTHOS, "opus", "high"], extra.join(" "));
  }
});

test("start works out the mode from --mode, the config and the model, and names a mismatch", () => {
  const runOf = (extra) => {
    const c = pointerCase();
    const r = c.run("start", ["--state", c.state, "--allow-dirty", "--prompt", "x", ...extra]);
    return { ...r, json: r.stderr.includes("launch refused (test)") ? JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")) : undefined };
  };
  const f = runOf(["--model", "fable"]).json;
  assert.deepEqual([f.mode, f.model, f.opusModel, f.effort], ["fable", "fable", "opus", "high"]);
  const s = runOf(["--mode", "fable", "--model", "claude-opus-5-5"]).json;
  assert.deepEqual([s.mode, s.model, s.opusModel], ["fable", "fable", "claude-opus-5-5"]);
  const o = runOf([]).json;
  assert.deepEqual([o.mode, o.model, o.effort], ["opus", "opus", "xhigh"]);
  const bad = runOf(["--mode", "opus", "--model", "fable"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /mode "opus"/);
  assert.doesNotMatch(bad.stderr, /launch refused/);
  const both = runOf(["--mode", "both"]);
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--mode must be one of opus, fable, mythos \(got both\)/);
});

test("a runner in a visible console moves to a hidden one, and puts back the pointer its old parent marks finished", async () => {
  // What an older runner's hand-over starts: `run` without --headless, NIGHT_SHIFT_RELOADED=1,
  // in the old runner's console; the old runner marks the pointer finished once it exits.
  const { state, env, root, home } = setup();
  const fake = path.join(root, "fake-move.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path"; import os from "node:os";
const st = process.env.NIGHT_SHIFT_STATE, dir = path.join(os.homedir(), ".claude", "night-shift", "runs");
const f = path.join(dir, fs.readdirSync(dir)[0]);
fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), finished: true, reason: "reloaded runner exited with 0" }));
let healed = false;
for (let i = 0; i < 90 && !healed; i++) { await new Promise((r) => setTimeout(r, 500)); healed = !JSON.parse(fs.readFileSync(f, "utf8")).finished; }
fs.writeFileSync(path.join(st, "healed.txt"), healed + " " + process.ppid);
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake }));
  const first = await runOnce(["--state", state], { ...env, NIGHT_SHIFT_RELOADED: "1" }, root);
  assert.equal(first.code, 0);
  const log = await waitForLog(state, /chain ends: /);
  assert.match(log, /runner moves to a hidden console/);
  assert.match(log, /chain starts in .* \(runner reloaded\)/);
  assert.equal((log.match(/chain starts/g) || []).length, 1, "only the hidden runner runs the chain");
  const [healed, runner] = fs.readFileSync(path.join(state, "healed.txt"), "utf8").split(" ");
  assert.equal(healed, "true", "the runner must put back a pointer marked finished under it");
  assert.notEqual(Number(runner), first.pid);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(pointerOf(home).finished, true);
  assert.equal(pointerOf(home).pid, Number(runner));
});

test("report: a job resumed after a restart shows its working time and the gap apart", async () => {
  const { buildReport } = await import("./night-report.mjs");
  const { state } = setup();
  const iso = (local) => new Date(local).toISOString();
  fs.writeFileSync(path.join(state, "chain.log"), [
    "[2026-11-01 19:26:17] chain starts in x, until the work is done, from session 35",
    "[2026-11-01 19:26:17] session 35 starts: Zincir 2. Devam.",
    "[2026-11-05 16:36:25] chain starts in x, until the work is done, from session 35",
    "[2026-11-05 16:36:25] session 35 resumes 00000000-0000-4000-8000-000000000035 where the last runner stopped",
    "[2026-11-05 18:53:21] session 35 ends: success, 66 turns, $13.03",
  ].join("\n") + "\n");
  const said = (local, id) => JSON.stringify({ type: "assistant", timestamp: iso(local),
    message: { id, model: "claude-opus-5-5", content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
  fs.writeFileSync(path.join(state, "session-35.jsonl"), [
    JSON.stringify({ type: "system", session_id: "00000000-0000-4000-8000-000000000035", timestamp: iso("2026-11-01T19:26:20") }),
    said("2026-11-01T19:30:00", "a"), said("2026-11-01T21:20:00", "b"),
    said("2026-11-05T16:40:00", "c"), said("2026-11-05T18:53:00", "d"),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "00000000-0000-4000-8000-000000000035" }),
  ].join("\n") + "\n");
  assert.match(buildReport(state, { pid: 0 }).plain, /#35 11-01 19:26–11-05 18:53 · 4 h 11 min \(\+91 h 16 min idle\) · ✅/);
});

// ---------------------------------------------------------------- wait
// The real start (NIGHT_SHIFT_CLAUDE names the stand-in), then wait beside it, as the
// interactive session runs it in the background.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const startChain = (repo, state, env, cwd) =>
  execFileSync(process.execPath, [CHAIN, "start", "--repo", repo, "--state", state, "--prompt", "first"], { env, cwd, encoding: "utf8" });
const waitFor = (repo, env, cwd) => {
  const proc = spawn(process.execPath, [CHAIN, "wait", "--repo", repo], { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  const done = new Promise((resolve, reject) => {
    const t = setTimeout(() => { proc.kill(); reject(new Error(`wait did not exit in 120 s:\n${out}`)); }, 120_000);
    proc.on("exit", (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  return { proc, done };
};

test("wait follows a reload to the next runner, then prints status's first lines and what waits for the user", async () => {
  const { repo, state, env, root } = setup();
  const e = { ...env, NIGHT_SHIFT_CLAUDE: path.join(root, "fake-claude.mjs") };
  startChain(repo, state, e, root);
  const { code, out } = await waitFor(repo, e, root).done;
  assert.equal(code, 0, out);
  const runners = fs.readFileSync(path.join(state, "fake.log"), "utf8").trim().split("\n").map((l) => l.split(" ")[1]);
  assert.equal(runners.length, 2);
  assert.match(out, new RegExp(`runner handed over: pid ${runners[0]} → ${runners[1]}`));
  assert.match(out, /^finished .*: STOP: done$/m);
  assert.match(out, new RegExp(`^state: ${lit(state)}$`, "m"));
  assert.match(out, /Problems\n✅ No problems/);
  // the STOP prompt's own heading gives way to wait's label
  assert.match(out, /\nWaiting for the user:\n1\. \*\*Push\.\*\* 12 local commits\n2\. Physical acceptance/);
  assert.doesNotMatch(out, /the chain crashed/);
  // A chain already over is answered at once; a state that is not the repo's last run is refused.
  assert.match(execFileSync(process.execPath, [CHAIN, "wait", "--repo", repo], { env: e, cwd: root, encoding: "utf8" }), /^finished .*: STOP: done$/m);
  assert.throws(() => execFileSync(process.execPath, [CHAIN, "wait", "--repo", repo, "--state", root], { env: e, cwd: root, stdio: "pipe" }),
    (err) => err.status === 1 && /not this repository's last run/.test(String(err.stderr)));
});

test("a usage-limit wait passes inside the same runner, so wait goes on through it", async () => {
  const { repo, state, env, root } = setup();
  const fake = path.join(root, "fake-limit.mjs");
  // The first call hits the limit, which resets ~6 s from now (the runner adds a minute to resetsAt);
  // the resumed call ends the chain.
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, resumed = process.argv.includes("--resume");
fs.appendFileSync(path.join(st, "fake.log"), (resumed ? "resume " : "first ") + process.ppid + "\\n");
if (resumed) fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify(resumed
  ? { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }
  : { type: "result", subtype: "success", is_error: true, api_error: "usage_limit_reached",
      api_error_params: { rate_limit_info: { resetsAt: Math.floor(Date.now() / 1000) - 54 } }, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "limit" }));
`);
  const e = { ...env, NIGHT_SHIFT_CLAUDE: fake, NIGHT_SHIFT_LIMIT_TICK_MS: "500" };
  startChain(repo, state, e, root);
  const w = waitFor(repo, e, root);
  await waitForLog(state, /usage limit: waiting until/);
  await sleep(2000);
  assert.equal(w.proc.exitCode, null, "wait must not end while the runner waits for the limit");
  const { code, out } = await w.done;
  assert.equal(code, 0, out);
  assert.match(fs.readFileSync(path.join(state, "chain.log"), "utf8"), /session 01 resumes fake-1 after the usage limit/);
  const calls = fs.readFileSync(path.join(state, "fake.log"), "utf8").trim().split("\n").map((l) => l.split(" "));
  assert.deepEqual(calls.map((c) => c[0]), ["first", "resume"]);
  assert.equal(calls[0][1], calls[1][1], "the limit wait and the resumed session run in the same runner");
  assert.doesNotMatch(out, /runner devretti/);
  assert.match(out, /^finished .*: STOP: done$/m);
});

test("a runner that dies without an end line makes wait say the chain crashed, with a non-zero exit", async () => {
  const { repo, state, env, root } = setup();
  const fake = path.join(root, "fake-crash.mjs");
  fs.writeFileSync(fake, `process.kill(process.ppid);
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
  const e = { ...env, NIGHT_SHIFT_CLAUDE: fake };
  startChain(repo, state, e, root);
  const { code, out } = await waitFor(repo, e, root).done;
  assert.equal(code, 2, out);
  assert.match(out, /^the chain crashed: /m);
  assert.doesNotMatch(fs.readFileSync(path.join(state, "chain.log"), "utf8"), /chain ends: /);
  assert.match(out, /session 01 starts: first/, "the end of chain.log is shown");
  assert.match(out, new RegExp(`start --repo "${lit(repo)}" --state "${lit(state)}"`));
});

// ---------------------------------------------------------------- progress
test("report and job card: the progress counts only this run's jobs, from the reports' **Remaining:**", async () => {
  const { buildReport, sessionMessage } = await import("./night-report.mjs");
  const { repo, state } = setup();
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, startedAt: "2026-11-10 12:42:18" }));
  fs.writeFileSync(path.join(state, "chain.log"), [
    "[2026-11-10 00:39:00] chain starts in x, until the work is done, from session 1",
    "[2026-11-10 00:39:00] session 01 starts: Earlier run.",
    "[2026-11-10 03:51:00] session 01 ends: success, 9 turns, $1.00",
    "[2026-11-10 03:51:47] chain ends: STOP: done",
    "[2026-11-10 12:42:18] chain starts in x, until the work is done, from session 5",
    "[2026-11-10 12:42:18] session 05 starts: D3 plan.",
    "[2026-11-10 13:12:18] session 05 ends: success, 25 turns, $11.48",
    "[2026-11-10 13:13:00] session 06 starts: D3a.",
    "[2026-11-10 14:13:00] session 06 ends: success, 129 turns, $9.65",
    "[2026-11-10 14:13:30] session 07 starts: D3b.",
  ].join("\n") + "\n");
  const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "x" });
  for (const nn of ["01", "05", "06"]) fs.writeFileSync(path.join(state, `session-${nn}.jsonl`), `${ok}\n`);
  fs.writeFileSync(path.join(state, "session-07.jsonl"), "");
  fs.writeFileSync(path.join(repo, "NIGHT_RUNS.md"), [
    "## 2026-11-10 · run 4 · session 1 (00:39–03:51) · R65", "**Remaining:** 0", "",
    "## 2026-11-10 · run 5 · session 5 (12:42–13:12) · D3 plan", "**Remaining:** 3 sessions (D3a, D3b, closure)", "",
    "## 2026-11-10 · run 5 · session 6 (13:13–14:13) · D3a", "**Remaining:** 2 sessions", "**Next:** D3b.",
  ].join("\n"));
  // Live, from the real clock: one job left at the mean of 45 min, which late in the evening
  // falls on the next day ("tomorrow ~00:15"; telegram-cards.test.mjs pins the label with a fixed clock).
  assert.match(buildReport(state, { pid: process.pid }).plain, /Running · job 07\/4 · 2\/4 jobs done · estimated end (?:tomorrow )?~\d\d:\d\d · /);
  // A run.json since --max-sessions counts from the start: the line names the last session, not the count.
  const counted = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...counted, maxSessions: 2, lastSession: 8 }));
  assert.match(buildReport(state, { pid: process.pid }).plain, /Running · job 07\/8 · /);
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify(counted));
  // As at the job's end: two left at the mean of 45 min from 14:13.
  assert.match(sessionMessage(state, "06", process.pid).text, /\n📊 2\/4 jobs done · estimated end ~15:45\n/);
});

test("/report's message lists only this run's jobs, each under its report title", async () => {
  const { reportMessage } = await import("./night-report.mjs");
  const { repo, state } = setup();
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, startedAt: "2026-11-10 12:42:18" }));
  fs.writeFileSync(path.join(state, "chain.log"), [
    "[2026-11-10 00:39:00] session 01 starts: Night shift (night-shift). First.",
    "[2026-11-10 03:51:00] session 01 ends: success, 9 turns, $1.00",
    "[2026-11-10 12:42:18] session 05 starts: Night shift (night-shift). First.",
    "[2026-11-10 13:12:18] session 05 ends: success, 25 turns, $11.48",
    "[2026-11-10 13:13:00] session 06 starts: Night shift (night-shift). First.",
  ].join("\n") + "\n");
  const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "x", total_cost_usd: 11.48 });
  for (const nn of ["01", "05"]) fs.writeFileSync(path.join(state, `session-${nn}.jsonl`), `${ok}\n`);
  fs.writeFileSync(path.join(state, "session-06.jsonl"), "");
  fs.writeFileSync(path.join(repo, "NIGHT_RUNS.md"), [
    "## 2026-11-10 · run 5 · session 5 (12:42–13:12) · D3 plan", "**Waits for you**", "- New: none.", "**Remaining:** 3 sessions",
  ].join("\n"));
  const { text } = reportMessage(state, process.pid);
  assert.match(text, /\n✅ #05 D3 plan · 30 min\n⏳ #06 running · /);
  assert.match(text, /📊 1\/4 jobs done · estimated end /);
  assert.doesNotMatch(text, /#01|night-shift\)|Token|Commit/);
});

test("a job's card leaves out night-report commits, by the English phrase and by the one of the run's own table", async () => {
  const { sessionMessage } = await import("./night-report.mjs");
  const { loadLang } = await import("./lang/index.mjs");
  const { repo, state, home } = setup();
  putTable(home);
  setLang(state, "xx");
  assert.equal((await loadLang("xx", home)).error, undefined);
  fs.writeFileSync(path.join(state, "chain.log"), [
    "[2026-11-10 12:00:00] chain starts in x, until the work is done, from session 1",
    "[2026-11-10 12:00:00] session 01 starts: piece",
    "[2026-11-10 13:00:00] session 01 ends: success, 2 turns, $1.00",
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(state, "session-01.jsonl"), JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "x" }) + "\n");
  const commit = (subject, at) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", subject],
    { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } });
  commit("feat: the real work", "2026-11-10T12:30:00");
  commit("docs: xx·report, session 1", "2026-11-10T12:40:00");
  commit("docs: night report, session 1", "2026-11-10T12:50:00");
  assert.match(sessionMessage(state, "01", process.pid).text, /^✅ <b>#01 · feat: the real work<\/b>/);
});

test("a STOP prompt's list loses a line that is only its heading, never an item that starts with the heading's words", async () => {
  const { userWaits } = await import("./night-report.mjs");
  const { loadLang } = await import("./lang/index.mjs");
  const { state, home } = setup();
  putTable(home);
  setLang(state, "xx");
  assert.equal((await loadLang("xx", home)).error, undefined);
  const waits = (body) => { fs.writeFileSync(path.join(state, "next-prompt.md"), `STOP: done\n\n${body}`); return userWaits(state); };
  for (const head of ["**Waits for you**", "## Waits for you:", "Waiting for the user:", "xx·waits:", "**xx·waits**"])
    assert.deepEqual(waits(`${head}\n- a\n- b`), ["- a", "- b"], head);
  assert.deepEqual(waits("- Waiting for the user's decision on X\n- b"), ["- Waiting for the user's decision on X", "- b"]);
  assert.deepEqual(waits("Waiting for the user to merge #12"), ["Waiting for the user to merge #12"]);
  assert.deepEqual(waits("Waits for you to merge #12\n- b"), ["Waits for you to merge #12", "- b"]);
  assert.deepEqual(waits("xx·waits to merge\n- b"), ["xx·waits to merge", "- b"]);
  // a table whose own list label throws still leaves the English headings to match
  putTable(home, "xt", "export default { name: 'Xt', cli: { userWaits: () => { throw new Error('boom'); } } };\n");
  setLang(state, "xt");
  assert.equal((await loadLang("xt", home)).error, undefined);
  assert.deepEqual(waits("**Waits for you**\n- a"), ["- a"]);
});

test("a session its prompt put at max is not flagged for running at max; one at high is", async () => {
  const { sessionMessage } = await import("./night-report.mjs");
  const { state } = setup();
  fs.writeFileSync(path.join(state, "chain.log"), [
    "[2026-11-10 12:00:00] chain starts in x, until the work is done, from session 1",
    "[2026-11-10 12:00:00] session 01 starts: hard piece",
    "[2026-11-10 12:30:00] session 01 ends: success, 2 turns, $1.00",
    "[2026-11-10 12:30:00] session 02 starts: plain piece",
    "[2026-11-10 13:00:00] session 02 ends: success, 2 turns, $1.00",
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(state, "prompts", "01.md"), "EFFORT: max\nhard piece");
  fs.writeFileSync(path.join(state, "prompts", "02.md"), "plain piece");
  const turn = (e) => JSON.stringify({ type: "assistant", perTurnEffort: e, message: { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } });
  const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "x" });
  fs.writeFileSync(path.join(state, "session-01.jsonl"), `${turn("max")}\n${ok}\n`);
  fs.writeFileSync(path.join(state, "session-02.jsonl"), `${turn("high")}\n${ok}\n`);
  assert.doesNotMatch(sessionMessage(state, "01", process.pid).text, /should be/);
  assert.match(sessionMessage(state, "02", process.pid).text, /level high \(should be xhigh\)/);
});

test("an unknown MODEL's card says which model the session ran on: Opus in opus mode, the main model in fable or mythos mode", async () => {
  const { sessionMessage } = await import("./night-report.mjs");
  const cardFor = (patch) => {
    const { state } = setup();
    const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
    fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, ...patch }));
    fs.writeFileSync(path.join(state, "chain.log"), [
      "[2026-11-15 22:00:00] chain starts in x, until the work is done, from session 1",
      "[2026-11-15 22:00:00] session 01 starts: hard piece",
      "[2026-11-15 22:00:00] session 01: MODEL: sonnet is not a model the runner runs (opus, fable); it runs on x",
      "[2026-11-15 22:30:00] session 01 ends: success, 2 turns, $1.00",
    ].join("\n") + "\n");
    return sessionMessage(state, "01", process.pid).text;
  };
  assert.match(cardFor({ lang: "en" }), /MODEL: sonnet not recognised, ran on Opus/);
  assert.match(cardFor({ ...FM, lang: "en" }), /MODEL: sonnet not recognised, ran on Fable/);
  assert.match(cardFor({ ...MM, lang: "en" }), /MODEL: sonnet not recognised, ran on Mythos/);
  assert.match(cardFor({ model: MYTHOS, lang: "en" }), /MODEL: sonnet not recognised, ran on Mythos/, "a run.json from before modes");
});

// chain.log from before 2026-11-18 names only Fable, in shapes the runner no longer writes; old state folders keep them.
test("an old chain.log's Fable lines still give their notes on the cards, in opus mode and in fable mode", async () => {
  const { sessionMessage } = await import("./night-report.mjs");
  const cardsOf = (patch, lines) => {
    const { state } = setup();
    const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
    fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, ...patch }));
    const nnOf = (i) => String(i + 1).padStart(2, "0");
    fs.writeFileSync(path.join(state, "chain.log"), ["[2026-11-15 22:00:00] chain starts in x, until the work is done, from session 1",
      ...lines.flatMap((l, i) => [`[2026-11-15 22:0${i}:00] session ${nnOf(i)} starts: piece`, `[2026-11-15 22:0${i}:10] session ${nnOf(i)}${l}`,
        `[2026-11-15 22:0${i}:30] session ${nnOf(i)} ends: success, 2 turns, $1.00`])].join("\n") + "\n");
    return lines.map((_, i) => sessionMessage(state, nnOf(i), process.pid).text);
  };
  const opus = cardsOf({ lang: "en" }, [
    " asked for Fable, but 2 Fable sessions already ran in this chain while its allowance's share is unknown; it runs on Opus at max",
    " asked for Fable, but its allowance is at 65%, at or over the 60% ceiling; it runs on Opus at max",
    " asked for Fable, but its allowance is used up until 2026-11-18 10:00; it runs on Opus at max",
    ": Fable's allowance is used up (model_requires_usage_credits) until 2026-11-18 10:00; limit record null",
    " was to run on Fable, but the CLI switched it to Opus",
    " wrote a next-prompt.md of 31 KB (over 30 KB): the next session reads all of it on every call",
  ]);
  assert.match(opus[5], /continuation prompt is 31 KB \(over 30 KB; every call reads it again\)/, "the line before 2026-11-19 names its own limit");
  assert.match(opus[0], /asked for Fable, ran on Opus at max \(the chain already ran 2 sessions on Fable's allowance, the share is unknown\)/);
  assert.match(opus[1], /asked for Fable, ran on Opus at max \(Fable's share is 65%, at the 60% ceiling\)/);
  assert.match(opus[2], /asked for Fable, ran on Opus at max \(Fable's share is used up until 2026-11-18 10:00\)/);
  assert.match(opus[3], /cut off because Fable's share ran out; the rest goes on Opus at max/);
  assert.match(opus[4], /did not run on Fable: the CLI switched it to Opus/);
  const fable = cardsOf(FM, [
    ": Fable is the main model, but its allowance is used up until 2026-11-18 10:00; it runs on Opus at xhigh",
    ": Fable's allowance is used up (model_requires_usage_credits) until 2026-11-18 10:00; limit record null",
  ]);
  assert.match(fable[0], /Fable is the main model, but ran on Opus at xhigh \(Fable's share is used up until 2026-11-18 10:00\)/);
  assert.match(fable[1], /cut off because Fable's share ran out; the rest goes on Opus at xhigh/);
});

// The shared allowance is named after the model whose calls reported it: the session's runs line, else its
// prompt (a log from before the runs line), else the run's main model, else Fable; a mixed chain names both.
test("the shared allowance's label: from the runs line, the prompt or the run's mode, and both names in a mixed chain", async () => {
  const { sessionMessage, chainMessage, buildReport } = await import("./night-report.mjs");
  const event = (u) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.4 },
    seven_day: { utilization: 0.3 }, seven_day_overage_included: { utilization: u, resetsAt: 1795300000 } } } });
  const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "x" });
  const chain = (patch, sessions) => {
    const { state } = setup();
    const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
    fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, ...patch }));
    fs.writeFileSync(path.join(state, "chain.log"), ["[2026-11-15 22:00:00] chain starts in x, until the work is done, from session 1",
      ...sessions.flatMap((s, i) => [`[2026-11-15 22:0${i}:00] session 0${i + 1} starts: piece`, ...(s.runs ? [`[2026-11-15 22:0${i}:00] session 0${i + 1} runs ${s.runs}`] : []),
        `[2026-11-15 22:0${i}:30] session 0${i + 1} ends: success, 2 turns, $1.00`])].join("\n") + "\n");
    sessions.forEach((s, i) => {
      fs.writeFileSync(path.join(state, "prompts", `0${i + 1}.md`), s.prompt || "piece");
      fs.writeFileSync(path.join(state, `session-0${i + 1}.jsonl`), `${event(s.share)}\n${ok}\n`);
    });
    return state;
  };
  const card = (state, nn) => sessionMessage(state, nn, process.pid).text;
  // No runs line: the prompt's MODEL says which model ran; a prompt without one falls back to Fable in opus mode.
  assert.match(card(chain({}, [{ prompt: "MODEL: mythos\nhard piece", share: 0.4 }]), "01"), /7d 30% · Mythos 40%/);
  assert.match(card(chain({}, [{ share: 0.4 }]), "01"), /7d 30% · Fable 40%/);
  // A share on a session that ran on the stand-in is the run's main model's.
  assert.match(card(chain(MM, [{ runs: "Opus at xhigh", share: 0.4 }]), "01"), /7d 30% · Mythos 40%/);
  // A chain that ran both names: each session's own, both on what spans the chain.
  const mixed = chain({}, [{ runs: "Fable at high", share: 0.2 }, { runs: "Mythos (claude-mythos-5-2) at high", share: 0.3 }]);
  assert.match(card(mixed, "01"), /7d 30% · Fable 20%/);
  assert.match(card(mixed, "02"), /7d 30% · Mythos 30%/);
  assert.match(chainMessage(mixed, "STOP: done", process.pid).text, /Fable\/Mythos 20%→30%/);
  const plain = buildReport(mixed, { focus: "all", pid: 0 }).plain;
  assert.match(plain, /limit 5h 40%→40% · 7d 30%→30% · Fable\/Mythos 20%→30%/);
  assert.match(plain, /#01 start 5h 40%  7d 30%  F 20%/);
  assert.match(plain, /#02 start 5h 40%  7d 30%  M 30%/);
});

// A table written before the notes named the model: its functions get the name as one more argument, and a note
// that was a string there (now a function) reads English (lang/index.mjs merges by kind).
test("a user table's notes get the model's name, and a note of an older kind reads English", async () => {
  const { sessionMessage } = await import("./night-report.mjs");
  const { loadLang } = await import("./lang/index.mjs");
  const { state, home } = setup();
  putTable(home);
  setLang(state, "xx");
  assert.equal((await loadLang("xx", home)).error, undefined);
  fs.writeFileSync(path.join(state, "chain.log"), [
    "[2026-11-19 01:00:00] chain starts in x, until the work is done, from session 1",
    "[2026-11-19 01:00:00] session 01 starts: hard piece",
    "[2026-11-19 01:00:10] session 01: Mythos's allowance is used up (model_requires_usage_credits) until 2026-11-20 10:00; limit record null",
    "[2026-11-19 01:30:00] session 01 ends: success, 2 turns, $1.00",
    "[2026-11-19 01:30:00] session 02 starts: hard piece",
    "[2026-11-19 01:30:00] session 02 asked for Mythos, but its allowance is used up until 2026-11-20 10:00; it runs on Opus at max",
    "[2026-11-19 02:00:00] session 02 ends: success, 2 turns, $1.00",
  ].join("\n") + "\n");
  assert.match(sessionMessage(state, "01", process.pid).text, /cut off because Mythos's share ran out/);
  assert.match(sessionMessage(state, "02", process.pid).text, /xx·asked Mythos \(Mythos's share is used up until 2026-11-20 10:00\)/);
});

test("a Fable session at high is not flagged, an Opus one at high is, and the cards show Fable's share", async () => {
  const { sessionMessage, buildReport } = await import("./night-report.mjs");
  const { state } = setup();
  fs.writeFileSync(path.join(state, "chain.log"), [
    "[2026-11-15 22:00:00] chain starts in x, until the work is done, from session 1",
    "[2026-11-15 22:00:00] session 01 starts: hard piece",
    "[2026-11-15 22:00:00] session 01 runs Fable at high",
    "[2026-11-15 22:30:00] session 01 ends: success, 2 turns, $1.00",
    "[2026-11-15 22:30:00] session 02 starts: plain piece",
    "[2026-11-15 22:30:00] session 02 runs Opus at xhigh",
    "[2026-11-15 23:00:00] session 02 ends: success, 2 turns, $1.00",
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(state, "prompts", "01.md"), "MODEL: fable\nhard piece");
  fs.writeFileSync(path.join(state, "prompts", "02.md"), "plain piece");
  const turn = (e, model) => JSON.stringify({ type: "assistant", perTurnEffort: e, message: { model, usage: { input_tokens: 1, output_tokens: 1 }, content: [] } });
  const event = (w) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: w } });
  const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "x" });
  fs.writeFileSync(path.join(state, "session-01.jsonl"), [event({ five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.3 },
    seven_day_overage_included: { utilization: 0.25, resetsAt: 1795300000 } }), turn("high", "claude-fable-5-2"), ok].join("\n") + "\n");
  fs.writeFileSync(path.join(state, "session-02.jsonl"), [event({ five_hour: { utilization: 0.45 }, seven_day: { utilization: 0.31 } }),
    turn("high", "claude-opus-5-5"), ok].join("\n") + "\n");
  const one = sessionMessage(state, "01", process.pid).text;
  assert.doesNotMatch(one, /should be/);
  assert.match(one, /7d 30% · Fable 25%/);
  assert.match(sessionMessage(state, "02", process.pid).text, /level high \(should be xhigh\)/);
  assert.doesNotMatch(sessionMessage(state, "02", process.pid).text, /Fable %/);
  const plain = buildReport(state, { focus: "all", pid: 0 }).plain;
  assert.match(plain, /limit 5h 40%→40% · 7d 30%→30% · Fable 25%→25%/);
  assert.match(plain, /#01 start 5h 40%  7d 30%  F 25%/);
  assert.match(plain, /resets: .* · Fable [A-Z][a-z]{2} \d{1,2} \d\d:\d\d/);
});

test("a Telegram request that never answers gives up after its own timeout", { timeout: 15_000 }, async () => {
  const http = await import("node:http");
  const server = http.createServer(() => {});
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  process.env.NIGHT_SHIFT_TELEGRAM_API = `http://127.0.0.1:${server.address().port}`;
  try {
    const { telegram } = await import("./night-report.mjs");
    const t = Date.now();
    await assert.rejects(telegram("getUpdates", { token: "x" }, { timeout: 1 }, { graceMs: 500 }));
    assert.ok(Date.now() - t < 5_000, `${Date.now() - t} ms`);
  } finally {
    delete process.env.NIGHT_SHIFT_TELEGRAM_API;
    server.closeAllConnections();
    server.close();
  }
});

// ---------------------------------------------------------------- the 2026-11-15 security review
test("a session that rewrites night-settings.json does not take the guard from the next one", async () => {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-settings.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = Number(process.env.NIGHT_SHIFT_SESSION), f = path.join(st, "night-settings.json");
if (n === 1) { fs.writeFileSync(f, JSON.stringify({ env: { KEPT: "1" }, hooks: {} })); fs.writeFileSync(path.join(st, "next-prompt.md"), "second"); }
else if (n === 2) { fs.copyFileSync(f, path.join(st, "seen-2.json")); fs.writeFileSync(f, "not json"); fs.writeFileSync(path.join(st, "next-prompt.md"), "third"); }
else { fs.copyFileSync(f, path.join(st, "seen-3.json")); fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done"); }
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake }));
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  assert.equal(code, 0, fs.readFileSync(path.join(state, "chain.log"), "utf8"));
  const seen = (n) => JSON.parse(fs.readFileSync(path.join(state, `seen-${n}.json`), "utf8"));
  assert.match(seen(2).hooks.PreToolUse[0].hooks[0].args[0], /guard\.mjs$/);
  assert.equal(seen(2).hooks.PreToolUse[0].hooks[0].onFailure, "block");
  assert.equal(seen(2).env.KEPT, "1", "what was added by hand stays");
  assert.equal(seen(2).env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.match(seen(3).hooks.PreToolUse[0].hooks[0].args[0], /guard\.mjs$/, "a settings file broken by a session is written anew");
});

test("the settings layer is rebuilt without what a session could have slipped into it", async () => {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-slip.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
fs.writeFileSync(path.join(process.env.NIGHT_SHIFT_STATE, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake }));
  fs.writeFileSync(path.join(state, "night-settings.json"), JSON.stringify({ disableAllHooks: true,
    env: { NIGHT_SHIFT_STATE: "C:/", node_options: "--require y", NODE_OPTIONS: "--require x", KEEP: "1" }, hooks: { PreToolUse: [] } }));
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  assert.equal(code, 0, fs.readFileSync(path.join(state, "chain.log"), "utf8"));
  const s = JSON.parse(fs.readFileSync(path.join(state, "night-settings.json"), "utf8"));
  assert.equal(s.disableAllHooks, false);
  assert.deepEqual(Object.keys(s.env).sort(), ["CLAUDE_CODE_SUBAGENT_MODEL", "KEEP"]);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].onFailure, "block");
});

test("psQuote doubles every character PowerShell reads as a single quote", async () => {
  const { psQuote } = await import("./night-chain.mjs");
  assert.equal(psQuote("C:\temp\it's"), "'C:\temp\it''s'");
  assert.equal(psQuote("x\u2019; calc; \u2018y"), "'x\u2019\u2019; calc; \u2018\u2018y'");
  assert.equal(psQuote("a\u201Ab\u201Bc"), "'a\u201A\u201Ab\u201B\u201Bc'");
});

test("stop --now leaves a process alone that only has the dead runner's pid", { timeout: 60_000 }, async () => {
  const { home, repo, state, env, root } = setup();
  const crypto = await import("node:crypto");
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    const dir = path.join(home, ".claude", "night-shift", "runs");
    fs.mkdirSync(dir, { recursive: true });
    const slug = `${path.basename(repo)}-${crypto.createHash("sha1").update(repo.toLowerCase()).digest("hex").slice(0, 8)}`;
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({ pid: other.pid, state, finished: false, startedAt: "test" }));
    const out = execFileSync(process.execPath, [CHAIN, "stop", "--repo", repo, "--now"], { env, cwd: root, encoding: "utf8" });
    assert.match(out, /already gone/);
    assert.ok(alive(other.pid), "the other program must still run");
    assert.equal(pointerOf(home).finished, true);
  } finally { other.kill(); }
});

test("telegram-setup names the chat it saves and never picks between two", async () => {
  const { privateChats, chooseChat } = await import("./night-report.mjs");
  const chat = (id, first_name, username) => ({ message: { chat: { id, type: "private", first_name, username } } });
  const mine = chat(11, "Ada", "ada"), stranger = chat(22, "Mallory");
  assert.deepEqual(privateChats([stranger, mine, mine, { message: { chat: { id: -5, type: "group" } } }]),
    [{ id: 11, name: "Ada @ada" }, { id: 22, name: "Mallory" }]);
  assert.deepEqual(chooseChat({}, [mine]), { chatId: 11, lines: ["chat: 11 (Ada @ada); the reports go there"] });
  const two = chooseChat({}, [stranger, mine]);
  assert.equal(two.chatId, null);
  assert.match(two.lines.join("\n"), /more than one chat[\s\S]*11 {2}Ada @ada[\s\S]*22 {2}Mallory/);
  assert.equal(chooseChat({}, [stranger, mine], "11").chatId, 11);
  assert.equal(chooseChat({}, [stranger, mine], "33").chatId, null);
  assert.equal(chooseChat({}, []).chatId, null);
  assert.match(chooseChat({ chatId: 11 }, []).lines[0], /still go to 11/);
});

// The limit path: a stand-in that prints a limit (the rejected rate-limit event and the result line
// an empty-handed or handed-over session ends on) and exits 1. `reset` is epoch seconds.
const LIMIT_LINES = `const limit = (reset) => {
  console.log(JSON.stringify({ type: "rate_limit_event", session_id: "fake-1", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: reset } }));
  console.log(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, api_error: "usage_limit_reached", num_turns: 9, total_cost_usd: 1, session_id: "fake-1", result: "limit" }));
  process.exit(1);
};
const ok = (n) => console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`;
// Writes the stand-in over setup()'s fake-claude.mjs and runs the chain with short ticks.
async function limitRun(body, runPatch = {}) {
  const s = setup();
  fs.writeFileSync(path.join(s.root, "fake-claude.mjs"), `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = Number(process.env.NIGHT_SHIFT_SESSION), resumed = process.argv.includes("--resume");
${LIMIT_LINES}${body}`);
  const run = JSON.parse(fs.readFileSync(path.join(s.state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(s.state, "run.json"), JSON.stringify({ ...run, maxSessions: null, ...runPatch }));
  const env = { ...s.env, NIGHT_SHIFT_LIMIT_TICK_MS: "50", NIGHT_SHIFT_BACKOFF_MS: "50" };
  await runOnce(["--state", s.state, "--headless"], env, s.root);
  return { ...s, log: await waitForLog(s.state, /chain ends: /) };
}

test("a limit after the handover starts the next session at the reset, with no recovery note", async () => {
  const { state, log } = await limitRun(`
if (n === 1) { fs.writeFileSync(path.join(st, "next-prompt.md"), "second piece"); limit(Math.floor(Date.now() / 1000) - 300); }
else { fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done"); ok(n); }
`);
  assert.match(log, /chain ends: STOP: done/);
  assert.match(log, /session 01: the limit cut it off after its handover; session 02 starts when it resets/);
  assert.match(log, /session 02 starts: second piece/);
  assert.doesNotMatch(log, /resumes|left no continuation prompt/);
  assert.equal(fs.existsSync(path.join(state, "resume.json")), false);
  assert.equal(fs.readFileSync(path.join(state, "prompts", "02.md"), "utf8"), "second piece");
});

test("a reset farther away than --max-wait-hours ends the chain and keeps the session to resume", async () => {
  const { state, home, log } = await limitRun(`limit(Math.floor(Date.now() / 1000) + 3 * 86400);`);
  assert.match(log, /chain ends: the usage limit resets \d{4}-\d\d-\d\d \d\d:\d\d, more than 6 h away \(--max-wait-hours\)/);
  assert.doesNotMatch(log, /usage limit: waiting/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, "resume.json"), "utf8")).sessionId, "fake-1");
  assert.equal(pointerOf(home).finished, true);
});

test("a reset after --until ends the chain instead of waiting for nothing", async () => {
  const { log } = await limitRun(`limit(Math.floor(Date.now() / 1000) + 2 * 3600);`, { until: "09:00", deadline: Date.now() + 3_600_000 });
  assert.match(log, /chain ends: the usage limit resets \d{4}-\d\d-\d\d \d\d:\d\d, after 09:00/);
  assert.doesNotMatch(log, /usage limit: waiting/);
});

test("a resumed session is judged by what it wrote, not by the limit before it", async () => {
  // The first fresh call hits the limit; the resumed call exits 1 with no output; a later fresh call finishes.
  const { log } = await limitRun(`
const hit = path.join(st, "hit");
if (resumed) process.exit(1);
if (!fs.existsSync(hit)) { fs.writeFileSync(hit, "1"); limit(Math.floor(Date.now() / 1000) - 300); }
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done"); ok(n);
`);
  assert.equal((log.match(/usage limit: waiting/g) || []).length, 1);
  assert.match(log, /chain ends: STOP: done/);
});

test("a session that wrote STOP and was then cut off by a limit ends the chain at once, without waiting for the reset", async () => {
  const { log } = await limitRun(`fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done"); limit(Math.floor(Date.now() / 1000) + 2 * 3600);`,
    { until: "09:00", deadline: Date.now() + 6 * 3_600_000 });
  assert.match(log, /chain ends: STOP: done/);
  assert.doesNotMatch(log, /usage limit: waiting/);
});

// The error path: each stand-in call appends "<session> <--resume value or ->" to calls.log. `call` is
// the 1-based number of this call, whatever its session.
const ERROR_LINES = `const calls = path.join(st, "calls.log"), rid = process.argv.includes("--resume") ? process.argv[process.argv.indexOf("--resume") + 1] : "-";
fs.appendFileSync(calls, n + " " + rid + "\\n");
const call = fs.readFileSync(calls, "utf8").trim().split("\\n").length;
const apiError = () => {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, num_turns: 0, total_cost_usd: 0, result: "API Error: 500 Internal server error" }));
  process.exit(1);
};
const stop = () => { fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done"); ok(n); };
`;
async function errorRun(body, runPatch = {}) {
  const s = setup();
  fs.writeFileSync(path.join(s.root, "fake-claude.mjs"), `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = Number(process.env.NIGHT_SHIFT_SESSION);
${LIMIT_LINES}${ERROR_LINES}${body}`);
  const run = JSON.parse(fs.readFileSync(path.join(s.state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(s.state, "run.json"), JSON.stringify({ ...run, maxSessions: null, ...runPatch }));
  const env = { ...s.env, NIGHT_SHIFT_LIMIT_TICK_MS: "20", NIGHT_SHIFT_BACKOFF_MS: "50" };
  await runOnce(["--state", s.state, "--headless"], env, s.root);
  const log = await waitForLog(s.state, /chain ends: /);
  const calls = fs.readFileSync(path.join(s.state, "calls.log"), "utf8").trim().split("\n");
  return { ...s, log, calls };
}

test("two API errors in a row are waited out and the same piece runs again", async () => {
  const { log, calls } = await errorRun(`if (call <= 2) apiError(); stop();`);
  assert.match(log, /session 01: transient error \(API Error: 500 Internal server error\); try 1, waiting until \d{4}-\d\d-\d\d \d\d:\d\d/);
  assert.match(log, /try 2, waiting until/);
  assert.match(log, /chain ends: STOP: done/);
  assert.doesNotMatch(log, /left no continuation prompt|two sessions in a row/);
  assert.deepEqual(calls, ["1 -", "1 -", "1 -"]);
});

test("a session that worked before the error goes on in the same conversation", async () => {
  const { state, log, calls } = await errorRun(`
if (call === 1) {
  console.log(JSON.stringify({ type: "assistant", session_id: "fake-1", parent_tool_use_id: null, message: { model: "claude-opus-5-5", content: [] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error: "overloaded_error", api_error_status: 529, num_turns: 4, total_cost_usd: 0, session_id: "fake-1", result: "Overloaded" }));
  process.exit(1);
}
let input = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "stdin-2.txt"), input);
stop();
`);
  assert.match(log, /session 01: transient error \(Overloaded\); try 1/);
  assert.match(log, /session 01 resumes fake-1 after the error/);
  assert.match(fs.readFileSync(path.join(state, "stdin-2.txt"), "utf8"), /^A connection or API error has passed \(night shift, /);
  assert.deepEqual(calls, ["1 -", "1 fake-1"]);
  assert.match(log, /chain ends: STOP: done/);
});

test("a network failure with no result line is transient too", async () => {
  const { log } = await errorRun(`
if (call === 1) { console.error("Error: getaddrinfo ENOTFOUND api.anthropic.com"); process.exit(1); }
stop();
`);
  assert.match(log, /transient error \(Error: getaddrinfo ENOTFOUND api\.anthropic\.com\); try 1/);
  assert.match(log, /chain ends: STOP: done/);
});

test("a refused login ends the chain at once, by name", async () => {
  const { log, calls } = await errorRun(`
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 401, num_turns: 0, total_cost_usd: 0, result: "Invalid API key · Please run /login" }));
process.exit(1);
`);
  assert.match(log, /chain ends: session 01 cannot run: Invalid API key · Please run \/login/);
  assert.equal(calls.length, 1);
});

test("errors that outlast --max-wait-hours end the chain", async () => {
  const { log } = await errorRun(`apiError();`, { maxWaitHours: 0.0001 });
  assert.match(log, /chain ends: session 01 kept failing for <0\.01 h \(API Error: 500 Internal server error\)/);
});

// A session that had a turn and then met an API error: resume.json is written, and the next call resumes it.
const WORKED_THEN_ERROR = `if (call === 1) {
  console.log(JSON.stringify({ type: "assistant", session_id: "fake-1", parent_tool_use_id: null, message: { model: "claude-opus-5-5", content: [] } }));
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error: "overloaded_error", api_error_status: 529, num_turns: 4, total_cost_usd: 0, session_id: "fake-1", result: "Overloaded" }));
  process.exit(1);
}
`;

test("an outage that outlasts two resumes keeps the conversation and counts no failed handover", async () => {
  const { log, calls } = await errorRun(WORKED_THEN_ERROR + `if (call <= 4) apiError(); stop();`);
  assert.deepEqual(calls, ["1 -", "1 fake-1", "1 fake-1", "1 fake-1", "1 fake-1"]);
  assert.match(log, /session 01 resumes fake-1 after the error/);
  assert.doesNotMatch(log, /left no continuation prompt|two sessions in a row/);
  assert.match(log, /chain ends: STOP: done/);
});

test("a conversation that cannot be resumed is given up after two tries, without counting a failed handover", async () => {
  const { log, calls } = await errorRun(WORKED_THEN_ERROR + `
if (call <= 3) { console.error("No conversation found with session ID: fake-1"); process.exit(1); }
if (call === 4) ok(n); else stop();
`);
  // Two dead resumes, then a fresh session that ends without a handover (the one failure), then one that finishes.
  assert.deepEqual(calls, ["1 -", "1 fake-1", "1 fake-1", "2 -", "3 -"]);
  assert.doesNotMatch(log, /two sessions in a row/);
  assert.match(log, /chain ends: STOP: done/);
});

test("an error streak does not survive a usage-limit wait", async () => {
  // Errors from call 1 on build a 2 s streak, call 3 meets a limit that resets about 3 s on, call 4 errs
  // again: the limit wait must not count toward the 4 s (--max-wait-hours) the streak may last.
  const { log, calls } = await errorRun(`
if (call === 1) apiError();
if (call === 2) { await new Promise((r) => setTimeout(r, 2000)); apiError(); }
if (call === 3) limit(Math.floor(Date.now() / 1000) - 57);
if (call === 4) apiError();
stop();
`, { maxWaitHours: 0.0011 });
  assert.doesNotMatch(log, /kept failing/);
  assert.equal(calls.length, 5);
  assert.match(log, /chain ends: STOP: done/);
});

test("a claude that cannot be started is retried, not a silent death", async () => {
  const s = setup();
  const run = JSON.parse(fs.readFileSync(path.join(s.state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(s.state, "run.json"), JSON.stringify({ ...run, maxSessions: null, maxWaitHours: 0.0001, claude: path.join(s.root, "gone", "claude.exe") }));
  await runOnce(["--state", s.state, "--headless"], { ...s.env, NIGHT_SHIFT_LIMIT_TICK_MS: "20", NIGHT_SHIFT_BACKOFF_MS: "50" }, s.root);
  const log = await waitForLog(s.state, /chain ends: /);
  assert.match(log, /session 01: transient error \(claude could not start: ENOENT\); try 1/);
  assert.match(log, /chain ends: session 01 kept failing/);
});

test("a session that hangs past --session-hours is logged as a timeout", async () => {
  const { log } = await limitRun(`await new Promise((r) => setTimeout(r, 60_000));`, { sessionHours: 0.0005, maxSessions: 1 });
  assert.match(log, /session 01 ends: killed after 0\.0005 h \(--session-hours\)/);
});

test("a runner that crashes writes why into chain.log and marks the run finished", async () => {
  const { state, env, home, root } = setup();
  // runChain reads this folder unguarded.
  fs.rmSync(path.join(state, "prompts"), { recursive: true });
  await runOnce(["--state", state, "--headless"], env, root);
  const log = await waitForLog(state, /chain ends: /);
  assert.match(log, /chain ends: the runner crashed: ENOENT/);
  assert.equal(pointerOf(home).finished, true);
});

// Pointer liveness: a throwaway home, and a launch that fails, so a start that gets past the check
// ends with "launch refused (test)" and no scheduled task exists.
function pointerCase(ptrOf) {
  const { root, home, repo, state, env } = setup();
  const slug = `${path.basename(repo)}-${crypto.createHash("sha1").update(repo.toLowerCase()).digest("hex").slice(0, 8)}`;
  const file = path.join(home, ".claude", "night-shift", "runs", `${slug}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = (p) => fs.writeFileSync(file, JSON.stringify({ state, task: "x", finished: false, ...p }));
  const run = (cmd, extra = [], more = {}) => spawnSync(process.execPath, [CHAIN, cmd, "--repo", repo, ...extra],
    { env: { ...env, NIGHT_SHIFT_LAUNCH: "fail", NIGHT_SHIFT_CLAUDE: process.execPath, TEMP: root, TMP: root, ...more }, encoding: "utf8", cwd: root });
  return { write, run, state, repo, home, read: () => JSON.parse(fs.readFileSync(file, "utf8")) };
}
const stamped = (ms) => new Date(ms).toLocaleString("sv-SE");

test("a pointer whose runner never came up does not block start for ever", () => {
  const c = pointerCase();
  c.write({ pid: 0, scheduledAt: "2026-01-01 00:00:00" });
  assert.match(c.run("start", ["--prompt", "x"]).stderr, /launch refused \(test\)/);
  c.write({ pid: 0, scheduledAt: stamped(Date.now()) });
  assert.match(c.run("start", ["--prompt", "x"]).stderr, /a run was scheduled \d+ s ago and its runner has not come up yet; wait, or run stop/);
});

test("stop clears a pointer whose runner never started or is gone", () => {
  const c = pointerCase();
  c.write({ pid: 0, scheduledAt: stamped(Date.now()) });
  assert.match(c.run("stop").stdout, /its runner never started; marked finished/);
  assert.equal(c.read().finished, true);
  assert.equal(c.read().reason, "its runner never started");
  assert.ok(fs.existsSync(path.join(c.state, "STOP-REQUEST")));
  const gone = spawnSync(process.execPath, ["-e", ""]);
  c.write({ pid: gone.pid || 2_000_000_000, scheduledAt: stamped(Date.now()) });
  assert.match(c.run("stop").stdout, /the runner was already gone/);
  assert.equal(c.read().finished, true);
});

test("a pid that now belongs to another program does not block start", () => {
  const c = pointerCase();
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    c.write({ pid: other.pid, scheduledAt: stamped(Date.now()) });
    assert.match(c.run("start", ["--prompt", "x"]).stderr, /launch refused \(test\)/);
  } finally { other.kill(); }
});

// start reads .claude/night-shift.json through config.mjs: a mistake is named, not thrown.
function startWithConfig(cfg, extra = ["--prompt", "x"]) {
  const c = pointerCase();
  fs.mkdirSync(path.join(c.repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(c.repo, ".claude", "night-shift.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  return { ...c, result: c.run("start", extra) };
}

test("start names what is wrong in .claude/night-shift.json instead of a stack trace", () => {
  const broken = startWithConfig('{ "report": "docs/N.md", }').result.stderr;
  assert.match(broken, /\.claude[\\/]night-shift\.json: .*not valid JSON/);
  assert.doesNotMatch(broken, /at JSON\.parse/);
  assert.match(startWithConfig({ modle: "fable" }).result.stderr, /unknown key "modle"/);
  assert.match(startWithConfig({ stateDir: "C:/" }).result.stderr, /stateDir/);
});

test("start refuses a state folder that already holds something else", () => {
  const c = pointerCase();
  const other = path.join(path.dirname(c.state), "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "notes.txt"), "mine");
  fs.mkdirSync(path.join(c.repo, ".claude"));
  fs.writeFileSync(path.join(c.repo, ".claude", "night-shift.json"), JSON.stringify({ stateDir: other }));
  c.result = c.run("start", ["--prompt", "x"]);
  assert.match(c.result.stderr, /is not empty and holds no earlier run/);
  assert.ok(fs.existsSync(path.join(other, "notes.txt")));
  assert.ok(!fs.existsSync(path.join(other, "prompts")));
});

test("start builds the default state folder from the temp folder in long form, so the guard accepts it", () => {
  // A directory junction named like an 8.3 name stands in for a TEMP written in short form.
  const { root, home, repo, env } = setup();
  const long = path.join(root, "LongTempFolderName"), link = path.join(root, "LONGUS~1");
  fs.mkdirSync(long);
  fs.symlinkSync(long, link, "junction");
  const r = spawnSync(process.execPath, [CHAIN, "start", "--repo", repo, "--prompt", "x"],
    { env: { ...env, NIGHT_SHIFT_LAUNCH: "fail", NIGHT_SHIFT_CLAUDE: process.execPath, TEMP: link, TMP: link }, encoding: "utf8", cwd: root });
  assert.match(r.stderr, /launch refused \(test\)/);
  const made = fs.readdirSync(long).filter((f) => f.startsWith("night-shift-"));
  assert.equal(made.length, 1, r.stderr);
  const run = JSON.parse(fs.readFileSync(path.join(long, made[0], "run.json"), "utf8"));
  assert.ok(!run.state.includes("~"), run.state);
  assert.equal(run.state.toLowerCase(), fs.realpathSync.native(path.join(long, made[0])).toLowerCase());
});

// C4: an answer with only api_error_status (no api_error, no "API Error" text) is an outage too.
test("a dead resume that carries only an API status is waited out, not given up", async () => {
  const { log, calls } = await errorRun(WORKED_THEN_ERROR + `
if (call <= 4) {
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 529, num_turns: 0, total_cost_usd: 0, result: "Overloaded" }));
  process.exit(1);
}
stop();
`);
  assert.deepEqual(calls, ["1 -", "1 fake-1", "1 fake-1", "1 fake-1", "1 fake-1"]);
  assert.doesNotMatch(log, /left no continuation prompt|two sessions in a row/);
  assert.match(log, /chain ends: STOP: done/);
});

// C5: status shows "running" only for a live process that is a night-chain runner.
test("status does not show a pointer as running when its pid now belongs to another program", () => {
  const c = pointerCase();
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  // The same kind of process, but with the runner's file name on its command line.
  const runner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "night-chain.mjs"], { stdio: "ignore" });
  try {
    c.write({ pid: other.pid, startedAt: stamped(Date.now()) });
    assert.doesNotMatch(c.run("status").stdout, /^running/);
    c.write({ pid: runner.pid, startedAt: stamped(Date.now()) });
    assert.match(c.run("status").stdout, /^running \(pid \d+\)/);
  } finally { other.kill(); runner.kill(); }
});

// C6: a command-line --max-wait-hours that is not a positive number stops start; otherwise it wins over the config's, then 6.
const maxWaitOf = (cfg, extra) => {
  const c = pointerCase();
  fs.mkdirSync(path.join(c.repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(c.repo, ".claude", "night-shift.json"), JSON.stringify(cfg));
  const r = c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty", ...extra]);
  return { ...r, wait: r.stderr.includes("launch refused (test)") ? JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")).maxWaitHours : undefined };
};

test("start refuses a --max-wait-hours that is not a positive number, even with a good one in the config", () => {
  for (const extra of [["--max-wait-hours"], ["--max-wait-hours", "0"], ["--max-wait-hours", "-2"], ["--max-wait-hours", "abc"]]) {
    const r = maxWaitOf({ maxWaitHours: 3 }, extra);
    assert.equal(r.status, 1, extra.join(" "));
    assert.match(r.stderr, /--max-wait-hours .*positive number/, extra.join(" "));
    assert.doesNotMatch(r.stderr, /launch refused/);
  }
});

test("start takes --max-wait-hours from the command line, else the config, else 6", () => {
  assert.equal(maxWaitOf({ maxWaitHours: 3 }, ["--max-wait-hours", "1.5"]).wait, 1.5);
  assert.equal(maxWaitOf({ maxWaitHours: 3 }, []).wait, 3);
  assert.equal(maxWaitOf({}, []).wait, 6);
});

// The language: --lang, else the project file, else the global file (under the case's home), else en.
// table: the user's xx table in the case's home (the made-up one when true, this text, or none when false).
const langOf = ({ global, project, table = true }, extra = []) => {
  const c = pointerCase();
  if (table) putTable(c.home, "xx", table === true ? undefined : table);
  const write = (file, cfg) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg)); };
  if (global) write(path.join(c.home, ".claude", "night-shift", "config.json"), global);
  if (project) write(path.join(c.repo, ".claude", "night-shift.json"), project);
  const r = c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty", ...extra]);
  return { ...r, lang: r.stderr.includes("launch refused (test)") ? JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")).lang : undefined };
};

test("start takes the language from --lang, else the project file, else the global file, else en", () => {
  assert.equal(langOf({ global: { lang: "xx" } }).lang, "xx");
  assert.equal(langOf({ global: { lang: "xx" }, project: { lang: "en" } }).lang, "en");
  assert.equal(langOf({ global: { lang: "en" }, project: { lang: "en" } }, ["--lang", "xx"]).lang, "xx");
  assert.equal(langOf({}).lang, "en");
  assert.equal(langOf({ table: false }).lang, "en", "en needs no table");
});

test("start refuses a language code of the wrong shape, on the command line or in a file", () => {
  for (const v of ["XX", "xx-XX", "Deutsch", "../xx"]) {
    const r = langOf({}, ["--lang", v]);
    assert.equal(r.status, 1, v);
    assert.match(r.stderr, /--lang must be a language code in lowercase, such as en or pt-br \(got /, v);
    assert.doesNotMatch(r.stderr, /launch refused/);
  }
  const noValue = langOf({}, ["--lang"]);
  assert.equal(noValue.status, 1);
  assert.match(noValue.stderr, /--lang must be a language code .*\(got no value\)/);
  const g = langOf({ global: { lang: "xx-XX" } });
  assert.equal(g.status, 1);
  assert.match(g.stderr, /config.json: "lang" must be a language code in lowercase/);
  assert.match(g.stderr, /.claude[\\/]night-shift[\\/]config.json/);
  assert.doesNotMatch(g.stderr, /launch refused/);
  const p = langOf({ project: { lang: "Deutsch" } });
  assert.equal(p.status, 1);
  assert.match(p.stderr, /night-shift.json: "lang" must be a language code in lowercase/);
});

test("start refuses a language whose table is missing or does not load, and names the file", () => {
  const flag = langOf({ table: false }, ["--lang", "xx"]);
  assert.equal(flag.status, 1);
  assert.match(flag.stderr, /--lang xx: no language table at .*\.claude[\\/]night-shift[\\/]lang[\\/]xx\.mjs/);
  assert.doesNotMatch(flag.stderr, /launch refused/);
  const g = langOf({ global: { lang: "yy" } });
  assert.equal(g.status, 1);
  assert.match(g.stderr, /lang yy from .*config\.json: no language table at .*lang[\\/]yy\.mjs/);
  const broken = langOf({ table: "export default {,};\n" }, ["--lang", "xx"]);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /--lang xx: .*xx\.mjs does not load: /);
  assert.doesNotMatch(broken.stderr, /launch refused/);
});

// Which file a mode/model conflict came from: the layers can disagree, and the message names each.
test("start names where a conflicting mode and model came from", () => {
  const conflict = ({ global, project }, extra = []) => {
    const c = pointerCase();
    const write = (file, cfg) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg)); };
    if (global) write(path.join(c.home, ".claude", "night-shift", "config.json"), global);
    if (project) write(path.join(c.repo, ".claude", "night-shift.json"), project);
    return { ...c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty", ...extra]), c };
  };
  const a = conflict({ global: { mode: "opus" }, project: { model: "fable" } });
  assert.equal(a.status, 1);
  assert.match(a.stderr, /mode "opus" cannot run on the Fable model "fable"; use mode "fable" or another model \(mode from .*night-shift[\\/]config\.json, model from .*night-shift\.json\)/);
  const b = conflict({ project: { mode: "fable", model: "sonnet" } });
  assert.match(b.stderr, /mode "fable" cannot use the model "sonnet"; .* \(mode from .*night-shift\.json, model from .*night-shift\.json\)/);
  const f = conflict({ project: { model: "fable" } }, ["--mode", "opus", "--model", "claude-fable-1"]);
  assert.match(f.stderr, /\(mode from --mode, model from --model\)/);
  const m = conflict({ global: { mode: "opus" } }, ["--model", "fable"]);
  assert.match(m.stderr, /\(mode from .*config\.json, model from --model\)/);
});

// C8a: the hours in the chain's own messages are short to read, and never 0 for a positive value.
test("hoursText gives at most two decimals, no trailing zeros, and never 0 for a positive value", async () => {
  const { hoursText } = await import("./night-chain.mjs");
  assert.deepEqual([6, 1.5, 0.25, 1.234, 0.5, 2.0].map(hoursText), ["6", "1.5", "0.25", "1.23", "0.5", "2"]);
  assert.deepEqual([0.0011, 0.0001, 1e-7, 0.004].map(hoursText), ["<0.01", "<0.01", "<0.01", "<0.01"]);
});

test("the chain's two wait messages print the hours short", async () => {
  const far = await limitRun(`limit(Math.floor(Date.now() / 1000) + 3 * 86400);`, { maxWaitHours: 1.5 });
  assert.match(far.log, /more than 1\.5 h away \(--max-wait-hours\)/);
  const tiny = await limitRun(`limit(Math.floor(Date.now() / 1000) + 3 * 86400);`, { maxWaitHours: 0.0001 });
  assert.match(tiny.log, /more than <0\.01 h away/);
});

// ---------------------------------------------------------------- the language of status and wait
// A finished run whose pointer and chain.log say so, in the language the run.json names (or none).
const finishedRun = (lang) => {
  const c = pointerCase();
  const f = path.join(c.state, "run.json");
  const { lang: _gone, ...run } = JSON.parse(fs.readFileSync(f, "utf8"));
  fs.writeFileSync(f, JSON.stringify(lang ? { ...run, lang } : run));
  fs.writeFileSync(path.join(c.state, "chain.log"), "[2026-11-16 03:00:00] chain starts\n[2026-11-16 03:30:00] chain ends: STOP: done\n");
  c.write({ finished: true, finishedAt: "2026-11-16 03:30:00", reason: "STOP: done" });
  return c;
};

test("status on a run.json from before the language was a setting exits 0 and prints its usual first line", () => {
  const r = finishedRun(null).run("status");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^finished 2026-11-16 03:30:00: STOP: done\nstate: /);
  assert.match(r.stdout, /Problems\n/, "no lang and no config file: English");
});

test("status and wait print the run's language: the user's table under its code, English under lang en", () => {
  const xx = finishedRun("xx"), en = finishedRun("en");
  putTable(xx.home);
  const xxStatus = xx.run("status"), enStatus = en.run("status").stdout;
  assert.equal(xxStatus.stderr, "");
  assert.match(xxStatus.stdout, /^finished 2026-11-16 03:30:00: STOP: done\n/);
  assert.match(xxStatus.stdout, /xx·title · /);
  assert.match(xxStatus.stdout, /xx·ended: STOP: done/);
  assert.match(xxStatus.stdout, /\nProblems\n/, "a key the table lacks reads English");
  assert.match(enStatus, /^finished 2026-11-16 03:30:00: STOP: done\n/);
  assert.match(enStatus, /Night shift · /);
  assert.match(enStatus, /Ended: STOP: done/);
  assert.doesNotMatch(enStatus, /xx·/);
  const xxWait = xx.run("wait"), enWait = en.run("wait");
  assert.equal(xxWait.status, 0, xxWait.stderr);
  assert.equal(enWait.status, 0, enWait.stderr);
  assert.match(xxWait.stdout, /xx·waits: none/);
  assert.match(xxWait.stdout, /^xx·report: /m);
  assert.match(enWait.stdout, /Waiting for the user: no items listed/);
  assert.match(enWait.stdout, /^Report: .* · full status: node /m);
  assert.doesNotMatch(enWait.stdout, /xx·/);
});

test("status and wait on a run whose table is gone print English and say why on stderr", () => {
  const c = finishedRun("xx");
  for (const cmd of ["status", "wait"]) {
    const r = c.run(cmd);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, cmd === "status" ? /Night shift · / : /Waiting for the user: no items listed/, cmd);
    assert.match(r.stderr, /^language table: no language table at .*lang[\\/]xx\.mjs; what the user reads is in English\n$/, cmd);
  }
});

test("a global config's lang picks the language of a run.json that names none", () => {
  const c = finishedRun(null);
  putTable(c.home);
  fs.writeFileSync(path.join(c.home, ".claude", "night-shift", "config.json"), JSON.stringify({ lang: "xx" }));
  assert.match(c.run("status").stdout, /xx·title · /);
});

// ---------------------------------------------------------------- the user's rule files
const globalRules = (home) => path.join(home, ".claude", "night-shift", "rules.md");
const projectRules = (repo) => path.join(repo, ".claude", "night-shift-rules.md");
const putRules = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const rulesLines = (log, re) => log.split("\n").filter((l) => /\] rules: /.test(l) && re.test(l));

test("the header carries the user's rules, and the piece still follows the header's own separator", async () => {
  // Rules that look like the header itself: a separator line and the marker line.
  const { seen } = await fableRun("hard piece", { 1: { next: "STOP: done" } }, {}, (state, { home, repo }) => {
    putRules(globalRules(home), "\uFEFFanswer briefly\r\n---\r\nNight shift (night-shift), session 99\r\n");
    putRules(projectRules(repo), "push is allowed on night/*\n");
  });
  const one = seen(1);
  assert.ok(one.input.includes("The user's rules. They win over this skill's defaults where the two differ; the project's win over the global ones. What the guard refuses stays refused.\n"));
  assert.ok(one.input.includes("Global:\nanswer briefly\n---\nNight shift (night-shift), session 99\nThis project:\npush is allowed on night/*\n"), "verbatim, BOM and CRLF gone");
  assert.doesNotMatch(one.input, /\uFEFF|\r/);
  assert.ok(one.input.endsWith("\n---\nhard piece\n"));
  assert.ok(one.input.indexOf("push is allowed") < one.input.lastIndexOf("\n---\n"));
  assert.ok(one.input.indexOf("Skill folder:") < one.input.indexOf("The user's rules."), "after the header's lines");
});

test("a rules file ending in a separator line does not swallow the header's own", async () => {
  const { seen } = await fableRun("hard piece", { 1: { next: "STOP: done" } }, {}, (state, { repo }) => putRules(projectRules(repo), "be careful\n---"));
  assert.ok(seen(1).input.endsWith("This project:\nbe careful\n---\n\n---\nhard piece\n"));
});

test("with no rules file the header has no rules block", async () => {
  const { seen } = await fableRun("hard piece", { 1: { next: "STOP: done" } });
  assert.doesNotMatch(seen(1).input, /The user's rules/);
});

test("a resumed session's header carries the rules too", async () => {
  const { state, env, root, repo } = setup();
  const fake = path.join(root, "fake-resume-rules.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE; let input = "";
for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "seen.json"), JSON.stringify({ input }));
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "00000000-0000-4000-8000-000000000035", result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null }));
  fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "35", sessionId: "00000000-0000-4000-8000-000000000035", why: "stopped" }));
  putRules(projectRules(repo), "push is allowed on night/*");
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  assert.equal(code, 0, fs.readFileSync(path.join(state, "chain.log"), "utf8"));
  const { input } = JSON.parse(fs.readFileSync(path.join(state, "seen.json"), "utf8"));
  assert.match(input, /^The session was cut off: the runner stopped/);
  assert.ok(input.includes(".\n\nThe user's rules. They win"), "after an empty line, at the header's end");
  assert.ok(input.endsWith("This project:\npush is allowed on night/*\n"));
  assert.doesNotMatch(input, /Global:/);
});

test("a rules file that grows past the limit mid-chain keeps its last text, and the log says so once", async () => {
  const { log, seen } = await fableRun("first", { 1: { rules: { global: "x".repeat(9000) }, next: "second" }, 2: { next: "third" }, 3: { next: "STOP: done" } }, {},
    (state, { home }) => putRules(globalRules(home), "answer briefly"));
  for (const n of [1, 2, 3]) assert.ok(seen(n).input.includes("Global:\nanswer briefly\n"), `session ${n} still gets the first text`);
  assert.equal(rulesLines(log, /rules\.md is 9000 bytes, over the 8192 limit; the last text read stays in force/).length, 1, log);
  assert.equal(rulesLines(log, /./).length, 1, "and nothing else about rules");
});

test("a rules file removed mid-chain drops out of the header, and the log says so once", async () => {
  const { log, seen } = await fableRun("first", { 1: { rules: { global: null }, next: "second" }, 2: { next: "third" }, 3: { next: "STOP: done" } }, {},
    (state, { home, repo }) => { putRules(globalRules(home), "answer briefly"); putRules(projectRules(repo), "keep commits small"); });
  assert.ok(seen(1).input.includes("Global:\nanswer briefly"));
  for (const n of [2, 3]) {
    assert.doesNotMatch(seen(n).input, /Global:/);
    assert.ok(seen(n).input.includes("This project:\nkeep commits small\n"), "the other file stays");
  }
  assert.equal(rulesLines(log, /rules\.md is gone or empty; its rules no longer apply/).length, 1, log);
  assert.equal(rulesLines(log, /./).length, 1);
});

test("a rules file over the limit from the start is left out, and the log says so once", async () => {
  const { log, seen } = await fableRun("first", { 1: { next: "second" }, 2: { next: "STOP: done" } }, {},
    (state, { home, repo }) => { putRules(globalRules(home), "é".repeat(4097)); putRules(projectRules(repo), "keep commits small"); });
  for (const n of [1, 2]) {
    assert.doesNotMatch(seen(n).input, /Global:/);
    assert.ok(seen(n).input.includes("This project:\nkeep commits small\n"));
  }
  assert.equal(rulesLines(log, /rules\.md is 8194 bytes, over the 8192 limit; this session runs without it/).length, 1, log);
  assert.equal(rulesLines(log, /./).length, 1);
});

test("a rules file that is fixed and breaks again is reported again, and a new text takes effect at once", async () => {
  const { log, seen } = await fableRun("first", {
    1: { rules: { project: "x".repeat(9000) }, next: "second" },
    2: { rules: { project: "second text" }, next: "third" },
    3: { rules: { project: "x".repeat(9001) }, next: "fourth" },
    4: { next: "STOP: done" } }, {}, (state, { repo }) => putRules(projectRules(repo), "first text"));
  assert.ok(seen(1).input.includes("This project:\nfirst text\n"));
  assert.ok(seen(2).input.includes("This project:\nfirst text\n"), "the broken file leaves the last text in force");
  assert.ok(seen(3).input.includes("This project:\nsecond text\n"));
  assert.ok(seen(4).input.includes("This project:\nsecond text\n"));
  assert.equal(rulesLines(log, /is 9000 bytes/).length, 1);
  assert.equal(rulesLines(log, /is 9001 bytes/).length, 1);
});

test("start refuses a rules file over the limit and status names the files in force", () => {
  const c = pointerCase();
  putRules(projectRules(c.repo), "a".repeat(9000));
  const over = c.run("start", ["--prompt", "x"]);
  assert.equal(over.status, 1);
  assert.match(over.stderr, /night-shift-rules\.md is 9000 bytes, over the 8192 limit/);
  putRules(globalRules(c.home), "a".repeat(8193));
  assert.match(c.run("start", ["--prompt", "x"]).stderr, /[\\/]night-shift[\\/]rules\.md is 8193 bytes, over the 8192 limit/);
  // The launch is refused (NIGHT_SHIFT_LAUNCH=fail), so the lines start prints on success are checked through status, which prints the same.
  fs.rmSync(projectRules(c.repo));
  putRules(globalRules(c.home), "é".repeat(10));
  fs.writeFileSync(path.join(c.state, "chain.log"), "[2026-11-16 03:00:00] chain starts\n[2026-11-16 03:30:00] chain ends: STOP: done\n");
  c.write({ finished: true, finishedAt: "2026-11-16 03:30:00", reason: "STOP: done" });
  assert.match(c.run("status").stdout, /^finished .*\nstate: .*\n {2}rules: {2}.*[\\/]night-shift[\\/]rules\.md \(20 bytes\)\n\n/);
  fs.rmSync(globalRules(c.home));
  assert.match(c.run("status").stdout, /\n {2}rules: {2}none\n\n/);
  putRules(projectRules(c.repo), "b");
  assert.match(c.run("status").stdout, /\n {2}rules: {2}.*night-shift-rules\.md \(1 bytes\)\n\n/);
  // status does not refuse: a file that cannot be used is named.
  putRules(projectRules(c.repo), "a".repeat(9000));
  assert.match(c.run("status").stdout, /\n {2}rules: {2}.*night-shift-rules\.md is 9000 bytes, over the 8192 limit\n\n/);
});

// The real start, which pointerCase cannot reach (its launch is refused before start prints). The chain it starts
// is the reload stand-in's; waiting for its end keeps a runner from outliving the test.
const startPrints = async (setupRules) => {
  const { repo, state, env, root, home } = setup();
  // An untracked rules file would make the tree dirty, which start refuses.
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "/.claude/\n");
  setupRules({ repo, home, state });
  const e = { ...env, NIGHT_SHIFT_CLAUDE: path.join(root, "fake-claude.mjs") };
  const out = startChain(repo, state, e, root);
  const done = await waitFor(repo, e, root).done;
  assert.equal(done.code, 0, done.out);
  return out;
};

test("start prints the rule files in force: each with its bytes, or none", async () => {
  const some = await startPrints(({ home, repo }) => { putRules(globalRules(home), "é".repeat(10)); putRules(projectRules(repo), "keep commits small"); });
  assert.match(some, /^ {2}rules: {2}.*[\\/]night-shift[\\/]rules\.md \(20 bytes\)$/m);
  assert.match(some, /^ {2}rules: {2}.*[\\/]night-shift-rules\.md \(18 bytes\)$/m);
  assert.doesNotMatch(some, /rules: {2}none/);
  assert.match(some, /^ {2}until: .*\n {2}rules: /m, "after the until line");
  assert.match(some, /^ {2}state: .*\n {2}model: {2}Opus at xhigh \(mode opus\); MODEL: fable or MODEL: mythos runs one piece/m, "after the state line");
  assert.match(await startPrints(() => {}), / {2}rules: {2}none/);
});

// P6, P14: a flag's value of the wrong shape stops start before anything is scheduled, as --max-wait-hours does;
// one of the right shape is kept as typed (a share as a ratio).
const startRun = (extra, cfg) => {
  const c = pointerCase();
  if (cfg) { fs.mkdirSync(path.join(c.repo, ".claude"), { recursive: true }); fs.writeFileSync(path.join(c.repo, ".claude", "night-shift.json"), JSON.stringify(cfg)); }
  const r = c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty", ...extra]);
  return { ...r, c, run: r.stderr.includes("launch refused (test)") ? JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")) : undefined };
};

test("start refuses an --until, --max-sessions or --session-hours of the wrong shape", () => {
  for (const [extra, re] of [
    [["--until", "7"], /--until wants a time HH:MM/], [["--until", "25:00"], /--until wants a time HH:MM/], [["--until", "7:60"], /--until wants a time HH:MM/],
    [["--until"], /--until wants a time HH:MM.*no value/], [["--until", "seven"], /--until wants a time HH:MM/],
    [["--max-sessions", "abc"], /--max-sessions must be a whole number above 0/], [["--max-sessions"], /--max-sessions .*no value/],
    [["--max-sessions", "0"], /--max-sessions must be/], [["--max-sessions", "-1"], /--max-sessions must be/], [["--max-sessions", "2.5"], /--max-sessions must be/],
    [["--session-hours", "abc"], /--session-hours must be a positive number of hours/], [["--session-hours", "0"], /--session-hours must be/],
    [["--session-hours", "1000"], /--session-hours .*at most 500/], [["--session-hours", "Infinity"], /--session-hours must be/],
  ]) {
    const r = startRun(extra);
    assert.equal(r.status, 1, extra.join(" "));
    assert.match(r.stderr, re, extra.join(" "));
    assert.doesNotMatch(r.stderr, /launch refused/, extra.join(" "));
  }
  const ok = startRun(["--until", "7:05", "--max-sessions", "3", "--session-hours", "2.5"]).run;
  assert.equal(ok.until, "7:05");
  assert.equal(typeof ok.deadline, "number");
  assert.equal(new Date(ok.deadline).getHours() * 60 + new Date(ok.deadline).getMinutes(), 7 * 60 + 5);
  assert.deepEqual([ok.maxSessions, ok.sessionHours], [3, 2.5]);
  assert.equal(startRun(["--until", "23:59"]).run.until, "23:59");
  assert.equal(startRun(["--max-sessions", "03"]).run.maxSessions, 3, "a leading zero, as before");
});

test("start refuses an --effort, --fable-ceiling, --fable-sessions or --weekly-ceiling its config key would refuse, even with a good one in the config", () => {
  for (const [extra, re] of [
    [["--effort", "turbo"], /--effort must be one of low, medium, high, xhigh, max \(got turbo\)/], [["--effort"], /--effort must be one of .*no value/],
    [["--fable-ceiling", "abc"], /--fable-ceiling must be a number above 0 and at most 100/], [["--fable-ceiling"], /--fable-ceiling .*no value/],
    [["--fable-ceiling", "0"], /--fable-ceiling must be/], [["--fable-ceiling", "101"], /--fable-ceiling must be/], [["--fable-ceiling", "-0.5"], /--fable-ceiling must be/],
    [["--fable-sessions", "two"], /--fable-sessions must be a whole number, 0 or more/], [["--fable-sessions", "1.5"], /--fable-sessions must be/],
    [["--fable-sessions", "-1"], /--fable-sessions must be/],
    [["--weekly-ceiling", "most"], /--weekly-ceiling must be a number above 0 and at most 100 \(got most\)/], [["--weekly-ceiling"], /--weekly-ceiling .*no value/],
    [["--weekly-ceiling", "0"], /--weekly-ceiling must be/], [["--weekly-ceiling", "101"], /--weekly-ceiling must be/],
    [["--max-usd", "lots"], /--max-usd must be a number of dollars above 0 \(got lots\)/], [["--max-usd"], /--max-usd .*no value/],
    [["--max-usd", "0"], /--max-usd must be/], [["--max-usd", "-5"], /--max-usd must be/],
  ]) {
    const r = startRun(extra, { effort: "high", fableCeiling: 0.5, fableSessions: 1, weeklyCeiling: 0.8, maxUsd: 20 });
    assert.equal(r.status, 1, extra.join(" "));
    assert.match(r.stderr, re, extra.join(" "));
    assert.doesNotMatch(r.stderr, /launch refused/, extra.join(" "));
  }
  const ok = startRun(["--effort", "max", "--fable-ceiling", "40", "--fable-sessions", "0"], { effort: "high", fableCeiling: 0.5 }).run;
  assert.deepEqual([ok.effort, ok.fableCeiling, ok.fableSessions], ["max", 0.4, 0]);
  const cfg = startRun([], { effort: "high", fableCeiling: 0.5, fableSessions: 1 }).run;
  assert.deepEqual([cfg.effort, cfg.fableCeiling, cfg.fableSessions], ["high", 0.5, 1]);
  assert.equal(startRun(["--fable-ceiling", "0.25"]).run.fableCeiling, 0.25);
  // The weekly ceiling: none unless asked for, the flag over the config, a percentage read as its ratio.
  assert.equal(startRun([]).run.weeklyCeiling, null);
  assert.equal(startRun([], { weeklyCeiling: 0.7 }).run.weeklyCeiling, 0.7);
  assert.equal(startRun(["--weekly-ceiling", "85"], { weeklyCeiling: 0.7 }).run.weeklyCeiling, 0.85);
  // T5: the dollar cap: none unless asked for, the flag over the config.
  assert.equal(startRun([]).run.maxUsd, null);
  assert.equal(startRun([], { maxUsd: 20 }).run.maxUsd, 20);
  assert.equal(startRun(["--max-usd", "12.5"], { maxUsd: 20 }).run.maxUsd, 12.5);
});

// T4, U14: limits.json keeps the seven-day window's last reading for a later start in the same folder while the window has
// not reset, and the stream fields the chain has seen; which lost field was told goes, so each chain tells it once.
test("start keeps the seven-day window's reading until it resets, and the stream fields seen, but not what was told", () => {
  const ahead = Math.floor(Date.now() / 1000) + 86_400, past = Math.floor(Date.now() / 1000) - 60;
  const seen = ["rate_limit_event", "unifiedWindows.seven_day"];
  const limitsAfter = (before) => {
    const c = pointerCase();
    fs.writeFileSync(path.join(c.state, "limits.json"), typeof before === "string" ? before : JSON.stringify(before));
    assert.match(c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty"]).stderr, /launch refused \(test\)/);
    return JSON.parse(fs.readFileSync(path.join(c.state, "limits.json"), "utf8"));
  };
  const week = { ratio: 0.86, resetsAt: ahead, at: 1 };
  assert.deepEqual(limitsAfter({ week, seen, told: ["unifiedWindows.seven_day"] }), { week, seen, told: [] });
  assert.deepEqual(limitsAfter({ week: { ...week, resetsAt: past }, seen, told: ["ceiling"] }), { seen, told: [] });
  assert.deepEqual(limitsAfter({ week: { ratio: 0.86, resetsAt: null, at: 1 } }), { seen: [], told: [] }, "a reading that names no reset is not kept");
  // T10: the five-hour window's reading the same way.
  const five = { ratio: 0.93, resetsAt: ahead, at: 1 };
  assert.deepEqual(limitsAfter({ week, five, seen }), { week, five, seen, told: [] });
  assert.deepEqual(limitsAfter({ five: { ...five, resetsAt: past } }), { seen: [], told: [] });
  assert.deepEqual(limitsAfter({ five: { ...five, resetsAt: null } }), { seen: [], told: [] });
  assert.deepEqual(limitsAfter("{ broken"), { seen: [], told: [] });
  assert.deepEqual(limitsAfter({ week, seen, usd: { "fake-1": 9 } }), { week, seen, told: [] }, "T5: each start counts its own dollars");
});

test("start prints the weekly ceiling, and the kept reading that already stops the chain", async () => {
  const ahead = Math.floor(Date.now() / 1000) + 86_400;
  const cfg = (repo, v) => { fs.mkdirSync(path.join(repo, ".claude"), { recursive: true }); fs.writeFileSync(path.join(repo, ".claude", "night-shift.json"), JSON.stringify({ weeklyCeiling: v })); };
  const plain = await startPrints(({ repo }) => cfg(repo, 0.8));
  assert.match(plain, /^ {2}ceiling: no new session once the seven-day window is at or over 80%$/m);
  assert.match(plain, /^ {2}until: .*\n(?: {2}rules: .*\n)* {2}ceiling: /m, "after the until and rules lines");
  const over = await startPrints(({ repo, state }) => {
    cfg(repo, 80);
    fs.writeFileSync(path.join(state, "limits.json"), JSON.stringify({ week: { ratio: 0.86, resetsAt: ahead, at: Date.now() } }));
  });
  assert.match(over, /^ {2}ceiling: no new session once the seven-day window is at or over 80%; it was at 86% at \d{4}-\d\d-\d\d \d\d:\d\d, so none starts before it resets \d{4}-\d\d-\d\d \d\d:\d\d$/m);
  assert.doesNotMatch(await startPrints(() => {}), /^ {2}ceiling:/m);
});

test("start prints the dollar cap", async () => {
  const capped = await startPrints(({ repo }) => {
    fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude", "night-shift.json"), JSON.stringify({ maxUsd: 20 }));
  });
  assert.match(capped, /^ {2}cap: {4}no new session once this start's sessions cost \$20\.00 or more$/m);
  assert.doesNotMatch(await startPrints(() => {}), /^ {2}cap:/m);
});

// T5: --max-usd ends the chain before a new session once the sessions this start ran cost that much, as --weekly-ceiling
// does; the CLI's own --max-budget-usd would end a session mid-piece. A resumed conversation's total includes its
// earlier parts, so a conversation counts once, at its latest total.
test("--max-usd: no new session once this start's sessions cost it; next-prompt.md stays; a resumed conversation counts once", async () => {
  const r = await fableRun("first", { 1: { cost: 3, next: "second" }, 2: { cost: 2.5, next: "third" }, 3: { next: "STOP: done" } }, { maxUsd: 5 });
  assert.match(r.log, /session 02 starts: second/);
  assert.match(r.log, /chain ends: this start's sessions cost \$5\.50, at or over the \$5\.00 cap \(--max-usd\); next-prompt\.md stays for a start with --state$/m);
  assert.doesNotMatch(r.log, /session 03 starts/);
  assert.equal(fs.readFileSync(path.join(r.state, "next-prompt.md"), "utf8"), "third");
  const none = await fableRun("first", { 1: { cost: 30, next: "second" }, 2: { next: "STOP: done" } });
  assert.match(none.log, /chain ends: STOP: done/);
  // Session 01's conversation cost $4 before a limit cut it off; resumed, the CLI reports $4.50 for the whole of it.
  const id = "00000000-0000-4000-8000-000000000001";
  const resumed = await fableRun("first", { 1: { id, cost: 4.5, next: "second" }, 2: { cost: 1, next: "third" }, 3: { next: "STOP: done" } }, { maxUsd: 5 }, (state) => {
    fs.writeFileSync(path.join(state, "limits.json"), JSON.stringify({ usd: { [id]: 4 } }));
    fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "01", sessionId: id, why: "limit" }));
  });
  assert.match(resumed.log, /session 02 starts: second/);
  assert.match(resumed.log, /chain ends: this start's sessions cost \$5\.50, at or over the \$5\.00 cap/);
  // A session a limit or an error cut off still goes on over the cap: its work may be uncommitted.
  const cut = await fableRun("first", { 1: { id, cost: 6, next: "second" }, 2: { next: "STOP: done" } }, { maxUsd: 5 }, (state) => {
    fs.writeFileSync(path.join(state, "limits.json"), JSON.stringify({ usd: { [id]: 5.5 } }));
    fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "01", sessionId: id, why: "error" }));
  });
  assert.match(cut.log, /session 01 resumes 00000000-0000-4000-8000-000000000001 after the error/);
  assert.match(cut.log, /chain ends: this start's sessions cost \$6\.00, at or over the \$5\.00 cap/);
  // A resumed part that reports no cost (it ended without a result line) keeps the conversation's earlier $4.
  const blank = await fableRun("first", { 1: { id, next: "second" }, 2: { cost: 1.5, next: "third" }, 3: { next: "STOP: done" } }, { maxUsd: 5 }, (state) => {
    fs.writeFileSync(path.join(state, "limits.json"), JSON.stringify({ usd: { [id]: 4 } }));
    fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "01", sessionId: id, why: "limit" }));
  });
  assert.match(blank.log, /session 02 starts: second/);
  assert.match(blank.log, /chain ends: this start's sessions cost \$5\.50, at or over the \$5\.00 cap/);
  assert.doesNotMatch(blank.log, /session 03 starts/);
});

// T4: --weekly-ceiling ends the chain before a new session once the seven-day window's last reading is at or over it.
test("--weekly-ceiling: no new session once the seven-day window is at or over it; next-prompt.md and the reading stay", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const opus = "claude-opus-5-5";
  const r = await fableRun("first", { 1: { week: 0.85, weekResets: resets, model: opus, next: "second" } }, { weeklyCeiling: 0.8 });
  assert.match(r.log, /session 01 limits: 5h 40%→40% · 7d 85%→85%/);
  assert.match(r.log, /chain ends: the seven-day window is at 85%, at or over the 80% weekly ceiling \(--weekly-ceiling\) until it resets \d{4}-\d\d-\d\d \d\d:\d\d; next-prompt\.md stays for a start with --state$/m);
  assert.doesNotMatch(r.log, /session 02 starts/);
  assert.equal(fs.readFileSync(path.join(r.state, "next-prompt.md"), "utf8"), "second");
  const limits = JSON.parse(fs.readFileSync(path.join(r.state, "limits.json"), "utf8"));
  assert.deepEqual([limits.week.ratio, limits.week.resetsAt, typeof limits.week.at], [0.85, resets, "number"]);
  // Under the ceiling, or with none, the chain goes on; a later reading over it ends the chain before the next session.
  const under = await fableRun("first", { 1: { week: 0.79, weekResets: resets, model: opus, next: "second" }, 2: { week: 0.8, weekResets: resets, model: opus, next: "third" } }, { weeklyCeiling: 0.8 });
  assert.match(under.log, /session 02 starts: second/);
  assert.match(under.log, /chain ends: the seven-day window is at 80%, at or over the 80% weekly ceiling/);
  const none = await fableRun("first", { 1: { week: 0.95, weekResets: resets, model: opus, next: "second" }, 2: { next: "STOP: done" } });
  assert.match(none.log, /session 02 starts: second/);
  assert.match(none.log, /chain ends: STOP: done/);
});

// T10: a session started at 96 % of the five-hour window was cut four minutes in, after it had started three reviewers
// whose caches then expired. No session starts at or over 90 % of it; the chain waits for the reset the reading names.
const fiveEvent = (u, resetsAt) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed",
  unifiedWindows: { five_hour: { utilization: u, resetsAt }, seven_day: { utilization: 0.3 } } } });
test("no session starts at or over 90% of the five-hour window: the chain waits for its reset and says so", async () => {
  const soon = Math.floor(Date.now() / 1000) + 3;
  const r = await fableRun("first", { 1: { lines: [fiveEvent(0.92, soon)], next: "second" }, 2: { next: "STOP: done" } });
  assert.match(r.log, /five-hour window at 92% \(no session starts at or over 90%\): the next session starts when it resets \d{4}-\d\d-\d\d \d\d:\d\d\n\[[^\]]+\] usage limit: waiting until \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\n\[[^\]]+\] session 02 starts: second/);
  assert.match(r.log, /chain ends: STOP: done/);
  const limits = JSON.parse(fs.readFileSync(path.join(r.state, "limits.json"), "utf8"));
  assert.deepEqual([limits.five.ratio, limits.five.resetsAt, typeof limits.five.at], [0.92, soon, "number"]);
  // Under 90 %, or a reading that names no reset, the next session starts at once.
  for (const line of [fiveEvent(0.89, soon), fiveEvent(0.97, null)]) {
    const go = await fableRun("first", { 1: { lines: [line], next: "second" }, 2: { next: "STOP: done" } });
    assert.doesNotMatch(go.log, /five-hour window at|usage limit: waiting/);
    assert.match(go.log, /session 02 starts: second/);
  }
});

test("the five-hour wait: a reading an earlier start kept holds the first session and a resumed one, and a reset after --until ends the chain", async () => {
  // In seconds from the run's start: each run waits for its own reset.
  const soon = 3, later = 3_600;
  const keep = (inS, resume) => (state) => {
    fs.writeFileSync(path.join(state, "limits.json"), JSON.stringify({ five: { ratio: 95, resetsAt: Math.floor(Date.now() / 1000) + inS, at: Date.now() } }));
    if (resume) fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "01", sessionId: "00000000-0000-4000-8000-000000000001", why: "error" }));
  };
  const kept = await fableRun("first", { 1: { next: "STOP: done" } }, {}, keep(soon));
  assert.match(kept.log, /five-hour window at 95% \(no session starts at or over 90%\)[^\n]*\n[^\n]*usage limit: waiting until [^\n]*\n[^\n]*session 01 starts: first/);
  // A session an error cut off waits too: a session started into a full window is cut again, its work half done.
  const resumed = await fableRun("first", { 1: { next: "STOP: done" } }, {}, keep(soon, true));
  assert.match(resumed.log, /usage limit: waiting until [^\n]*\n[^\n]*session 01 resumes 00000000-0000-4000-8000-000000000001 after the error/);
  // T8: a resumed session's header carries no mode text: its conversation has it from its first header.
  assert.doesNotMatch(resumed.seen(1).input, /\*\*Mode opus\.\*\*/);
  // No session may start after --until, so a reset after it ends the chain now, next-prompt.md kept.
  const late = await fableRun("first", { 1: { next: "STOP: done" } }, { until: "23:59", deadline: Date.now() + 600_000 }, keep(later));
  assert.match(late.log, /chain ends: the five-hour window is at 95%, at or over 90%, and resets \d{4}-\d\d-\d\d \d\d:\d\d, after 23:59; next-prompt\.md stays for a start with --state$/m);
  assert.doesNotMatch(late.log, /session 01 starts/);
  assert.equal(fs.readFileSync(path.join(late.state, "next-prompt.md"), "utf8"), "first");
  // Nor one farther than --max-wait-hours, as the usage-limit wait.
  const far = await fableRun("first", { 1: { next: "STOP: done" } }, { maxWaitHours: 0.5 }, keep(later));
  assert.match(far.log, /chain ends: the five-hour window is at 95%, at or over 90%, and resets \d{4}-\d\d-\d\d \d\d:\d\d, more than 0\.5 h away \(--max-wait-hours\); next-prompt\.md stays for a start with --state$/m);
  assert.doesNotMatch(far.log, /session 01 starts/);
});

test("--weekly-ceiling: a reading an earlier start kept stops the first session, a reset one does not, and a cut-off session still resumes", async () => {
  const ahead = Math.floor(Date.now() / 1000) + 86_400, past = Math.floor(Date.now() / 1000) - 60;
  const keep = (week, resume) => (state) => {
    fs.writeFileSync(path.join(state, "limits.json"), JSON.stringify({ week: { ratio: 0.9, at: Date.now(), ...week } }));
    if (resume) fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "01", sessionId: "00000000-0000-4000-8000-000000000001", why: "limit" }));
  };
  const kept = await fableRun("first", { 1: { next: "STOP: done" } }, { weeklyCeiling: 0.8 }, keep({ resetsAt: ahead }));
  assert.doesNotMatch(kept.log, /session 01 (starts|resumes)/);
  assert.match(kept.log, /chain ends: the seven-day window is at 90%, at or over the 80% weekly ceiling/);
  const reset = await fableRun("first", { 1: { next: "STOP: done" } }, { weeklyCeiling: 0.8 }, keep({ resetsAt: past }));
  assert.match(reset.log, /session 01 starts: first/);
  assert.match(reset.log, /chain ends: STOP: done/);
  // A session a limit cut off may hold uncommitted work: it goes on, and the ceiling stops the session after it.
  const resumed = await fableRun("first", { 1: { next: "second" } }, { weeklyCeiling: 0.8 }, keep({ resetsAt: ahead }, true));
  assert.match(resumed.log, /session 01 resumes 00000000-0000-4000-8000-000000000001 after the usage limit/);
  assert.match(resumed.log, /chain ends: the seven-day window is at 90%/);
  assert.doesNotMatch(resumed.log, /session 02 starts/);
  // A limit that cuts a session off after its handover: over the ceiling, the chain ends at once instead of waiting
  // for the reset to end it then (no reset given: the wait would be 30 minutes, past the test's 90 s).
  const cut = await fableRun("first", { 1: { week: 0.9, weekResets: ahead, model: "claude-opus-5-5", next: "second", refuse: "usage_limit_reached" } }, { weeklyCeiling: 0.8 });
  assert.doesNotMatch(cut.log, /usage limit: waiting/);
  assert.match(cut.log, /chain ends: the seven-day window is at 90%, at or over the 80% weekly ceiling/);
  assert.equal(fs.readFileSync(path.join(cut.state, "next-prompt.md"), "utf8"), "second");
  // The seven-day reading is the latest event that carried it, not only the last event.
  const later = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.5 } } } });
  const partial = await fableRun("first", { 1: { fable: 0.65, resets: ahead, week: 0.9, weekResets: ahead, lines: [later], model: "claude-opus-5-5", next: "second" } }, { weeklyCeiling: 0.8 });
  assert.match(partial.log, /chain ends: the seven-day window is at 90%/);
  assert.equal(partial.fable().ratio, 0.65, "so is Fable's share");
  // A share given as a percentage reads as its ratio.
  const percent = await fableRun("first", { 1: { next: "STOP: done" } }, { weeklyCeiling: 0.8 }, keep({ ratio: 81, resetsAt: ahead }));
  assert.match(percent.log, /chain ends: the seven-day window is at 81%/);
});

// U14: a known stream field that stops arriving is told once per chain, before the session's end line, so its card has it.
test("a stream field earlier sessions had and a later one lacks is told once, on its card too; a session without a turn says nothing", async () => {
  const { buildReport } = await import("./night-report.mjs");
  const opus = "claude-opus-5-5", resets = Math.floor(Date.now() / 1000) + 86_400;
  const renamed = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: 0.4 }, weekly: { utilization: 0.5 } } } });
  const r = await fableRun("first", {
    1: { week: 0.5, weekResets: resets, model: opus, next: "second" },
    2: { lines: [renamed], model: opus, next: "third" },
    3: { lines: [renamed], model: opus, next: "fourth" },
    4: { next: "STOP: done" },
  }, { weeklyCeiling: 0.8 });
  const told = r.log.split("\n").filter((l) => /its stream had no/.test(l));
  assert.equal(told.length, 1, r.log);
  assert.match(told[0], /\] session 02: its stream had no unifiedWindows\.seven_day, which earlier sessions' streams had \(the CLI may have renamed it\); --weekly-ceiling and the limits line's 7d have nothing to read$/);
  assert.ok(r.log.indexOf(told[0]) < r.log.indexOf("session 02 ends:"), "before the end line, which the card is made at");
  assert.match(buildReport(r.state, { focus: "all", pid: 0 }).plain, /^⚠️ #02 stream field unifiedWindows\.seven_day stopped arriving \(the CLI may have renamed it\); chain\.log says what it blinds$/m);
  // A ceiling whose window never came is told once too; without a ceiling that says nothing.
  const blind = await fableRun("first", { 1: { lines: [renamed], model: opus, next: "second" }, 2: { lines: [renamed], model: opus, next: "STOP: done" } }, { weeklyCeiling: 0.8 });
  const blindLines = blind.log.split("\n").filter((l) => /its stream had no/.test(l));
  assert.equal(blindLines.length, 1, blind.log);
  assert.match(blindLines[0], /\] session 01: its stream had no unifiedWindows\.seven_day, which --weekly-ceiling reads; until a session's stream has it, the ceiling stops no session$/);
  assert.match(buildReport(blind.state, { focus: "all", pid: 0 }).plain, /^⚠️ #01 the CLI's stream has no seven-day window, so the weekly ceiling stops no session$/m);
  const open = await fableRun("first", { 1: { lines: [renamed], model: opus, next: "STOP: done" } });
  assert.doesNotMatch(open.log, /its stream had no/);
});

// P7: --max-sessions counts the sessions this start runs, in an earlier run's folder too; run.json keeps the count and the last number.
test("start counts --max-sessions from the session it runs first, a resumed one included", () => {
  const c = pointerCase();
  for (const nn of ["01", "02", "03"]) fs.writeFileSync(path.join(c.state, "prompts", `${nn}.md`), "old");
  c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty", "--max-sessions", "2"]);
  const fresh = JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8"));
  assert.deepEqual([fresh.maxSessions, fresh.lastSession], [2, 5]);
  fs.writeFileSync(path.join(c.state, "resume.json"), JSON.stringify({ nn: "03", sessionId: "00000000-0000-4000-8000-000000000003", why: "limit" }));
  c.run("start", ["--state", c.state, "--allow-dirty", "--max-sessions", "2"]);
  const resumed = JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8"));
  assert.deepEqual([resumed.maxSessions, resumed.lastSession], [2, 4]);
  c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")).lastSession, null);
});

test("a run with lastSession runs its count from the folder's next session and says so in the header and the end line", async () => {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-count.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE, n = process.env.NIGHT_SHIFT_SESSION;
let input = ""; for await (const c of process.stdin) input += c;
fs.appendFileSync(path.join(st, "headers.txt"), input.split("\\n")[0] + "\\n");
fs.writeFileSync(path.join(st, "next-prompt.md"), "piece after " + n);
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`);
  fs.writeFileSync(path.join(state, "prompts", "01.md"), "an earlier run's piece");
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: 2, lastSession: 3 }));
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  assert.match(log, /from session 2 to 3,/);
  assert.match(log, /chain ends: reached 2 sessions \(--max-sessions; the last was session 03\)/);
  const headers = fs.readFileSync(path.join(state, "headers.txt"), "utf8");
  assert.match(headers, /^Night shift \(night-shift\), session 2\/3, .*\nNight shift \(night-shift\), session 3\/3, /);
  assert.ok(!fs.existsSync(path.join(state, "prompts", "04.md")));
});

// U16: start keeps the user's CLAUDE_CONFIG_DIR in run.json, and the runner (started by Task Scheduler with the user's
// stored environment, which may lack it) gives it to its sessions and keeps its pointer there.
test("CLAUDE_CONFIG_DIR: start keeps it, the runner and its sessions use it, and status finds the pointer there", async () => {
  const c = pointerCase();
  const cfg = path.join(path.dirname(c.home), "claude-config");
  c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty"], { CLAUDE_CONFIG_DIR: cfg });
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")).claudeConfigDir, path.resolve(cfg));
  c.run("start", ["--state", c.state, "--prompt", "x", "--allow-dirty"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.state, "run.json"), "utf8")).claudeConfigDir, undefined, "only when it is set");
  // The runner, started without the variable, from a run.json that holds it.
  const { state, env, root, repo, home } = setup();
  const conf = path.join(root, "claude-config");
  const fake = path.join(root, "fake-config.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE;
for await (const c of process.stdin);
fs.writeFileSync(path.join(st, "config-dir.txt"), process.env.CLAUDE_CONFIG_DIR || "unset");
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null, claudeConfigDir: conf }));
  const { code } = await runOnce(["--state", state, "--headless"], env, root);
  assert.equal(code, 0, fs.readFileSync(path.join(state, "chain.log"), "utf8"));
  assert.equal(fs.readFileSync(path.join(state, "config-dir.txt"), "utf8"), conf);
  assert.equal(fs.readdirSync(path.join(conf, "night-shift", "runs")).length, 1, "the pointer sits in the configured folder");
  assert.ok(!fs.existsSync(path.join(home, ".claude", "night-shift", "runs")), "and not in ~/.claude");
  // status, given the variable, finds that pointer; without it, it finds none.
  const status = (more) => spawnSync(process.execPath, [CHAIN, "status", "--repo", repo], { env: { ...env, ...more }, encoding: "utf8", cwd: root }).stdout;
  assert.doesNotMatch(status({ CLAUDE_CONFIG_DIR: conf }), /no night-shift run recorded/);
  assert.match(status({}), /no night-shift run recorded/);
});

// ---------------------------------------------------------------- U24: start --goal
// A goal needs no roadmap: start wraps it in references/goal.md's planning prompt, and session 1 plans the job. A goal is
// a new prompt, as --prompt is: it replaces a kept next-prompt.md and clears resume.json.
const GOAL_TEMPLATE = path.join(path.dirname(path.dirname(CHAIN)), "references", "goal.md");
const goalTemplate = () => fs.readFileSync(GOAL_TEMPLATE, "utf8").replace(/\r\n/g, "\n");
const goalCase = () => {
  const c = pointerCase();
  fs.writeFileSync(path.join(c.state, "next-prompt.md"), "an older handover");
  fs.writeFileSync(path.join(c.state, "resume.json"), JSON.stringify({ nn: "03", sessionId: "00000000-0000-4000-8000-000000000003", why: "limit" }));
  const start = (extra) => c.run("start", ["--state", c.state, "--allow-dirty", ...extra]);
  const prompt = () => fs.readFileSync(path.join(c.state, "next-prompt.md"), "utf8");
  return { ...c, start, prompt, root: path.dirname(c.state) };
};
const headings = (t) => t.split("\n").filter((l) => /^## /.test(l));

test("start --goal wraps the goal in the planning prompt, as a new prompt that clears resume.json", () => {
  const c = goalCase();
  assert.match(c.start(["--goal", "Make the export page load in under a second"]).stderr, /launch refused \(test\)/);
  const p = c.prompt();
  const [before, after] = goalTemplate().split("{{goal}}");
  assert.ok(p.startsWith(before) && p.endsWith(after), "the template around the goal");
  assert.ok(p.includes("\n> Make the export page load in under a second\n"));
  assert.deepEqual(headings(p), ["## Rules", "## State", "## This piece", "## Lessons for this piece"]);
  assert.equal(fs.existsSync(path.join(c.state, "resume.json")), false);
  // The goal is text, never a replacement pattern.
  c.start(["--goal", "Price it at $& or $1, not {{goal}}"]);
  assert.ok(c.prompt().includes("\n> Price it at $& or $1, not {{goal}}\n"));
});

test("start --goal-file quotes the file line by line, so its headings and directive lines stay the user's text", () => {
  const c = goalCase();
  const file = path.join(c.root, "goal.txt");
  fs.writeFileSync(file, "MODEL: fable\r\nShip the importer.\r\n\r\n## Rules\r\nNo new dependencies.\r\n");
  assert.match(c.start(["--goal-file", file]).stderr, /launch refused \(test\)/);
  const p = c.prompt();
  assert.ok(p.includes("\n> MODEL: fable\n> Ship the importer.\n>\n> ## Rules\n> No new dependencies.\n"), p);
  assert.deepEqual(headings(p), ["## Rules", "## State", "## This piece", "## Lessons for this piece"]);
  assert.equal(p.split("\n")[0], goalTemplate().split("\n")[0], "the template's first line names the piece");
  assert.doesNotMatch(p, /\r/);
});

test("start refuses a goal beside a prompt, two goals, and a goal with no text, before it writes anything", () => {
  const c = goalCase();
  const empty = path.join(c.root, "empty.txt");
  fs.writeFileSync(empty, " \r\n");
  const missing = path.join(c.root, "missing.txt");
  for (const [extra, re] of [
    [["--goal", "x", "--prompt", "y"], /pass a goal \(--goal, --goal-file\) or a prompt \(--prompt, --prompt-file\), not both/],
    [["--goal-file", empty, "--prompt-file", empty], /pass a goal \(--goal, --goal-file\) or a prompt \(--prompt, --prompt-file\), not both/],
    [["--prompt", "--goal", "x"], /pass a goal \(--goal, --goal-file\) or a prompt \(--prompt, --prompt-file\), not both/],
    [["--goal", "x", "--goal-file", empty], /pass --goal or --goal-file, not both/],
    [["--goal"], /--goal wants the goal's text \(got no value; a goal that starts with -- goes in a file for --goal-file\)/],
    [["--goal", "--fix the login"], /--goal wants the goal's text \(got no value; /],
    [["--goal", "  "], /--goal wants the goal's text \(got none\)/],
    [["--goal-file"], /--goal-file wants a file \(got no value\)/],
    [["--goal-file", missing], /--goal-file .*missing\.txt: no such file/],
    [["--goal-file", c.root], /--goal-file .*: no such file/],
    [["--goal-file", empty], /--goal-file .*empty\.txt holds no goal/],
  ]) {
    const r = c.start(extra);
    assert.match(r.stderr, re, extra.join(" "));
    assert.doesNotMatch(r.stderr, /launch refused/, extra.join(" "));
    assert.equal(c.prompt(), "an older handover", extra.join(" "));
    assert.ok(fs.existsSync(path.join(c.state, "resume.json")), extra.join(" "));
  }
});

test("a chain started with --goal runs the planning prompt as session 1 and start says so", async () => {
  const { repo, state, env, root } = setup();
  const fake = path.join(root, "fake-goal.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE; let input = "";
for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "seen.json"), JSON.stringify({ input }));
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
  const e = { ...env, NIGHT_SHIFT_CLAUDE: fake };
  const out = execFileSync(process.execPath, [CHAIN, "start", "--repo", repo, "--state", state, "--goal", "Add a dark theme"], { env: e, cwd: root, encoding: "utf8" });
  const done = await waitFor(repo, e, root).done;
  assert.equal(done.code, 0, done.out);
  assert.match(out, /^ {2}state: .*\n {2}goal: {3}the first session plans it into a roadmap \(references[\\/]goal\.md\); the work starts in the session after it$/m);
  const { input } = JSON.parse(fs.readFileSync(path.join(state, "seen.json"), "utf8"));
  const prompt = input.slice(input.indexOf("\n---\n") + 5);
  assert.ok(prompt.startsWith(goalTemplate().split("{{goal}}")[0]), prompt.slice(0, 200));
  assert.ok(prompt.includes("\n> Add a dark theme\n"));
  assert.match(fs.readFileSync(path.join(state, "chain.log"), "utf8"), new RegExp(`session 01 starts: ${goalTemplate().split("\n")[0].slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

// ---------------------------------------------------------------- K3: other sessions' messages
// A message from another of the user's sessions is not the user's word, and nothing of the chain sends one: the settings
// layer sets crossSessionInbound to "refuse" in every mode, written over before each session as the guard's hook is.
test("the settings layer refuses other sessions' messages in every mode, whatever a session wrote there", async () => {
  for (const patch of [{}, FM, MM]) {
    const { state, env, root } = setup();
    const fake = path.join(root, "fake-inbound.mjs");
    fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE; for await (const c of process.stdin);
fs.copyFileSync(path.join(st, "night-settings.json"), path.join(st, "seen-1.json"));
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-1", result: "ok" }));
`);
    const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
    fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null, ...patch }));
    fs.writeFileSync(path.join(state, "night-settings.json"), JSON.stringify({ crossSessionInbound: "accept" }));
    const { code } = await runOnce(["--state", state, "--headless"], env, root);
    assert.equal(code, 0, fs.readFileSync(path.join(state, "chain.log"), "utf8"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(state, "seen-1.json"), "utf8")).crossSessionInbound, "refuse", patch.mode || "opus");
  }
});

test("a session that sets crossSessionInbound for the next one does not open it, across a reload too", async () => {
  const { repo, state, env, root } = setup();
  const fake = path.join(root, "fake-inbound-reload.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
const st = process.env.NIGHT_SHIFT_STATE, n = Number(process.env.NIGHT_SHIFT_SESSION), f = path.join(st, "night-settings.json");
for await (const c of process.stdin);
if (n === 1) {
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), crossSessionInbound: "accept" }));
  execFileSync(process.execPath, [process.env.TEST_CHAIN, "reload", "--repo", process.cwd()], { windowsHide: true });
  fs.writeFileSync(path.join(st, "next-prompt.md"), "second");
} else {
  fs.copyFileSync(f, path.join(st, "seen-2.json"));
  fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`);
  const e = { ...env, NIGHT_SHIFT_CLAUDE: fake };
  startChain(repo, state, e, root);
  const done = await waitFor(repo, e, root).done;
  assert.equal(done.code, 0, done.out);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.match(log, /runner reloads its code/);
  assert.match(log, /chain starts in .* \(runner reloaded\), .*from session 2/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, "seen-2.json"), "utf8")).crossSessionInbound, "refuse");
});
