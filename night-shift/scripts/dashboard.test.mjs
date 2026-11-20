// The dashboard's data, page and files, built from state folders made by hand: no runner, no CLI, no browser.
// node --test scripts/dashboard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempRoot } from "./config.mjs";
import { parseSession } from "./run-read.mjs";
import { readChain, sessionBlock, blockSignature, BLOCK_KEYS, CACHE_VERSION } from "./dashboard.mjs";
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

// ---------------------------------------------------------------- a session's block
const line = (j) => JSON.stringify(j);
const jl = (lines) => lines.map((l) => (typeof l === "string" ? l : line(l))).join("\n") + "\n";
const nn = (n) => String(n).padStart(2, "0");
// A run made by hand under tempRoot(): state/ with a run.json that names the fixture's own Claude folder, whose
// projects/p/ holds the transcripts. Later tests add to it.
function fixtureRun(extra = {}) {
  const root = fs.mkdtempSync(path.join(tempRoot(), "dash-"));
  const state = path.join(root, "state"), claude = path.join(root, "claude"), proj = path.join(claude, "projects", "p");
  for (const d of [state, proj]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(state, "run.json"), line({ claudeConfigDir: claude, lang: "en", repo: path.join(root, "repo"), ...extra }));
  return {
    root, state, claude, proj,
    stream: (n, lines) => fs.writeFileSync(path.join(state, `session-${nn(n)}.jsonl`), jl(lines)),
    transcript: (sid, lines) => fs.writeFileSync(path.join(proj, `${sid}.jsonl`), jl(lines)),
    agent: (sid, name, lines) => {
      const d = path.join(proj, sid, "subagents");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${name}.jsonl`), jl(lines));
    },
  };
}
const SID = "00000000-0000-4000-8000-000000000001";
const T0 = Date.UTC(2026, 10, 16, 1, 0);
const iso = (ms) => new Date(ms).toISOString();
const init = (sid = SID) => ({ type: "system", subtype: "init", session_id: sid, model: "claude-opus-5-5" });
const call = (id, min, { input = 100, read = 1000, write = 50, output = 20, content = [], model = "claude-opus-5-5", sidechain = false, sid = SID } = {}) => ({
  type: "assistant", timestamp: iso(T0 + min * MIN), session_id: sid, parent_tool_use_id: null, ...(sidechain ? { isSidechain: true } : {}),
  message: { id, model, role: "assistant", content, usage: { input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, output_tokens: output } },
});
const use = (id, name, input = {}) => ({ type: "tool_use", id, name, input });
const MU = (input, output, costUSD) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD });
const result = (usd, turns, modelUsage) => ({ type: "result", subtype: "success", is_error: false, num_turns: turns, session_id: SID, total_cost_usd: usd, modelUsage });
const limitEvent = (h5, d7) => ({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: { five_hour: { utilization: h5 }, seven_day: { utilization: d7 } } } });
// Two main-thread calls (Bash; Read and an Agent call), the agent a1 on Haiku started, reported and finished.
const SESSION = [
  init(),
  call("msg_1", 0, { content: [use("tu1", "Bash", { command: "ls", description: "list" })] }),
  limitEvent(0.1, 0.3),
  { type: "user", session_id: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } },
  call("msg_2", 5, { input: 200, read: 3000, content: [use("tu2", "Read", { file_path: "/r/a.md" }), use("tu3", "Agent", { description: "look", subagent_type: "Explore", model: "haiku" })] }),
  { type: "user", session_id: SID, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu3", content: "launched" }] }, tool_use_result: { agentId: "a1", resolvedModel: "claude-haiku-5-5" } },
  { type: "system", subtype: "task_started", task_id: "a1", tool_use_id: "tu3", task_type: "local_agent", description: "look", subagent_type: "Explore", is_backgrounded: false, session_id: SID },
  { type: "system", subtype: "task_progress", task_id: "a1", tool_use_id: "tu3", usage: { total_tokens: 5000, tool_uses: 2 }, session_id: SID },
];
const FINISH = [
  { type: "system", subtype: "task_updated", task_id: "a1", patch: { status: "completed", end_time: T0 + 9 * MIN }, session_id: SID },
  { type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "tu3", status: "completed", usage: { total_tokens: 6000, tool_uses: 3 }, session_id: SID },
  limitEvent(0.2, 0.31),
  result(2, 9, { "claude-opus-5-5": MU(300, 40, 1.5), "claude-haiku-5-5": MU(50, 30, 0.5) }),
];
function sessionFixture(stream) {
  const r = fixtureRun();
  r.stream(1, stream);
  r.transcript(SID, [call("msg_1", 0), call("msg_2", 5, { input: 200, read: 3000 })]);
  r.agent(SID, "agent-a1", [call("msg_a1", 6, { model: "claude-haiku-5-5", input: 50, read: 0, write: 0, output: 10, sidechain: true })]);
  return r;
}

test("sessionBlock: a finished session", () => {
  const r = sessionFixture([...SESSION, ...FINISH]);
  const b = sessionBlock(r.state, 1);
  assert.equal(b.usd, 2);
  assert.equal(b.estimated, false);
  assert.equal(b.turns, 9);
  assert.equal(b.calls, 2);
  assert.deepEqual(b.rows.map((x) => x.kind).sort(), ["main", "sub"]);
  assert.equal(Math.round(b.rows.reduce((s, x) => s + x.usd, 0) * 100) / 100, 2);
  for (const k of ["input", "cacheRead", "cacheWrite", "output"]) assert.equal(b.tokens[k], b.rows.reduce((s, x) => s + x[k], 0), k);
  assert.deepEqual(b.tools, { Bash: 1, Read: 1, Agent: 1 });
  assert.equal(b.subagents.length, 1);
  assert.deepEqual(b.subagents[0], { description: "look", type: "Explore", model: "haiku", start: T0 + 5 * MIN, end: T0 + 9 * MIN, tokens: 6000, toolUses: 3, background: false, status: "completed" });
  assert.deepEqual(b.context, [[T0, 1150], [T0 + 5 * MIN, 3250]]);
  assert.equal(b.contextPeak, 3250);
  assert.equal(b.lastStep, "look");
  assert.deepEqual(b.windows, { first: { t: T0, h5: 10, d7: 30 }, last: { t: T0 + 5 * MIN, h5: 20, d7: 31 } });
  assert.equal(b.denials, 0);
  assert.deepEqual(b.denialNotes, []);
  assert.equal(b.src.v, CACHE_VERSION);
  assert.equal(b.src.sid, SID);
  assert.equal(b.src.base, path.join(r.proj, SID));
  assert.equal(typeof b.src.sig, "string");
  assert.ok(Number.isFinite(b.lastSeen));
  assert.deepEqual(Object.keys(b).sort(), [...BLOCK_KEYS].sort());
});

test("sessionBlock: a running session", () => {
  const r = sessionFixture(SESSION);
  const b = sessionBlock(r.state, 1);
  assert.equal(b.usd, null);
  assert.equal(b.estimated, true);
  assert.equal(b.turns, null);
  for (const x of b.rows) {
    assert.equal(x.usd, null);
    assert.equal(x.estimated, true);
    assert.ok(x.units > 0);
  }
  assert.equal(b.subagents[0].end, null);
  assert.equal(b.subagents[0].tokens, 5000);
});

test("sessionBlock: the context is thinned and keeps its peak", () => {
  const r = fixtureRun();
  const calls = Array.from({ length: 200 }, (_, i) => call(`m${i}`, i, { input: 10, read: i === 136 ? 90_000 : 1000 + i, write: 0 }));
  r.stream(1, [init(), ...calls]);
  const b = sessionBlock(r.state, 1);
  assert.ok(b.context.length <= 60, String(b.context.length));
  assert.deepEqual(b.context[0], [T0, 1010]);
  assert.deepEqual(b.context.at(-1), [T0 + 199 * MIN, 1209]);
  assert.ok(b.context.some(([t, v]) => t === T0 + 136 * MIN && v === 90_010));
  assert.equal(b.contextPeak, 90_010);
  assert.equal(b.calls, 200);
  for (let i = 1; i < b.context.length; i++) assert.ok(b.context[i][0] > b.context[i - 1][0], "in time order");
});

test("sessionBlock: only the guard's own refusal counts", () => {
  const r = fixtureRun();
  fs.copyFileSync(path.join(HERE, "fixtures", "session-guard-text-2026-11-19.jsonl"), path.join(r.state, "session-01.jsonl"));
  const b = sessionBlock(r.state, 1);
  assert.equal(b.denials, parseSession(r.state, "01").denials.length);
  assert.ok(b.denials > 0 && b.denials < 7, `the fixture holds 7 guard texts, ${b.denials} of them refusals`);
  assert.equal(b.denialNotes.length, b.denials);
});

test("sessionBlock: a stream that is not there, empty, or cut mid-line", () => {
  const r = fixtureRun();
  fs.writeFileSync(path.join(r.state, "session-02.jsonl"), "");
  for (const b of [sessionBlock(r.state, 1), sessionBlock(r.state, 2)]) {
    assert.equal(b.calls, 0);
    assert.deepEqual([b.rows, b.context, b.subagents, b.denialNotes, b.tools], [[], [], [], [], {}]);
    assert.deepEqual([b.usd, b.turns, b.contextPeak, b.lastStep, b.windows], [null, null, 0, null, { first: null, last: null }]);
    assert.equal(b.estimated, true);
    assert.deepEqual(Object.keys(b).sort(), [...BLOCK_KEYS].sort());
  }
  assert.equal(sessionBlock(r.state, 1).lastSeen, null, "no stream, no sign of life");
  r.stream(3, [init(), call("m1", 0), call("m2", 1)]);
  fs.appendFileSync(path.join(r.state, "session-03.jsonl"), '{"type":"assistant","message":{"id":"m3","usa');
  assert.equal(sessionBlock(r.state, 3).calls, 2);
});

test("blockSignature: it moves with the files", () => {
  const r = sessionFixture(SESSION);
  const a = blockSignature(r.state, 1);
  assert.equal(a.sid, SID);
  assert.equal(a.base, path.join(r.proj, SID));
  assert.deepEqual(blockSignature(r.state, 1), a, "nothing changed");
  fs.appendFileSync(path.join(r.state, "session-01.jsonl"), jl([call("msg_3", 9)]));
  const b = blockSignature(r.state, 1);
  assert.notEqual(b.sig, a.sig, "a stream line");
  r.agent(SID, "agent-a2", [call("msg_a2", 9, { model: "claude-haiku-5-5", sidechain: true })]);
  const c = blockSignature(r.state, 1);
  assert.notEqual(c.sig, b.sig, "a new agent file");
  assert.deepEqual(blockSignature(r.state, 1, { v: CACHE_VERSION, sid: SID, base: a.base }), c, "known gives the same");
  // With an earlier src the stream's head is not read: its session id is taken as it is.
  assert.equal(blockSignature(r.state, 1, { v: CACHE_VERSION, sid: "kept", base: null }).sid, "kept");
  const none = blockSignature(r.state, 9);
  assert.deepEqual([none.sid, none.base], [null, null], "no stream");
});

test("sessionBlock: a session's heartbeats", () => {
  const r = fixtureRun();
  r.stream(1, [init(), call("m1", 0), call("m2", 1), call("m3", 7), call("m4", 40)]);
  assert.deepEqual(sessionBlock(r.state, 1).src.beats, [T0 + 1 * MIN, T0 + 7 * MIN, T0 + 40 * MIN]);
});

test("sessionBlock: a three-digit session finds its stream", () => {
  const r = fixtureRun();
  r.stream(100, [init(), call("m1", 0)]);
  assert.ok(sessionBlock(r.state, 100).calls > 0);
});
