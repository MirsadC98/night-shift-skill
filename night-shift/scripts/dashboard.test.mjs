// The dashboard's data, page and files, built from state folders made by hand: no runner, no CLI, no browser.
// node --test scripts/dashboard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readChain } from "./dashboard.mjs";
import { reached } from "./fixtures/imports.mjs";
// A CLAUDE_CONFIG_DIR of the user's own would move every file these tests read or write (claudeHome in config.mjs).
delete process.env.CLAUDE_CONFIG_DIR;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const BASE = new Date(2026, 10, 16, 3, 0).getTime();
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE");
// chain.log's events as chainEvents gives them, stamped minutes after base in local time.
const log = (base, lines) => lines.map(([m, text]) => ({ at: stamp(base + m * MIN), text }));

test("dashboard.mjs reaches neither entry module", () => {
  const names = [...reached(path.join(HERE, "dashboard.mjs"))].map((f) => path.basename(f));
  assert.ok(names.includes("run-read.mjs"), names.join(", "));
  assert.ok(!names.includes("night-report.mjs") && !names.includes("night-chain.mjs"), names.join(", "));
});

// ---------------------------------------------------------------- readChain
const ONE = [
  [0, "chain starts in /r, until the work is done, from session 1, opus at xhigh"],
  [0, "session 01 starts: A"],
  [0, "session 01 runs Opus at xhigh"],
  [20, "session 01 ends: success, 12 turns, $3.26"],
  [20, "session 01 limits: 5h 10%→20% · 7d 30%→31%; it ran on claude-opus-5-5"],
];

test("readChain: one session, start to end", () => {
  const c = readChain(log(BASE, ONE));
  assert.equal(c.sessions.length, 1);
  const s = c.sessions[0];
  assert.equal(s.n, 1);
  assert.equal(s.title, "A");
  assert.equal(s.model, "Opus");
  assert.equal(s.effort, "xhigh");
  assert.equal(s.attempts.length, 1);
  const a = s.attempts[0];
  assert.deepEqual({ kind: a.kind, outcome: a.outcome, turns: a.turns, usd: a.usd, endKnown: a.endKnown }, { kind: "start", outcome: "success", turns: 12, usd: 3.26, endKnown: true });
  assert.equal(a.start, BASE);
  assert.equal(a.end, BASE + 20 * MIN);
  assert.deepEqual(a.h5, [10, 20]);
  assert.deepEqual(a.d7, [30, 31]);
  assert.deepEqual(c.limits, [{ t: BASE, h5: 10, d7: 30 }, { t: BASE + 20 * MIN, h5: 20, d7: 31 }]);
  assert.equal(c.started, BASE);
  assert.equal(c.endLine, null);
  assert.equal(c.lastLine, BASE + 20 * MIN);
  assert.deepEqual(c.events.map((e) => e.kind), ["start"]);
});

const CUT = [
  [0, "chain starts in /r, from session 1"],
  [0, "session 01 starts: A"],
  [0, "session 01 runs Opus at xhigh"],
  [10, "session 01 ends: success (error), 1 turns, $3.26"],
  [10, "session 01 limits: 5h 96%→100% · 7d 81%→82%; it ran on claude-opus-5-5"],
  [10, "session 01: five_hour cut it off; limit record {\"status\":\"rejected\"}"],
  [10, "usage limit: waiting until 2026-11-16 04:01:00"],
];

test("readChain: a session a usage limit cut, resumed", () => {
  const waiting = readChain(log(BASE, CUT));
  assert.deepEqual(waiting.wait, { until: new Date(2026, 10, 16, 4, 1).getTime(), text: "usage limit: waiting until 2026-11-16 04:01:00" });
  const c = readChain(log(BASE, [...CUT, [61, "session 01 resumes s1 after the usage limit"], [61, "session 01 runs Opus at xhigh"], [70, "session 01 ends: success, 17 turns, $7.05"]]));
  const [a, b] = c.sessions[0].attempts;
  assert.deepEqual([a.kind, a.outcome, a.limitType], ["start", "limit", "five_hour"]);
  assert.deepEqual([b.kind, b.why, b.outcome], ["resume", "limit", "success"]);
  assert.equal(a.usd, 3.26);
  assert.equal(b.usd, 3.79);
  assert.equal(c.wait, null);
  assert.deepEqual(c.events.map((e) => e.kind), ["start", "limit", "limit", "resume"]);
});

test("readChain: a number started again is one session", () => {
  const c = readChain(log(BASE, [[0, "session 02 starts: B"], [5, "session 02 ends: error_during_execution (error), 2 turns, $0.40"], [6, "session 02 starts: B"], [9, "session 02 ends: success, 4 turns, $0.90"]]));
  assert.equal(c.sessions.length, 1);
  assert.deepEqual(c.sessions[0].attempts.map((a) => a.kind), ["start", "retry"]);
  assert.deepEqual(c.sessions[0].attempts.map((a) => a.outcome), ["error", "success"]);
  // A number started again is a new conversation: its dollars are its own, not a step up from the try before.
  assert.deepEqual(c.sessions[0].attempts.map((a) => a.usd), [0.4, 0.9]);
});

test("readChain: a runner that died mid-session", () => {
  const c = readChain(log(BASE, [[0, "chain starts in /r, from session 5"], [0, "session 05 starts: E"], [0, "session 05 runs Opus at xhigh"],
    [90, "chain starts in /r, until the work is done, from session 5"], [90, "session 05 resumes s5 where the last runner stopped"], [99, "session 05 ends: success, 9 turns, $4.00"]]));
  const [a, b] = c.sessions[0].attempts;
  assert.deepEqual({ end: a.end, endKnown: a.endKnown, outcome: a.outcome, usd: a.usd }, { end: null, endKnown: false, outcome: "cut", usd: null });
  assert.deepEqual({ kind: b.kind, why: b.why, outcome: b.outcome, usd: b.usd }, { kind: "resume", why: "stopped", outcome: "success", usd: 4 });
  assert.equal(c.started, BASE, "the first chain starts read");
});

test("readChain: a session in progress", () => {
  const c = readChain(log(BASE, [[0, "chain starts in /r"], [0, "session 03 starts: C"], [0, "session 03 runs Fable (claude-fable-5-2) at high"]]));
  const a = c.sessions[0].attempts[0];
  assert.deepEqual({ end: a.end, endKnown: a.endKnown, outcome: a.outcome }, { end: null, endKnown: true, outcome: null });
  assert.equal(c.sessions[0].model, "Fable");
  assert.equal(c.sessions[0].effort, "high");
});

test("readChain: a chain that waits", () => {
  const c = readChain(log(BASE, [...ONE, [20, "five-hour window at 92% (no session starts at or over 90%): the next session starts when it resets 2026-11-16 05:00"]]));
  assert.deepEqual(c.wait, { until: new Date(2026, 10, 16, 5, 0).getTime(), text: "five-hour window at 92% (no session starts at or over 90%): the next session starts when it resets 2026-11-16 05:00" });
  assert.equal(c.events.at(-1).kind, "limit");
});

test("readChain: since leaves an earlier chain out", () => {
  const lines = log(BASE, [...ONE, [21, "chain ends: STOP: done"], [120, "chain starts in /r, from session 2"], [120, "session 02 starts: B"]]);
  const all = readChain(lines);
  assert.deepEqual(all.sessions.map((s) => s.n), [1, 2]);
  const c = readChain(lines, { since: BASE + 120 * MIN });
  assert.deepEqual(c.sessions.map((s) => s.n), [2]);
  assert.deepEqual(c.events.map((e) => e.kind), ["start"]);
  assert.equal(c.started, BASE + 120 * MIN);
  // No chain starts after since: since is the start.
  assert.equal(readChain(lines, { since: BASE + 100 * MIN }).started, BASE + 120 * MIN);
  assert.equal(readChain(log(BASE, [[130, "session 02 starts: B"]]), { since: BASE + 100 * MIN }).started, BASE + 100 * MIN);
  assert.equal(readChain(log(BASE, [[130, "session 02 starts: B"]])).started, BASE + 130 * MIN, "else the first line's stamp");
});

test("readChain: a chain across midnight", () => {
  const late = new Date(2026, 10, 16, 23, 50).getTime();
  const c = readChain(log(late, [[0, "chain starts in /r"], [0, "session 01 starts: A"], [30, "session 01 ends: success, 3 turns, $1.00"]]));
  const a = c.sessions[0].attempts[0];
  assert.ok(a.end > a.start);
  assert.equal(a.end - a.start, 30 * MIN);
});

test("readChain: only an end after the last start counts", () => {
  const ended = [...ONE, [21, "chain ends: STOP"]];
  assert.deepEqual(readChain(log(BASE, ended)).endLine, { t: BASE + 21 * MIN, reason: "STOP" });
  assert.equal(readChain(log(BASE, [...ended, [30, "chain starts in /r, from session 2"]])).endLine, null);
  assert.equal(readChain(log(BASE, ended)).events.at(-1).kind, "end");
});

test("readChain: a line nobody knows stays visible", () => {
  const c = readChain(log(BASE, [...ONE, [21, "session 04: something new"], [22, "a line with no session"], [23, "runner reloads its code; watcher 12 replaced"]]));
  assert.deepEqual(c.events.map((e) => e.kind), ["start", "other", "other", "reload"]);
  assert.equal(c.sessions.length, 1);
  assert.equal(c.sessions[0].attempts.length, 1);
  const long = readChain(log(BASE, [[0, `x ${"y".repeat(400)}`]]));
  assert.equal(long.events[0].text.length, 160);
});

test("readChain: session 100 comes after session 99", () => {
  const c = readChain(log(BASE, [[0, "session 100 starts: later"], [1, "session 99 starts: earlier"]]));
  assert.deepEqual(c.sessions.map((s) => s.n), [99, 100]);
});
