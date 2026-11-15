// node --test night-chain.test.mjs — runs `run` for real against a stand-in claude (a .mjs),
// in a throwaway repo, state folder and home, so no real session. NIGHT_SHIFT_LAUNCH=direct
// starts the next runner as a plain detached process instead of through Task Scheduler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHAIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "night-chain.mjs");
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
  fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done\\n\\nKullanıcıyı bekleyenler:\\n\\n1. **Push.** 12 commit yerel\\n2. Fiziksel kabul");
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
    sessionHours: 1, model: null, effort: "xhigh", claude: fake, report: "NIGHT_RUNS.md", path: process.env.PATH, startedAt: "test" }));
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
  // The pointer of an older runner: alive (this test's pid), no "reloadable".
  const slugged = execFileSync(process.execPath, ["-e",
    `const c=require("crypto"),p=require("path");console.log(p.basename(process.argv[1])+"-"+c.createHash("sha1").update(process.argv[1].toLowerCase()).digest("hex").slice(0,8))`, repo], { encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(ptrDir, `${slugged}.json`), JSON.stringify({ pid: process.pid, state, finished: false }));
  const out = execFileSync(process.execPath, [CHAIN, "reload", "--repo", repo], { env, encoding: "utf8" });
  assert.match(out, /predates reload/);
  assert.equal(fs.existsSync(path.join(state, "RELOAD-REQUEST")), false);
});

test("cutOffSession: only a session that started (or resumed) and never ended counts", async () => {
  const { cutOffSession } = await import("./night-chain.mjs");
  const { state } = setup();
  const log = (lines) => fs.writeFileSync(path.join(state, "chain.log"), lines.map((l) => `[2026-11-01 19:26:17] ${l}`).join("\n") + "\n");
  fs.writeFileSync(path.join(state, "session-35.jsonl"), '{"type":"system","session_id":"cb61ff92-x"}\n');
  log(["chain starts in x", "session 34 ends: success", "session 35 starts: Zincir 2"]);
  assert.deepEqual(cutOffSession(state), { nn: "35", sessionId: "cb61ff92-x" });
  log(["session 35 resumes cb61ff92-x after the usage limit"]);
  assert.deepEqual(cutOffSession(state), { nn: "35", sessionId: "cb61ff92-x" });
  log(["session 35 starts: x", "session 35 ends: success"]);
  assert.equal(cutOffSession(state), null);
  log(["session 35 starts: x", "chain ends: stop requested"]);
  assert.equal(cutOffSession(state), null);
  log(["session 36 starts: x"]);
  assert.equal(cutOffSession(state), null, "no stream, no conversation to resume");
  // From 2026-11-15 the runs line says what it ran on, so the resume goes on on the same model.
  log(["session 35 starts: x", "session 35 runs Fable at high"]);
  assert.deepEqual(cutOffSession(state), { nn: "35", sessionId: "cb61ff92-x", model: "fable", effort: "high" });
  log(["session 35 starts: x", "session 35 asked for Fable, but its allowance is used up until 2026-11-18 10:00; it runs on Opus at max",
    "session 35 runs Opus (claude-opus-5-5) at max"]);
  assert.deepEqual(cutOffSession(state), { nn: "35", sessionId: "cb61ff92-x", model: "claude-opus-5-5", effort: "max" });
});

test("a stopped session resumes with its own header, and settings added by hand survive run", async () => {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-resume.mjs");
  fs.writeFileSync(fake, `import fs from "node:fs"; import path from "node:path";
const st = process.env.NIGHT_SHIFT_STATE; let input = "";
for await (const c of process.stdin) input += c;
fs.writeFileSync(path.join(st, "seen.json"), JSON.stringify({ args: process.argv.slice(2), input }));
fs.writeFileSync(path.join(st, "next-prompt.md"), "STOP: done");
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "cb61ff92-x", result: "ok" }));
`);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null }));
  fs.writeFileSync(path.join(state, "resume.json"), JSON.stringify({ nn: "35", sessionId: "cb61ff92-x", why: "stopped" }));
  fs.writeFileSync(path.join(state, "night-settings.json"), JSON.stringify({
    env: { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" },
    hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "cleanup.ps1" }] }], PreToolUse: [] },
    modelSettings: { opus: { effortLevel: "high" }, sonnet: { effortLevel: "medium" } } }));
  const mark = path.join(root, "hide-mark.txt");
  const { code } = await runOnce(["--state", state, "--headless"], { ...env, NIGHT_SHIFT_HIDE_MARK: mark }, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  assert.match(log, /session 35 resumes cb61ff92-x where the last runner stopped/);
  assert.ok(fs.existsSync(mark), "the session's Node processes must load hide-windows.cjs");
  const seen = JSON.parse(fs.readFileSync(path.join(state, "seen.json"), "utf8"));
  assert.deepEqual(seen.args.slice(seen.args.indexOf("--resume"), seen.args.indexOf("--resume") + 2), ["--resume", "cb61ff92-x"]);
  assert.match(seen.input, /^Oturum yarıda kesildi: runner durdu/);
  assert.doesNotMatch(seen.input, /Kullanım limiti/);
  assert.equal(fs.existsSync(path.join(state, "resume.json")), false);
  const s = JSON.parse(fs.readFileSync(path.join(state, "night-settings.json"), "utf8"));
  assert.equal(s.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "0");
  assert.equal(s.hooks.SessionStart[0].hooks[0].command, "cleanup.ps1");
  assert.match(s.hooks.PreToolUse[0].hooks[0].args[0], /guard\.mjs$/);
  assert.deepEqual(s.modelSettings, { opus: { effortLevel: "xhigh" }, fable: { effortLevel: "high" }, sonnet: { effortLevel: "medium" }, haiku: { effortLevel: "high" } });
  assert.equal(s.autoContinueAtUsageLimit, true);
  assert.equal(s.outputStyle, "default");
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
  assert.match(one.input, /Sonnet "medium", önemli iş "high"/);
  // Max is for that one piece: finished or blocked, the session takes no other work at max.
  assert.match(one.input, /yalnız bu parça için/);
  assert.match(one.input, /başka işe geçme/);
  assert.equal(one.effortEnv, null);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(flag(two, "--effort"), null);
  assert.doesNotMatch(two.input, /önemli iş "high"/);
  assert.doesNotMatch(two.input, /başka işe geçme/);
  assert.match(log, /session 01 starts: hard piece/);
  assert.match(log, /session 01 runs Opus at max/);
  const s = JSON.parse(fs.readFileSync(path.join(state, "night-settings.json"), "utf8"));
  assert.equal(s.env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.deepEqual(s.modelSettings, {
    opus: { effortLevel: "xhigh" }, "claude-opus-5-5": { effortLevel: "xhigh" },
    fable: { effortLevel: "high" }, "claude-fable-5-2": { effortLevel: "high" },
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
  assert.match(two.input, /devam promptu yazmadan bitti/);
  assert.match(two.input, /Neden: a race across two subsystems\.\nhard piece/);
  assert.doesNotMatch(two.input, /^EFFORT:/m);
  assert.match(log, /session 02 runs Opus at max/);
  assert.match(fs.readFileSync(path.join(state, "prompts", "02.md"), "utf8"), /^EFFORT: max\n/);
});

// ---------------------------------------------------------------- Fable
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
if (step.fable != null) console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed",
  unifiedWindows: { five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.3 }, seven_day_overage_included: { utilization: step.fable, resetsAt: step.resets } } } }));
if (step.next != null) fs.writeFileSync(path.join(st, "next-prompt.md"), step.next);
console.log(JSON.stringify(step.refuse
  ? { type: "result", subtype: "success", is_error: true, api_error: step.refuse, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "refused" }
  : { type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 0, session_id: "fake-" + n, result: "ok" }));
`;
async function fableRun(first, script, runPatch = {}) {
  const { state, env, root } = setup();
  const fake = path.join(root, "fake-fable.mjs");
  fs.writeFileSync(fake, FABLE_FAKE);
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, claude: fake, maxSessions: null, ...runPatch }));
  fs.writeFileSync(path.join(state, "next-prompt.md"), first);
  const { code } = await runOnce(["--state", state, "--headless"], { ...env, TEST_SCRIPT: JSON.stringify(script) }, root);
  const log = fs.readFileSync(path.join(state, "chain.log"), "utf8");
  assert.equal(code, 0, log);
  const seen = (n) => JSON.parse(fs.readFileSync(path.join(state, `seen-${n}.json`), "utf8"));
  const flag = (s, f) => (s.args.includes(f) ? s.args[s.args.indexOf(f) + 1] : null);
  const fable = () => JSON.parse(fs.readFileSync(path.join(state, "fable.json"), "utf8"));
  return { state, log, seen, flag, fable };
}

test("a MODEL: fable prompt runs that session on Fable at high without the model fallback; the next one on Opus", async () => {
  const resets = Math.floor(Date.now() / 1000) + 3 * 86_400;
  const { log, seen, flag, fable } = await fableRun("MODEL: fable — the parser resisted Opus twice\nhard piece", {
    1: { fable: 0.2, resets, next: `plain piece\n${"x".repeat(31_000)}` }, 2: { next: "STOP: done" } });
  const [one, two] = [seen(1), seen(2)];
  assert.equal(flag(one, "--model"), "fable");
  assert.equal(flag(one, "--effort"), null, "high goes through the settings layer");
  assert.equal(one.settings.fable.effortLevel, "high");
  assert.equal(one.settings.opus.effortLevel, "xhigh");
  assert.equal(one.noFallback, "1");
  assert.doesNotMatch(one.input, /^MODEL:/m);
  assert.match(one.input, /\n---\nthe parser resisted Opus twice\nhard piece\n$/);
  assert.match(one.input, /Bu oturum Fable'da, yalnız bu parça için/);
  assert.equal(flag(two, "--model"), "opus");
  assert.equal(two.noFallback, null);
  assert.doesNotMatch(two.input, /Fable'da/);
  assert.match(log, /session 01 starts: the parser resisted Opus twice\n/);
  assert.match(log, /session 01 runs Fable at high\n/);
  assert.match(log, /session 01 limits: 5h 40%→40% · 7d 30%→30% · fable 20%→20%; it ran on no model reply/);
  assert.match(log, /session 01 wrote a next-prompt\.md of 31 KB \(over 30 KB\)/);
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
  assert.match(two.input, /Önceki Fable oturumu \(01\) Fable payı bittiği için kesildi/);
  assert.match(two.input, /git status ve git diff/);
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
  assert.match(three.input, /İstem MODEL: fable istedi/);
  assert.match(three.input, /\n---\nanother hard piece\n$/);
  assert.match(log, /session 03 asked for Fable, but its allowance is used up until \S+ \S+; it runs on Opus at max\n/);
  assert.match(log, /session 03 runs Opus at max\n/);
  const { sessionMessage } = await import("./night-report.mjs");
  assert.match(sessionMessage(state, "01", process.pid).text, /Fable payı bittiği için kesildi/);
  assert.match(sessionMessage(state, "03", process.pid).text, /Fable istedi, Opus max'te çalıştı \(Fable payı \S+ \S+'e kadar bitti\)/);
  assert.doesNotMatch(sessionMessage(state, "03", process.pid).text, /olmalı/);
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
  assert.match(count.log, /session 02 asked for Fable, but 1 Fable sessions already ran in this chain while its allowance's share is unknown/);
  assert.equal(count.fable().sessions, 1);
});

test("a retry keeps both MODEL and EFFORT; a resume goes on on the model it ran on", async () => {
  const retry = await fableRun("MODEL: fable\nEFFORT: xhigh\nhard piece", { 2: { next: "STOP: done" } });
  const two = retry.seen(2);
  assert.equal(retry.flag(two, "--model"), "fable");
  assert.equal(retry.flag(two, "--effort"), null);
  assert.equal(two.settings.fable.effortLevel, "xhigh");
  assert.match(two.input, /devam promptu yazmadan bitti[^]*\n\nhard piece\n$/);
  assert.match(fs.readFileSync(path.join(retry.state, "prompts", "02.md"), "utf8"), /^MODEL: fable\nEFFORT: xhigh\nÖnceki gece oturumu/);
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
    "[2026-11-05 16:36:25] session 35 resumes cb61ff92-x where the last runner stopped",
    "[2026-11-05 18:53:21] session 35 ends: success, 66 turns, $13.03",
  ].join("\n") + "\n");
  const said = (local, id) => JSON.stringify({ type: "assistant", timestamp: iso(local),
    message: { id, model: "claude-opus-5-5", content: [], usage: { input_tokens: 1, output_tokens: 1 } } });
  fs.writeFileSync(path.join(state, "session-35.jsonl"), [
    JSON.stringify({ type: "system", session_id: "cb61ff92-x", timestamp: iso("2026-11-01T19:26:20") }),
    said("2026-11-01T19:30:00", "a"), said("2026-11-01T21:20:00", "b"),
    said("2026-11-05T16:40:00", "c"), said("2026-11-05T18:53:00", "d"),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "cb61ff92-x" }),
  ].join("\n") + "\n");
  assert.match(buildReport(state, { pid: 0 }).plain, /#35 11-01 19:26–11-05 18:53 · 4 sa 11 dk \(\+91 sa 16 dk ara\) · ✅/);
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
  assert.match(out, new RegExp(`runner devretti: pid ${runners[0]} → ${runners[1]}`));
  assert.match(out, /^finished .*: STOP: done$/m);
  assert.match(out, new RegExp(`^state: ${lit(state)}$`, "m"));
  assert.match(out, /Sorunlar\n✅ Sorun yok/);
  assert.match(out, /Kullanıcıyı bekleyenler:\n1\. \*\*Push\.\*\* 12 commit yerel\n2\. Fiziksel kabul/);
  assert.doesNotMatch(out, /zincir çöktü/);
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
  assert.match(out, /^zincir çöktü: /m);
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
  // falls on the next day ("yarın ~00:15"; telegram-cards.test.mjs pins the label with a fixed clock).
  assert.match(buildReport(state, { pid: process.pid }).plain, /Çalışıyor · iş 07\/4 · 2\/4 iş bitti · tahmini bitiş (?:yarın )?~\d\d:\d\d · /);
  // As at the job's end: two left at the mean of 45 min from 14:13.
  assert.match(sessionMessage(state, "06", process.pid).text, /\n📊 2\/4 iş bitti · tahmini bitiş ~15:45\n/);
});

test("/rapor's message lists only this run's jobs, each under its report title", async () => {
  const { reportMessage } = await import("./night-report.mjs");
  const { repo, state } = setup();
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ ...run, startedAt: "2026-11-10 12:42:18" }));
  fs.writeFileSync(path.join(state, "chain.log"), [
    "[2026-11-10 00:39:00] session 01 starts: Gece vardiyası (night-shift). Önce.",
    "[2026-11-10 03:51:00] session 01 ends: success, 9 turns, $1.00",
    "[2026-11-10 12:42:18] session 05 starts: Gece vardiyası (night-shift). Önce.",
    "[2026-11-10 13:12:18] session 05 ends: success, 25 turns, $11.48",
    "[2026-11-10 13:13:00] session 06 starts: Gece vardiyası (night-shift). Önce.",
  ].join("\n") + "\n");
  const ok = JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "x", total_cost_usd: 11.48 });
  for (const nn of ["01", "05"]) fs.writeFileSync(path.join(state, `session-${nn}.jsonl`), `${ok}\n`);
  fs.writeFileSync(path.join(state, "session-06.jsonl"), "");
  fs.writeFileSync(path.join(repo, "NIGHT_RUNS.md"), [
    "## 2026-11-10 · run 5 · session 5 (12:42–13:12) · D3 plan", "**Waits for you**", "- New: none.", "**Remaining:** 3 sessions",
  ].join("\n"));
  const { text } = reportMessage(state, process.pid);
  assert.match(text, /\n✅ #05 D3 plan · 30 dk\n⏳ #06 sürüyor · /);
  assert.match(text, /📊 1\/4 iş bitti · tahmini bitiş /);
  assert.doesNotMatch(text, /#01|Gece vardiyası|Token|Commit/);
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
  assert.doesNotMatch(sessionMessage(state, "01", process.pid).text, /olmalı/);
  assert.match(sessionMessage(state, "02", process.pid).text, /düzey high \(xhigh olmalı\)/);
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
  assert.doesNotMatch(one, /olmalı/);
  assert.match(one, /7g %30 · Fable %25/);
  assert.match(sessionMessage(state, "02", process.pid).text, /düzey high \(xhigh olmalı\)/);
  assert.doesNotMatch(sessionMessage(state, "02", process.pid).text, /Fable %/);
  const plain = buildReport(state, { focus: "all", pid: 0 }).plain;
  assert.match(plain, /limit 5s %40→%40 · 7g %30→%30 · Fable %25→%25/);
  assert.match(plain, /#01 başı  5s %40  7g %30  F %25/);
  assert.match(plain, /sıfırlanma: .* · Fable \d\d\.\d\d \d\d:\d\d/);
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
  assert.match(fs.readFileSync(path.join(state, "stdin-2.txt"), "utf8"), /^Bağlantı ya da API hatası geçti \(gece vardiyası, /);
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
  assert.match(log, /chain ends: session 01 kept failing for [\d.]+ h \(API Error: 500 Internal server error\)/);
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
