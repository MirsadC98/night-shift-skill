// node --test wait-for.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "wait-for.mjs");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "wait-for-"));
const run = (args) => new Promise((resolve) => {
  const t0 = Date.now();
  execFile(process.execPath, [SCRIPT, ...args], (err, stdout, stderr) =>
    resolve({ code: err ? err.code : 0, out: stdout + stderr, ms: Date.now() - t0 }));
});
// A writer process that does `js` after `ms` and then lingers `stay` ms.
const writer = (js, ms = 300, stay = 0) => spawn(process.execPath,
  ["-e", `setTimeout(() => { ${js}; setTimeout(() => {}, ${stay}); }, ${ms})`], { stdio: "ignore" });

test("refuses to wait for a file nothing will write", async () => {
  const d = tmp();
  const r = await run(["--file", path.join(d, "never.txt"), "--timeout", "5"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /--pid/);
  assert.ok(r.ms < 2000, "refuses at once, it does not sleep");
});

test("refuses the C:/nonexistent trick and a missing log", async () => {
  assert.equal((await run(["--file", "C:/nonexistent", "--timeout", "5"])).code, 2);
  const d = tmp();
  const r = await run(["--log", path.join(d, "none.log"), "--match", "done", "--timeout", "5"]);
  assert.equal(r.code, 2, r.out);
});

test("refuses a process that does not run", async () => {
  const r = await run(["--pid", "999999", "--timeout", "5"]);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /999999/);
});

test("refuses a call without a condition, a log without --match, and an unknown flag", async () => {
  assert.equal((await run([])).code, 2);
  const d = tmp(); const log = path.join(d, "a.log"); fs.writeFileSync(log, "");
  assert.equal((await run(["--log", log, "--timeout", "1"])).code, 2);
  assert.equal((await run(["--seconds", "60"])).code, 2);
});

test("--help prints the usage and exits 0", async () => {
  const r = await run(["--help"]);
  assert.equal(r.code, 0);
  assert.match(r.out, /--log <file> --match <regex>/);
});

test("returns as soon as the writer creates the file", async () => {
  const d = tmp(); const f = path.join(d, "out.txt");
  const w = writer(`require("fs").writeFileSync(${JSON.stringify(f)}, "x")`, 300, 3000);
  const r = await run(["--file", f, "--pid", String(w.pid), "--timeout", "10"]);
  w.kill();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^ready after \d+ s/);
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
});

test("a file that already exists needs no writer, and its last line counts without a newline", async () => {
  const d = tmp(); const f = path.join(d, "here.txt"); fs.writeFileSync(f, "x");
  assert.equal((await run(["--file", f, "--timeout", "5"])).code, 0);
  fs.writeFileSync(f, "frames 120\nresult: PASS");
  const r = await run(["--file", f, "--match", "PASS", "--timeout", "2"]);
  assert.equal(r.code, 0, r.out);
});

test("ends with 1 when the writer exits without writing", async () => {
  const d = tmp();
  const w = writer("", 200);
  const r = await run(["--file", path.join(d, "never.txt"), "--pid", String(w.pid), "--timeout", "10"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ended/);
  assert.ok(r.ms < 4000, `took ${r.ms} ms`);
});

test("waits for a log line, and --fail ends it early", async () => {
  const d = tmp(); const log = path.join(d, "build.log"); fs.writeFileSync(log, "starting\n");
  const ok = writer(`require("fs").appendFileSync(${JSON.stringify(log)}, "step 1\\nFinished release\\n")`, 300);
  const r = await run(["--log", log, "--match", "^Finished", "--timeout", "10"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Finished release/);
  ok.kill();

  const log2 = path.join(d, "gates.log"); fs.writeFileSync(log2, "");
  const bad = writer(`require("fs").appendFileSync(${JSON.stringify(log2)}, "gate 3 FAIL\\n")`, 300);
  const r2 = await run(["--log", log2, "--match", "ALL PASS", "--fail", "FAIL", "--timeout", "10"]);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /gate 3 FAIL/);
  bad.kill();
});

test("--new skips lines that were there before the wait", async () => {
  const d = tmp(); const log = path.join(d, "app.log"); fs.writeFileSync(log, "ready\n");
  const r = await run(["--log", log, "--match", "ready", "--new", "--timeout", "1"]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /timed out/);
});

test("--pid alone waits for the process to exit", async () => {
  const w = writer("", 400);
  const r = await run(["--pid", String(w.pid), "--timeout", "10"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /exited/);
});

test("a log its writer has not created yet is fine while the writer runs", async () => {
  const d = tmp(); const log = path.join(d, "later.log");
  const w = writer(`require("fs").writeFileSync(${JSON.stringify(log)}, "listening on 1420\\n")`, 300, 3000);
  const r = await run(["--log", log, "--match", "listening", "--pid", String(w.pid), "--timeout", "10"]);
  w.kill();
  assert.equal(r.code, 0, r.out);
});
