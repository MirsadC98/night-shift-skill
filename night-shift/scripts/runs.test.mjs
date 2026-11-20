// node --test night-shift/scripts/runs.test.mjs
// Each repository's last run (the pointer) and the one stop that `stop` and the bot's /stop share.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { platformFor } from "./platform.mjs";

// Every pointer these tests write sits in a throwaway Claude folder, never the user's (claudeHome reads the variable per call).
const claude = fs.mkdtempSync(path.join(os.tmpdir(), "ns-runs-"));
process.env.CLAUDE_CONFIG_DIR = claude;
const { pointerFile, readPointer, writePointer, stopRun } = await import("./runs.mjs");
const { refresh, FILES } = await import("./dashboard.mjs");

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms, what) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (pred()) return;
  assert.fail(`timed out waiting for ${what}`);
};
const scene = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-stop-"));
  const repo = path.join(dir, "repo"), state = path.join(dir, "state");
  for (const d of [repo, state]) fs.mkdirSync(d);
  return { dir, repo, state };
};
// A process whose command line names night-chain.mjs, as a runner's does (isRunner).
const fakeRunner = (dir) => {
  const file = path.join(dir, "night-chain.mjs");
  fs.writeFileSync(file, "setTimeout(() => {}, 60000);\n");
  return spawn(process.execPath, [file], { stdio: "ignore", windowsHide: true });
};
const exited = (p) => new Promise((r) => p.on("exit", r));
// The system's processes as a test sets them (platform.mjs): a live runner by default, whose kill does nothing.
const fakePlatform = (over) => ({ ...platformFor(), alive: () => true, commandLine: () => "node night-chain.mjs run", killTree: () => {}, ...over });

test("the pointer lives in the Claude folder's night-shift/runs, one file per repository", () => {
  const { repo } = scene();
  assert.equal(path.dirname(pointerFile(repo)), path.join(claude, "night-shift", "runs"));
  assert.match(path.basename(pointerFile(repo)), /^repo-[0-9a-f]{8}\.json$/);
  assert.equal(readPointer(repo), null);
  writePointer(repo, { pid: 1 });
  assert.deepEqual(readPointer(repo), { pid: 1 });
});

test("stopRun finds no active run, or none in another state folder, and then writes nothing", async () => {
  const { dir, repo, state } = scene();
  assert.deepEqual(await stopRun(repo), { outcome: "none" });
  assert.deepEqual(await stopRun(undefined), { outcome: "none" });
  writePointer(repo, { pid: process.pid, state, finished: true });
  assert.equal((await stopRun(repo)).outcome, "none");
  writePointer(repo, { pid: process.pid, state, finished: false });
  assert.equal((await stopRun(repo, { state: path.join(dir, "other") })).outcome, "none");
  assert.equal(fs.existsSync(path.join(state, "STOP-REQUEST")), false);
});

test("stopRun marks a run whose runner never started or is gone finished, now or not", async () => {
  const { repo, state } = scene();
  writePointer(repo, { state, finished: false });
  // In another case where the file system ignores it (Windows, macOS); on Linux that would be another folder.
  const same = platformFor().fold("A") === "a" ? state.toUpperCase() : state;
  assert.equal((await stopRun(repo, { state: same })).outcome, "never");
  assert.equal(readPointer(repo).finished, true);
  assert.equal(readPointer(repo).reason, "its runner never started");
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await exited(gone);
  writePointer(repo, { pid: gone.pid, state, finished: false });
  let asked = false;
  assert.deepEqual(await stopRun(repo, { now: true, before: async () => { asked = true; } }), { outcome: "gone", pid: gone.pid });
  assert.equal(asked, false);
  assert.equal(readPointer(repo).reason, "its runner was already gone");
  assert.ok(fs.existsSync(path.join(state, "STOP-REQUEST")));
});

test("stopRun without now asks the runner to stop after the session in progress and leaves it running", async () => {
  const { dir, repo, state } = scene();
  const runner = fakeRunner(dir);
  try {
    await until(() => alive(runner.pid), 5_000, "the stand-in runner");
    writePointer(repo, { pid: runner.pid, state, finished: false });
    let asked = false;
    assert.deepEqual(await stopRun(repo, { state, before: async () => { asked = true; } }), { outcome: "after", pid: runner.pid });
    assert.equal(asked, false);
    assert.ok(fs.existsSync(path.join(state, "STOP-REQUEST")));
    assert.ok(alive(runner.pid));
    assert.equal(readPointer(repo).finished, false);
  } finally { runner.kill(); }
});

test("stopRun with now answers first, marks the pointer finished, kills the runner's tree and marks it again", async () => {
  const { dir, repo, state } = scene();
  const runner = fakeRunner(dir);
  try {
    await until(() => alive(runner.pid), 5_000, "the stand-in runner");
    writePointer(repo, { pid: runner.pid, state, finished: false, startedAt: "test" });
    const seen = [];
    const r = await stopRun(repo, { now: true, state, via: "from Telegram",
      before: async (outcome) => { seen.push({ outcome, alive: alive(runner.pid), finished: readPointer(repo).finished }); } });
    assert.deepEqual(r, { outcome: "now", pid: runner.pid });
    assert.deepEqual(seen, [{ outcome: "now", alive: true, finished: false }]);
    await until(() => !alive(runner.pid), 5_000, "the runner to be killed");
    const p = readPointer(repo);
    assert.equal(p.finished, true);
    assert.equal(p.reason, "stopped now by the user from Telegram");
    assert.equal(p.startedAt, "test");
  } finally { runner.kill(); }
});

test("stopRun with now still kills when the pointer cannot be written", async () => {
  const { dir, repo, state } = scene();
  const runner = fakeRunner(dir);
  try {
    await until(() => alive(runner.pid), 5_000, "the stand-in runner");
    writePointer(repo, { pid: runner.pid, state, finished: false });
    fs.chmodSync(pointerFile(repo), 0o444);
    assert.deepEqual(await stopRun(repo, { now: true, state }), { outcome: "now", pid: runner.pid });
    await until(() => !alive(runner.pid), 5_000, "the runner to be killed");
    assert.equal(readPointer(repo).finished, false);
  } finally { fs.chmodSync(pointerFile(repo), 0o666); runner.kill(); }
});

test("stopRun with now goes on to the kill when the answer before it fails", async () => {
  const { dir, repo, state } = scene();
  const runner = fakeRunner(dir);
  try {
    await until(() => alive(runner.pid), 5_000, "the stand-in runner");
    writePointer(repo, { pid: runner.pid, state, finished: false });
    const r = await stopRun(repo, { now: true, before: async () => { throw new Error("telegram is down"); } });
    assert.equal(r.outcome, "now");
    await until(() => !alive(runner.pid), 5_000, "the runner to be killed");
    assert.equal(readPointer(repo).reason, "stopped now by the user");
  } finally { runner.kill(); }
});

test("stopRun with now kills nothing and says unsure when what the pid is cannot be told", async () => {
  const { repo, state } = scene();
  writePointer(repo, { pid: 424242, state, finished: false });
  const killed = [];
  let asked = false;
  const platform = fakePlatform({ commandLine: () => null, killTree: (pid) => killed.push(pid) });
  assert.deepEqual(await stopRun(repo, { now: true, state, platform, before: async () => { asked = true; } }), { outcome: "unsure", pid: 424242 });
  assert.deepEqual(killed, []);
  assert.equal(asked, false);
  assert.equal(readPointer(repo).finished, false);
  assert.ok(fs.existsSync(path.join(state, "STOP-REQUEST")));
});

test("stopRun with now says failed and puts the pointer back when the runner outlives the kill", async () => {
  const { repo, state } = scene();
  writePointer(repo, { pid: 424242, state, finished: false, startedAt: "test" });
  const killed = [];
  const platform = fakePlatform({ killTree: (pid) => killed.push(pid) });
  assert.deepEqual(await stopRun(repo, { now: true, state, platform }), { outcome: "failed", pid: 424242 });
  assert.deepEqual(killed, [424242]);
  assert.deepEqual(readPointer(repo), { pid: 424242, state, finished: false, startedAt: "test" });
});

test("stopRun takes a pid whose command line names no runner for gone, and kills nothing", async () => {
  const { repo, state } = scene();
  writePointer(repo, { pid: 424242, state, finished: false });
  const killed = [];
  const platform = fakePlatform({ commandLine: () => "C:\\Windows\\notepad.exe", killTree: (pid) => killed.push(pid) });
  assert.deepEqual(await stopRun(repo, { now: true, state, platform }), { outcome: "gone", pid: 424242 });
  assert.deepEqual(killed, []);
  assert.equal(readPointer(repo).reason, "its runner was already gone");
});

// ---------------------------------------------------------------- the dashboard's last state before a kill
// A state folder whose run is in session 01, as dashboard.mjs reads it. Its run.json names the Claude folder the
// pointers are in, so that the dashboard finds the pointer stopRun marks.
const running = () => {
  const s = scene();
  const t = Date.now() - 60_000, stamp = (ms) => new Date(ms).toLocaleString("sv-SE");
  fs.writeFileSync(path.join(s.state, "run.json"), JSON.stringify({ claudeConfigDir: claude, lang: "en", repo: s.repo }));
  fs.writeFileSync(path.join(s.state, "chain.log"), `[${stamp(t)}] chain starts in ${s.repo}\n[${stamp(t + 1000)}] session 01 starts: A\n`);
  return s;
};
const dashAt = (state) => { const f = path.join(state, FILES.json); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; };

test("a stop now writes the final state before the kill", async () => {
  const { repo, state } = running();
  writePointer(repo, { pid: 424242, state, finished: false });
  let seen = null, page = false, gone = false;
  const platform = fakePlatform({ alive: () => !gone, killTree: () => { seen = dashAt(state); page = fs.existsSync(path.join(state, FILES.page)); gone = true; } });
  assert.equal((await stopRun(repo, { now: true, state, via: "from Telegram", platform })).outcome, "now");
  assert.ok(seen, "dashboard.json was there at the kill");
  assert.equal(seen.chain.state, "ended");
  assert.match(seen.chain.endReason, /^stopped now by the user/);
  assert.equal(page, true);
});

test("a final write that throws or hangs does not hold the stop", async () => {
  const finals = [async () => { throw new Error("disk"); }, () => { throw new Error("at once"); }, () => new Promise(() => {})];
  for (const write of finals) {
    const { repo, state } = running();
    writePointer(repo, { pid: 424242, state, finished: false });
    const calls = [];
    let killed = 0, gone = false;
    const platform = fakePlatform({ alive: () => !gone, killTree: () => { killed++; gone = true; } });
    const t0 = Date.now();
    const r = await stopRun(repo, { now: true, state, platform, final: (s) => { calls.push(s); return write(); }, finalMs: 50 });
    assert.equal(r.outcome, "now");
    assert.deepEqual(calls, [state]);
    assert.equal(killed, 1);
    assert.ok(Date.now() - t0 < 2_000, `the stop took ${Date.now() - t0} ms`);
  }
});

test("a runner that outlives the kill reads as running again", async () => {
  const { repo, state } = running();
  writePointer(repo, { pid: 424242, state, finished: false });
  let seen = null;
  const platform = fakePlatform({ killTree: () => { seen = dashAt(state); } });
  assert.equal((await stopRun(repo, { now: true, state, platform })).outcome, "failed");
  assert.equal(seen?.chain.state, "ended");
  const { data } = await refresh(state, { force: true, alive: () => true });
  assert.equal(data.chain.state, "running");
});

test("a stop after the session writes nothing", async () => {
  const { repo, state } = running();
  writePointer(repo, { pid: 424242, state, finished: false });
  let calls = 0;
  const r = await stopRun(repo, { state, platform: fakePlatform(), final: async () => { calls++; } });
  assert.equal(r.outcome, "after");
  assert.equal(calls, 0);
  assert.equal(dashAt(state), null);
});
