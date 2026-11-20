// The dashboard's data, page and files, built from state folders made by hand: no runner, no CLI, no browser.
// node --test scripts/dashboard.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tempRoot } from "./config.mjs";
import { parseSession } from "./run-read.mjs";
import { readChain, sessionBlock, blockSignature, BLOCK_KEYS, CACHE_VERSION, buildData, SCHEMA, gitLog, demoData, labelsFor, pageHtml, FILES, writeDashboard, refresh } from "./dashboard.mjs";
import { loadLang, langFile } from "./lang/index.mjs";
import en from "./lang/en.mjs";
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
  // since is the chain's start, before the runner's first line too: a page written while the run was scheduled and
  // one written after the runner logged its start are of one chain.
  assert.equal(readChain(lines, { since: BASE + 100 * MIN }).started, BASE + 100 * MIN);
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
  const repoDir = extra.tree || path.join(root, "repo");
  const prompts = path.join(state, "prompts");
  return {
    root, state, claude, proj, repoDir,
    log: (base, lines) => fs.writeFileSync(path.join(state, "chain.log"), lines.map(([m, text]) => `[${stamp(base + m * MIN)}] ${text}`).join("\n") + "\n"),
    pointer: (obj) => {
      const d = path.join(claude, "night-shift", "runs");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "repo-0000.json"), line({ state, ...obj }));
    },
    prompt: (name, text) => { fs.mkdirSync(prompts, { recursive: true }); fs.writeFileSync(path.join(prompts, name), text); },
    file: (name, text) => fs.writeFileSync(path.join(state, name), text),
    report: (text) => { fs.mkdirSync(repoDir, { recursive: true }); fs.writeFileSync(path.join(repoDir, "NIGHT_RUNS.md"), text); },
    // A repository whose commits were made at the given times (epoch ms).
    repo: (commits) => {
      fs.mkdirSync(repoDir, { recursive: true });
      const g = (args, env = {}) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repoDir, stdio: "ignore", env: { ...process.env, ...env } });
      g(["init", "-q"]);
      for (const [ms, subject] of commits) {
        const at = `${Math.floor(ms / 1000)} +0000`;
        g(["commit", "-q", "--allow-empty", "-m", subject], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
      }
    },
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
const call = (id, min, { input = 100, read = 1000, write = 50, output = 20, content = [], model = "claude-opus-5-5", sidechain = false, sid = SID, t0 = T0 } = {}) => ({
  type: "assistant", timestamp: iso(t0 + min * MIN), session_id: sid, parent_tool_use_id: null, ...(sidechain ? { isSidechain: true } : {}),
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

// ---------------------------------------------------------------- the data
const sid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Session n's stream: calls at the given minutes after base, and a result line when usd is given.
const streamOf = (n, base, mins, usd = null) => [
  init(sid(n)),
  ...mins.map((m, i) => call(`s${n}-m${i}`, m, { sid: sid(n), t0: base })),
  ...(usd == null ? [] : [{ ...result(usd, mins.length, { "claude-opus-5-5": MU(100, 20 * mins.length, usd) }), session_id: sid(n) }]),
];
const TWO = [
  [0, "chain starts in /r, until the work is done, from session 1, opus at xhigh"],
  [0, "session 01 starts: A"], [0, "session 01 runs Opus at xhigh"], [20, "session 01 ends: success, 5 turns, $2.00"],
  [21, "session 02 starts: B"], [21, "session 02 runs Opus at xhigh"], [40, "session 02 ends: success, 6 turns, $3.00"],
];
const LIVE = { pid: 4242, finished: false, scheduledAt: stamp(BASE - MIN) };
const build = (r, opt = {}) => buildData(r.state, { now: BASE + 120 * MIN, alive: () => true, ...opt });
function twoSessions(extra) {
  const r = fixtureRun(extra);
  r.stream(1, streamOf(1, BASE, [0, 5, 10], 2));
  r.stream(2, streamOf(2, BASE, [21, 30], 3));
  return r;
}
const TOP = ["schema", "generatedAt", "skillVersion", "lang", "demo", "chain", "now", "sessions", "gaps", "events", "limits", "messages", "waitsNow", "waitsOlder", "waitsFrom", "questions"];
const CHAIN = ["project", "repo", "mode", "attended", "branch", "tree", "state", "started", "ended", "endReason", "lastSeen", "waitUntil", "until", "next", "sessions", "attempts", "turns", "commits", "usd"];

test("buildData: a finished chain", () => {
  const r = twoSessions();
  r.log(BASE, [...TWO, [41, "chain ends: STOP: done"]]);
  r.pointer({ pid: 4242, finished: true, finishedAt: stamp(BASE + 41 * MIN), reason: "STOP: done" });
  const d = build(r);
  assert.equal(d.schema, SCHEMA);
  assert.equal(d.chain.state, "ended");
  assert.equal(d.chain.endReason, "STOP: done");
  assert.equal(d.chain.ended, BASE + 41 * MIN);
  assert.equal(d.chain.usd, 5);
  assert.equal(d.chain.sessions, 2);
  assert.equal(d.chain.attempts, 2);
  assert.equal(d.chain.turns, 5);
  assert.equal(d.now, null);
  assert.equal(d.chain.next, null);
  assert.equal(d.chain.project, "repo");
  assert.deepEqual(d.sessions.map((s) => [s.n, s.title, s.model, s.effort, s.usd, s.estimated]), [[1, "A", "Opus", "xhigh", 2, false], [2, "B", "Opus", "xhigh", 3, false]]);
  assert.deepEqual(Object.keys(d.sessions[0].attempts[0]), ["kind", "why", "start", "end", "endKnown", "outcome", "limitType", "turns", "usd", "h5", "d7"]);
  assert.equal(d.generatedAt, BASE + 120 * MIN);
});

test("buildData: a running session", () => {
  const r = twoSessions();
  r.stream(2, streamOf(2, BASE, [21, 25]));
  r.log(BASE, TWO.slice(0, -1));
  r.pointer(LIVE);
  const d = build(r, { now: BASE + 30 * MIN });
  assert.equal(d.chain.state, "running");
  assert.equal(d.now.n, 2);
  assert.equal(d.now.since, BASE + 21 * MIN);
  assert.equal(d.now.context, 1150);
  const s = d.sessions[1];
  assert.equal(s.estimated, true);
  assert.ok(s.usd > 0, String(s.usd));
  assert.ok(s.rows.every((x) => x.usd > 0));
  assert.equal(s.attempts[0].end, null);
  assert.equal(d.chain.usd, Math.round((2 + s.usd) * 100) / 100);
  assert.equal(d.chain.next, null);
});

test("buildData: the first session has no price yet", () => {
  const r = fixtureRun();
  r.stream(1, streamOf(1, BASE, [0, 3]));
  r.log(BASE, TWO.slice(0, 3));
  r.pointer(LIVE);
  const d = build(r, { now: BASE + 5 * MIN });
  assert.equal(d.sessions[0].usd, null);
  assert.equal(d.sessions[0].estimated, true);
  assert.ok(d.sessions[0].rows.every((x) => x.usd === null));
  assert.equal(d.chain.usd, 0);
});

test("buildData: a session that runs across midnight", () => {
  const late = new Date(2026, 10, 16, 23, 50).getTime();
  const r = fixtureRun();
  r.stream(1, streamOf(1, late, [0, 20]));
  r.log(late, [[0, "chain starts in /r"], [0, "session 01 starts: A"]]);
  r.pointer(LIVE);
  const d = buildData(r.state, { now: late + 30 * MIN, alive: () => true });
  assert.equal(d.chain.state, "running");
  assert.equal(d.now.since, late);
  assert.equal(d.generatedAt - d.now.since, 30 * MIN);
});

test("buildData: a usage-limit wait", () => {
  const r = fixtureRun();
  r.stream(1, streamOf(1, BASE, [0, 5]));
  r.log(BASE, CUT);
  r.file("resume.json", line({ nn: "01", sessionId: sid(1), why: "limit" }));
  r.pointer(LIVE);
  const d = build(r, { now: BASE + 30 * MIN });
  assert.equal(d.chain.state, "limit");
  assert.equal(d.chain.waitUntil, new Date(2026, 10, 16, 4, 1).getTime());
  assert.deepEqual(d.chain.next, { n: 1, resume: true });
  assert.deepEqual(d.gaps.at(-1), { from: BASE + 10 * MIN, to: null, kind: "limit", note: "usage limit: waiting until 2026-11-16 04:01:00" });
  // Once the wait is over and nothing ran yet, the chain is between sessions.
  assert.equal(build(r, { now: BASE + 62 * MIN }).chain.state, "between");
});

test("buildData: gaps name what the chain waited for", () => {
  const gapsOf = (lines) => { const r = fixtureRun(); r.log(BASE, lines); return build(r, { pointer: null }).gaps; };
  const limited = gapsOf([...CUT, [50, "session 01 resumes s1 after the usage limit"], [50, "session 01 runs Opus at xhigh"], [60, "session 01 ends: success, 17 turns, $7.05"]]);
  assert.deepEqual(limited, [{ from: BASE + 10 * MIN, to: BASE + 50 * MIN, kind: "limit", note: "usage limit: waiting until 2026-11-16 04:01:00" }]);
  assert.deepEqual(gapsOf([[0, "session 01 starts: A"], [10, "session 01 ends: success, 1 turns, $1.00"], [12, "session 02 starts: B"], [20, "session 02 ends: success, 1 turns, $1.00"]]), []);
  assert.deepEqual(gapsOf([[0, "session 01 starts: A"], [10, "session 01 ends: success, 1 turns, $1.00"], [20, "session 02 starts: B"], [30, "session 02 ends: success, 1 turns, $1.00"]]),
    [{ from: BASE + 10 * MIN, to: BASE + 20 * MIN, kind: "other", note: "" }]);
});

test("buildData: a runner that died", () => {
  const r = fixtureRun();
  r.stream(1, streamOf(1, BASE, [0, 5]));
  r.log(BASE, TWO.slice(0, 3));
  r.pointer(LIVE);
  const d = build(r, { alive: () => false });
  assert.equal(d.chain.state, "gone");
  assert.equal(d.chain.ended, null);
  assert.ok(Number.isFinite(d.chain.lastSeen));
  const a = d.sessions[0].attempts[0];
  assert.deepEqual({ outcome: a.outcome, endKnown: a.endKnown, usd: a.usd, end: a.end }, { outcome: "cut", endKnown: false, usd: null, end: d.sessions[0].lastSeen });
  assert.equal(d.now, null);
  assert.deepEqual(d.chain.next, { n: 2, resume: false });
});

test("buildData: a pointer marked finished without an end line", () => {
  const r = fixtureRun();
  r.stream(1, streamOf(1, BASE, [0, 5]));
  r.log(BASE, TWO.slice(0, 3));
  r.pointer({ ...LIVE, finished: true, finishedAt: stamp(BASE + 30 * MIN), reason: "stopped now by the user" });
  const d = build(r);
  assert.equal(d.chain.state, "ended");
  assert.equal(d.chain.endReason, "stopped now by the user");
  assert.equal(d.chain.ended, BASE + 30 * MIN);
  assert.equal(d.sessions[0].attempts[0].outcome, "cut");
});

test("buildData: a start not picked up yet", () => {
  const r = fixtureRun();
  r.log(BASE, [...ONE, [21, "chain ends: STOP: done"]]);
  r.pointer({ pid: 0, finished: false, scheduledAt: stamp(BASE + 60 * MIN) });
  assert.equal(build(r).chain.state, "scheduled");
  // A pointer scheduled before the end line is the run that ended.
  r.pointer({ pid: 0, finished: false, scheduledAt: stamp(BASE - 60 * MIN) });
  assert.equal(build(r).chain.state, "ended");
});

test("buildData: a cut attempt ends at its last sign of life", () => {
  const r = fixtureRun();
  r.stream(5, [...streamOf(5, BASE, [0, 20, 50]), ...streamOf(5, BASE, [91, 95], 4).slice(1)]);
  r.log(BASE, [[0, "chain starts in /r, from session 5"], [0, "session 05 starts: E"], [0, "session 05 runs Opus at xhigh"],
    [90, "chain starts in /r, until the work is done, from session 5"], [90, "session 05 resumes s5 where the last runner stopped"], [99, "session 05 ends: success, 9 turns, $4.00"]]);
  const d = build(r, { pointer: null });
  const [a, b] = d.sessions[0].attempts;
  assert.deepEqual([a.end, a.endKnown, a.outcome], [BASE + 50 * MIN, false, "cut"]);
  assert.equal(b.outcome, "success");
  assert.deepEqual(d.gaps, [{ from: BASE + 50 * MIN, to: BASE + 90 * MIN, kind: "down", note: "" }]);
});

test("buildData: a chain after a fresh start in a folder that holds an earlier one", () => {
  const lines = [...ONE, [21, "chain ends: STOP: done"], [120, "chain starts in /r"], [120, "session 02 starts: B"], [130, "session 02 ends: success, 2 turns, $1.00"]];
  const fresh = fixtureRun({ chainStartedAt: stamp(BASE + 120 * MIN) });
  fresh.log(BASE, lines);
  assert.deepEqual(build(fresh, { pointer: null, now: BASE + 140 * MIN }).sessions.map((s) => s.n), [2]);
  const whole = fixtureRun();
  whole.log(BASE, lines);
  assert.deepEqual(build(whole, { pointer: null, now: BASE + 140 * MIN }).sessions.map((s) => s.n), [1, 2]);
});

test("buildData: commits go to the session that made them", () => {
  const r = twoSessions();
  r.log(BASE, [...TWO, [41, "chain ends: STOP: done"]]);
  r.repo([[BASE + 5 * MIN, "feat: one"], [BASE + 20 * MIN + 30_000, "fix: between"], [BASE + 35 * MIN, "feat: two"], [BASE + 38 * MIN, "docs: night report 2026-11-16"]]);
  let calls = 0;
  const d = build(r, { pointer: null, gitLog: (...a) => { calls++; return gitLog(...a); } });
  assert.equal(calls, 1);
  assert.deepEqual(d.sessions.map((s) => s.commits.map((c) => c.s)), [["feat: one"], ["feat: two"]]);
  assert.equal(d.sessions[0].commits[0].t, BASE + 5 * MIN);
  assert.match(d.sessions[0].commits[0].h, /^[0-9a-f]{7,}$/);
  assert.equal(d.chain.commits, 2);
});

test("buildData: no repository is no error", () => {
  const r = twoSessions();
  r.log(BASE, TWO);
  const d = build(r, { pointer: null });
  assert.ok(d.sessions.every((s) => s.commits.length === 0));
  assert.equal(d.chain.commits, 0);
  assert.deepEqual(gitLog(path.join(r.root, "nowhere"), BASE, null), []);
  assert.deepEqual(gitLog(null, BASE, null), []);
});

test("buildData: a worktree run", () => {
  const root = fs.mkdtempSync(path.join(tempRoot(), "dash-tree-"));
  const r = twoSessions({ tree: path.join(root, "tree"), branch: "night/one" });
  r.log(BASE, TWO);
  let seen = null;
  const d = build(r, { pointer: null, gitLog: (tree) => { seen = tree; return []; } });
  assert.equal(d.chain.tree, path.join(root, "tree"));
  assert.equal(d.chain.branch, "night/one");
  assert.equal(seen, path.join(root, "tree"));
});

test("buildData: what waits now", () => {
  const r = twoSessions();
  r.log(BASE, TWO);
  r.report(["# Night runs", "", "## 2026-11-16 session 02 (03:21–03:40) · B", "", "**Remaining:** 3", "", "**Waits for you:**", "- a", "- b", ""].join("\n"));
  const d = build(r, { pointer: null });
  assert.deepEqual([d.waitsNow, d.waitsFrom, d.waitsOlder], [["a", "b"], 2, 0]);
  assert.deepEqual([d.sessions[1].remaining, d.sessions[1].waits], [3, ["a", "b"]]);
  assert.deepEqual([d.sessions[0].remaining, d.sessions[0].waits], [null, []]);
  r.file("next-prompt.md", "STOP: done\n**Waits for you**\n- one\n");
  const s = build(r, { pointer: null });
  assert.deepEqual([s.waitsNow, s.waitsFrom], [["one"], null]);
});

test("buildData: a STOP prompt's list is what waits, not its prose, its heading or its count", () => {
  const r = twoSessions();
  r.log(BASE, TWO);
  // The shape of a real chain's last prompt: a summary, a heading in the run's own words, the list, the count.
  r.file("next-prompt.md", ["STOP: the plan is done", "", "The last piece (session 33) fixed the review's findings; nothing is pushed.", "",
    "Waiting on you:", "- Still waiting (session 23): run `claude plugin validate .`, `docs/plan.md:134`.",
    "- Still waiting (session 04): copy your table,", "  then start again, `docs/plan.md:76`.", "1. Approve the release notes.", "",
    "**Remaining:** 0", ""].join("\n"));
  assert.deepEqual(build(r, { pointer: null }).waitsNow, ["Still waiting (session 23): run `claude plugin validate .`, `docs/plan.md:134`.",
    "Still waiting (session 04): copy your table, then start again, `docs/plan.md:76`.", "Approve the release notes."]);
  // With no list, the lines under the list's heading are the items, but the count; the prose above it is none.
  r.file("next-prompt.md", "STOP: done\n\nThe deploy key is in place.\n**Waits for you**\nCheck the logs.\n\n**Remaining:** 0\n");
  assert.deepEqual(build(r, { pointer: null }).waitsNow, ["Check the logs."]);
});

test("buildData: a STOP prompt that only says nothing waits shows nothing waiting", () => {
  const r = twoSessions();
  r.log(BASE, TWO);
  // 2026-11-20, a real chain's last prompt (in the run's language there): its one sentence was the single entry of
  // waitsNow, and the page said one thing waits
  r.file("next-prompt.md", "STOP: the plan is done\n\nBoth pieces of the plan are done: `23b37d4` notes: piece one, `d2a0129` notes: piece two, the night report `090d978`. Nothing waits for you.\n");
  const d = build(r, { pointer: null });
  assert.deepEqual([d.waitsNow, d.waitsFrom, d.waitsOlder], [[], null, 0]);
});

test("buildData: an attended run's questions", () => {
  const r = fixtureRun({ attended: true });
  r.log(BASE, ONE);
  r.file("questions.md", "Q1 · pick a name?\nQ2 · which color?\n");
  r.prompt("02-inbox.md", "[03:30 · Telegram] A1: yes\n");
  const d = build(r, { pointer: null });
  assert.deepEqual(d.questions, [{ id: "Q1", text: "pick a name?", answered: true }, { id: "Q2", text: "which color?", answered: false }]);
  assert.equal(d.chain.attended, true);
});

test("buildData: messages", () => {
  const r = twoSessions();
  r.log(BASE, TWO);
  r.prompt("01.md", "# Build the thing\n\nmore\n");
  r.prompt("02.md", "MODEL: fable\n\nNext piece\n");
  r.prompt("02-inbox.md", "a note\n");
  const d = build(r, { pointer: null });
  const m = [...d.messages].sort((a, b) => a.to - b.to || a.kind.localeCompare(b.kind));
  assert.deepEqual(m.map((x) => [x.kind, x.from, x.to, x.title]), [["handover", null, 1, "Build the thing"], ["handover", 1, 2, "Next piece"], ["inbox", null, 2, "a note"]]);
  assert.ok(m.every((x) => x.bytes > 0 && Number.isFinite(x.t)));
  // A prompt file written after its session started was rewritten (a resume): its message is dated at the start.
  assert.equal(m[1].t, BASE + 21 * MIN);
  assert.deepEqual(d.sessions.map((s) => s.inbox), [false, true]);
});

test("buildData: an unchanged session is not read again", () => {
  const r = twoSessions();
  r.log(BASE, TWO);
  let reads = 0;
  const readBlock = (s, n) => { reads++; return sessionBlock(s, n); };
  const count = (prev) => { reads = 0; const d = build(r, { pointer: null, prev, readBlock }); return [reads, d]; };
  const [first, d1] = count(null);
  assert.equal(first, 2);
  const [none, again] = count(d1);
  assert.equal(none, 0);
  assert.deepEqual(again.sessions, d1.sessions);
  fs.appendFileSync(path.join(r.state, "session-02.jsonl"), jl([call("s2-m9", 39, { sid: sid(2), t0: BASE })]));
  const [one, d2] = count(d1);
  assert.equal(one, 1);
  assert.deepEqual(d2.sessions, build(r, { pointer: null }).sessions, "the same as a cold build");
  const p = structuredClone(d2);
  p.sessions[0].src.v = 0;
  assert.equal(count(p)[0], 1);
  assert.equal(count({ schema: 2, sessions: d2.sessions })[0], 2);
  assert.equal(count("x")[0], 2);
});

test("buildData: every key is there for the barest folder", () => {
  const state = fs.mkdtempSync(path.join(tempRoot(), "dash-bare-"));
  fs.writeFileSync(path.join(state, "run.json"), line({ repo: path.join(state, "repo"), lang: "en" }));
  fs.writeFileSync(path.join(state, "chain.log"), "");
  const d = buildData(state, { now: BASE, pointer: null });
  assert.deepEqual(Object.keys(d), TOP);
  assert.deepEqual(Object.keys(d.chain), CHAIN);
  for (const k of ["sessions", "gaps", "events", "limits", "messages", "waitsNow", "questions"]) assert.deepEqual(d[k], [], k);
  assert.equal(d.chain.state, "gone");
  assert.equal(d.now, null);
  assert.deepEqual([d.chain.sessions, d.chain.attempts, d.chain.usd, d.chain.commits, d.waitsOlder, d.waitsFrom], [0, 0, 0, 0, 0, null]);
  assert.equal(d.demo, false);
});

// ---------------------------------------------------------------- the demo
// A value's shape: an object's sorted keys with each value's shape, a list as the union of its items' shapes ("none"
// for no items), anything else "v". In a union a leaf gives way to a list or an object (a window that is null in one
// session and read in another). The keys under tools and src are data, not shape.
const FREE = new Set(["tools", "src"]);
const merge = (a, b) => {
  if (typeof a === "string") return b === "none" ? a : b;
  if (typeof b === "string") return a;
  const out = {};
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) out[k] = k in a && k in b ? merge(a[k], b[k]) : (a[k] ?? b[k]);
  return out;
};
function keyShape(v) {
  if (Array.isArray(v)) return { "[]": v.map(keyShape).reduce(merge, "none") };
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, FREE.has(k) ? "free" : keyShape(v[k])]));
  return "v";
}
// Every string and number in a value, walked.
const leaves = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => leaves(x, out));
  else out.push(v);
  return out;
};
// Session n's stream: a Bash call (refused by the guard when deny), an Agent call per name in agents, their task lines
// (finished ones end two minutes after their start), limit windows, and a result line when usd is given.
function fullStream(n, m0, { usd = null, deny = false, agents = ["look"], running = [] } = {}) {
  const S = sid(n), o = { sid: S, t0: BASE }, sys = (j) => ({ type: "system", session_id: S, ...j });
  const refusal = "PreToolUse:Bash hook error: night-shift guard: rm -rf on a path outside the work tree. Do not work around it; stop.";
  return [
    init(S),
    call(`f${n}-1`, m0, { ...o, content: [use(`b${n}`, "Bash", { command: "ls", description: "list" })] }),
    limitEvent(0.1, 0.3),
    { type: "user", session_id: S, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `b${n}`, is_error: deny, content: deny ? refusal : "ok" }] } },
    ...agents.flatMap((a, i) => [
      call(`f${n}-a${i}`, m0 + 1 + i, { ...o, content: [use(`g${n}${i}`, "Agent", { description: a, subagent_type: "Explore", model: "haiku" })] }),
      sys({ subtype: "task_started", task_id: `a${n}${i}`, tool_use_id: `g${n}${i}`, task_type: "local_agent", description: a, subagent_type: "Explore", is_backgrounded: false }),
      sys({ subtype: "task_progress", task_id: `a${n}${i}`, tool_use_id: `g${n}${i}`, usage: { total_tokens: 4000, tool_uses: 2 } }),
      ...(running.includes(a) ? [] : [sys({ subtype: "task_updated", task_id: `a${n}${i}`, patch: { status: "completed", end_time: BASE + (m0 + 3 + i) * MIN } })]),
    ]),
    limitEvent(0.2, 0.31),
    ...(usd == null ? [] : [{ ...result(usd, 4, { "claude-opus-5-5": MU(300, 40, usd - 0.5), "claude-haiku-5-5": MU(50, 30, 0.5) }), session_id: sid(n) }]),
  ];
}
// A running chain that fills every list the data has: session 1 refused once, session 2 cut by a usage limit and
// resumed, session 3 running with one agent finished and two in progress; commits, report sections with waits, handover
// prompts and an inbox note, limit lines and a line nobody knows.
function fullRun() {
  const r = fixtureRun();
  for (const [n, m0, opt] of [[1, 0, { usd: 2, deny: true }], [2, 50, { usd: 2.5 }], [3, 61, { agents: ["tests", "docs", "sync"], running: ["docs", "sync"] }]]) {
    r.stream(n, fullStream(n, m0, opt));
    r.transcript(sid(n), [call(`f${n}-1`, m0, { sid: sid(n), t0: BASE })]);
    r.agent(sid(n), `agent-a${n}0`, [call(`x${n}`, m0 + 1, { sid: sid(n), t0: BASE, model: "claude-haiku-5-5", input: 50, read: 0, write: 0, output: 10, sidechain: true })]);
  }
  r.log(BASE, [
    [0, "chain starts in /r, until the work is done, from session 1, opus at xhigh"],
    [0, "session 01 starts: A"], [0, "session 01 runs Opus at xhigh"], [10, "session 01 ends: success, 4 turns, $2.00"],
    [10, "session 01 limits: 5h 10%→20% · 7d 30%→31%; it ran on claude-opus-5-5"],
    [11, "session 02 starts: B"], [11, "session 02 runs Opus at xhigh"], [20, "session 02 ends: success (error), 1 turns, $1.00"],
    [20, "session 02: five_hour cut it off; limit record {\"status\":\"rejected\"}"],
    [20, `usage limit: waiting until ${stamp(BASE + 50 * MIN)}`],
    [50, "session 02 resumes s2 after the usage limit"], [50, "session 02 runs Opus at xhigh"], [60, "session 02 ends: success, 4 turns, $2.50"],
    [61, "session 03 starts: C"], [61, "session 03 runs Opus at xhigh"], [62, "a line nobody knows"],
  ]);
  r.pointer(LIVE);
  r.repo([[BASE + 5 * MIN, "feat: one"], [BASE + 55 * MIN, "feat: two"], [BASE + 70 * MIN, "feat: three"]]);
  r.report(["# Night runs", "",
    "## 2026-11-16 session 01 (03:00–03:10) · A", "", "**Remaining:** 3", "", "**Waits for you:**", "- a", "",
    "## 2026-11-16 session 02 (03:11–04:00) · B", "", "**Remaining:** 2", "", "**Waits for you:**", "- a", "- b", ""].join("\n"));
  r.prompt("01.md", "# Build the thing\n");
  r.prompt("02.md", "Next piece\n");
  r.prompt("03.md", "Last piece\n");
  r.prompt("03-inbox.md", "a note\n");
  return r;
}

test("the demo is the data's shape", () => {
  const d = build(fullRun());
  // The fixture fills what the demo shows, so that a key the demo lacks is not hidden by an empty list.
  assert.equal(d.chain.state, "running");
  assert.ok(d.gaps.length && d.limits.length && d.messages.length && d.waitsNow.length && d.events.length);
  assert.ok(d.sessions.some((s) => s.denialNotes.length) && d.sessions.some((s) => s.commits.length) && d.sessions.some((s) => s.subagents.some((a) => a.end == null)));
  const demo = demoData();
  assert.equal(demo.schema, SCHEMA);
  assert.deepEqual(keyShape(demo), keyShape(d));
});

test("the demo is what the spec says", () => {
  const d = demoData();
  assert.equal(d.demo, true);
  assert.equal(d.chain.state, "running");
  assert.equal(d.now.n, 7);
  assert.equal(d.sessions.find((s) => s.n === 7).subagents.filter((a) => a.end === null).length, 2);
  assert.equal(d.gaps.filter((g) => g.kind === "limit").length, 1);
  assert.ok(d.sessions.some((s) => s.attempts.some((a) => a.kind === "resume")));
  assert.equal(d.sessions.filter((s) => s.denials === 1).length, 1);
  assert.equal(d.waitsNow.length, 2);
  // Every epoch time lies before the frozen moment (token counts stay far below 1e12).
  const late = leaves(d).filter((v) => typeof v === "number" && v > 1e12 && v > d.generatedAt);
  assert.deepEqual(late, []);
});

test("the demo names nothing real", () => {
  const d = demoData();
  const texts = leaves(d).filter((v) => typeof v === "string");
  for (const s of texts) {
    assert.doesNotMatch(s, /\b[A-Za-z]:[\\/]|\/Users\/|AppData|@/, s);
    if (s.startsWith("/")) assert.ok(s.startsWith("/home/sam/demo-app"), s);
  }
  assert.equal(d.chain.project, "demo-app");
});

// ---------------------------------------------------------------- the page
const TEMPLATE = path.join(HERE, "..", "assets", "dashboard.html");
const template = () => fs.readFileSync(TEMPLATE, "utf8");
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' file:; style-src 'unsafe-inline'; img-src data:">`;
// The template without its script and style blocks: the markup a browser shows before any script ran.
const markup = () => template().replace(/<script\b[\s\S]*?<\/script>/g, "").replace(/<style\b[\s\S]*?<\/style>/g, "");
// What a page embeds under an id, parsed as the page's script parses it.
const embedded = (html, id) => JSON.parse(new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`).exec(html)[1]);

test("the page reaches nothing outside itself", () => {
  const html = template();
  assert.deepEqual([...new Set(html.match(/https?:\/\/[^\s"'<>)]*/g))], ["http://www.w3.org/2000/svg"]);
  assert.ok(html.includes(CSP), "the Content-Security-Policy line as measured");
  assert.doesNotMatch(html, /@import|url\(|<link\b|<iframe\b|<img\b|<object\b|<embed\b/);
});

test("the page never writes markup", () => {
  const html = template();
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) assert.ok(!html.includes(bad), bad);
});

test("the template holds no word of its own", () => {
  const text = markup().replace(/<[^>]*>/g, "").replace(/night-shift/g, "");
  assert.deepEqual(text.match(/[A-Za-z]{2,}/g) ?? [], []);
  // nor in an attribute a reader meets
  assert.deepEqual(markup().match(/\b(?:aria-label|placeholder|title|alt)="[^"]*"/g) ?? [], []);
});

test("every word the page uses is in the table, and none is left over", () => {
  const used = [...new Set([...template().matchAll(/\bt\("([A-Za-z0-9]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(used.length > 50, `${used.length} keys found`);
  assert.deepEqual(used, Object.keys(en.dash).sort());
});

test("a run's text is embedded as data", () => {
  const data = demoData();
  data.sessions[0].title = "</script><img src=x onerror=alert(1)><!--";
  data.sessions[0].commits[0].s = "a $& b $' c $1 $` d";
  const labels = labelsFor("en");
  const html = pageHtml(data, labels);
  const count = (s) => s.split("</script>").length - 1;
  assert.equal(count(html), count(template()));
  assert.ok(!html.includes("<img src=x") && !html.includes("<!--<"));
  assert.deepEqual(embedded(html, "chain-data"), data);
  assert.deepEqual(embedded(html, "labels"), labels);
  assert.ok(!html.includes("/*__DATA__*/") && !html.includes("/*__LABELS__*/"));
  // only the two places changed
  const [head, rest] = template().split("/*__DATA__*/"), [mid, tail] = rest.split("/*__LABELS__*/");
  assert.ok(html.startsWith(head) && html.includes(mid) && html.endsWith(tail));
});

// The made-up table as a user's own, loaded as the scripts load it (lang.test.mjs does the same).
async function loadXx() {
  const home = fs.mkdtempSync(path.join(tempRoot(), "ns-dash-lang-"));
  const file = langFile("xx", home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(path.join(HERE, "fixtures", "lang-xx.mjs"), file);
  assert.equal((await loadLang("xx", home)).error, undefined);
}

test("a run in another language carries both sets", async () => {
  await loadXx();
  const l = labelsFor("xx");
  assert.equal(l.start, "xx");
  assert.deepEqual(Object.keys(l.sets), ["xx", "en"]);
  assert.deepEqual(l.sets.en, { code: "en", name: "English", words: en.dash });
  assert.equal(l.sets.xx.code, "xx");
  assert.equal(l.sets.xx.name, "Xxish");
  // the fixture gives two of the keys; every other reads English
  assert.deepEqual(l.sets.xx.words, { ...en.dash, waitsHead: "xx·waits for you", stateRunning: "xx·running" });
});

test("the switch names a language in the language itself, and by its name when the table gives none", async () => {
  // 2026-11-20: the page's switch read "Turkish" beside "English" for the user's Turkish table
  const home = fs.mkdtempSync(path.join(tempRoot(), "ns-dash-native-"));
  const put = (code, text) => { fs.mkdirSync(path.dirname(langFile(code, home)), { recursive: true }); fs.writeFileSync(langFile(code, home), text); };
  put("xn", "export default { name: 'Xnnish', nativeName: 'Xnçe', dash: { stateRunning: 'xn·running' } };\n");
  put("xo", "export default { name: 'Xoish', dash: { stateRunning: 'xo·running' } };\n");
  for (const code of ["xn", "xo"]) assert.equal((await loadLang(code, home)).error, undefined);
  assert.equal(labelsFor("xn").sets.xn.name, "Xnçe");
  assert.equal(labelsFor("xo").sets.xo.name, "Xoish");
  assert.equal(labelsFor("xn").sets.en.name, "English");
  // the page shows a set's name as it comes: no word of the template names a language
  assert.match(template(), /text: LABELS\.sets\[code\]\.name \|\| code/);
});

test("an English run carries one set", async () => {
  await loadXx();
  assert.deepEqual(labelsFor("en"), { start: "en", sets: { en: { code: "en", name: "English", words: en.dash } } });
  const l = labelsFor("en", { also: "xx" });
  assert.equal(l.start, "en");
  assert.deepEqual(Object.keys(l.sets), ["en", "xx"]);
  assert.deepEqual(Object.keys(labelsFor("en", { also: "en" }).sets), ["en"]);
});

test("a language whose table was not loaded reads as English", () => {
  // strings() gives English for a code nothing loaded: one set, no switch between two columns of the same words
  assert.deepEqual(Object.keys(labelsFor("zz").sets), ["en"]);
  assert.equal(labelsFor("zz").start, "en");
  assert.deepEqual(Object.keys(labelsFor("en", { also: "zz" }).sets), ["en"]);
});

// ---------------------------------------------------------------- the files
const tmpsIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
const fileOf = (r, name) => fs.readFileSync(path.join(r.state, name), "utf8");
function finishedRun() {
  const r = twoSessions();
  r.log(BASE, [...TWO, [41, "chain ends: STOP: done"]]);
  r.pointer({ pid: 4242, finished: true, finishedAt: stamp(BASE + 41 * MIN), reason: "STOP: done" });
  return r;
}

test("three files, the two data files from one string", async () => {
  const r = finishedRun();
  const out = await refresh(r.state, { page: true, now: BASE + 120 * MIN, alive: () => true });
  const json = fileOf(r, FILES.json);
  assert.equal(fileOf(r, FILES.js), `nightShiftData(${json});\n`);
  assert.deepEqual(embedded(fileOf(r, FILES.page), "chain-data"), JSON.parse(json));
  assert.deepEqual(out.data, JSON.parse(json));
  assert.equal(out.wrote, true);
  assert.equal(out.file, path.join(r.state, FILES.page));
  assert.deepEqual(tmpsIn(r.state), []);
});

test("a rename that fails keeps the old file", () => {
  const r = finishedRun();
  const data = build(r);
  writeDashboard(r.state, data);
  const before = fileOf(r, FILES.json);
  const rename = (from, to) => { if (path.basename(to) === FILES.json) throw new Error("EBUSY: held by a reader"); fs.renameSync(from, to); };
  const out = writeDashboard(r.state, { ...data, generatedAt: data.generatedAt + MIN }, { rename });
  assert.equal(out.json, false);
  assert.equal(out.js, true);
  assert.equal(out.page, false);
  assert.equal(fileOf(r, FILES.json), before);
  assert.deepEqual(tmpsIn(r.state), []);
});

test("two writers do not share a temporary name", () => {
  const r = finishedRun();
  const other = path.join(r.state, `${FILES.json}.1.tmp`);
  fs.writeFileSync(other, "another writer's");
  assert.equal(writeDashboard(r.state, build(r)).json, true);
  assert.equal(fs.readFileSync(other, "utf8"), "another writer's");
  assert.deepEqual(tmpsIn(r.state), [`${FILES.json}.1.tmp`]);
});

test("an earlier chain's page is kept under its date", async () => {
  const r = finishedRun();
  // the folder holds the page and data of a chain started at 03:00 on 2026-11-16
  r.file(FILES.json, JSON.stringify({ schema: SCHEMA, chain: { started: BASE } }));
  r.file(FILES.page, "the earlier chain's page");
  // and a new chain started there a day later
  r.log(BASE + 1440 * MIN, [...TWO, [41, "chain ends: STOP: done"]]);
  await refresh(r.state, { page: true, now: BASE + 1560 * MIN, alive: () => true });
  assert.equal(fileOf(r, "dashboard-20261116-0300.html"), "the earlier chain's page");
  assert.equal(embedded(fileOf(r, FILES.page), "chain-data").chain.started, BASE + 1440 * MIN);
  // the same chain's page is simply replaced
  await refresh(r.state, { page: true, now: BASE + 1561 * MIN, alive: () => true });
  assert.deepEqual(fs.readdirSync(r.state).filter((f) => /^dashboard-\d/.test(f)), ["dashboard-20261116-0300.html"]);
});

test("a page written before the runner logged its start stays the chain's page", async () => {
  // start, then dashboard while the scheduler has not started the runner yet
  const r = fixtureRun({ chainStartedAt: stamp(BASE) });
  r.pointer({ pid: 0, finished: false, scheduledAt: stamp(BASE) });
  const before = (await refresh(r.state, { page: true, now: BASE + 0.5 * MIN, alive: () => false })).data;
  assert.equal(before.chain.state, "scheduled");
  // the runner starts a minute later and the watcher writes again
  r.log(BASE, [[1, "chain starts in /r, until the work is done, from session 1"], [1, "session 01 starts: A"]]);
  r.pointer({ pid: 4242, finished: false, scheduledAt: stamp(BASE) });
  const after = (await refresh(r.state, { page: true, now: BASE + 2 * MIN, alive: () => true })).data;
  assert.equal(after.chain.state, "running");
  // one chain: the page open since the first write takes the new data (dashboard.html's take()), and no dated page
  assert.equal(after.chain.started, before.chain.started);
  assert.deepEqual(fs.readdirSync(r.state).filter((f) => /^dashboard-\d/.test(f)), []);
});

test("a pass with nothing new writes nothing", async () => {
  const r = finishedRun();
  const at = BASE + 120 * MIN, opt = { alive: () => true };
  assert.equal((await refresh(r.state, { now: at, ...opt })).wrote, true);
  const again = await refresh(r.state, { now: at, ...opt });
  assert.equal(again.wrote, false);
  assert.equal(again.data.generatedAt, at);
  assert.equal((await refresh(r.state, { now: at + 61_000, ...opt })).wrote, true);
  fs.appendFileSync(path.join(r.state, "chain.log"), `[${stamp(BASE + 42 * MIN)}] runner reloads its code\n`);
  assert.equal((await refresh(r.state, { now: at + 61_000, ...opt })).wrote, true);
  // a page or a forced pass always writes
  assert.equal((await refresh(r.state, { now: at + 61_000, force: true, ...opt })).wrote, true);
  assert.equal((await refresh(r.state, { now: at + 61_000, page: true, ...opt })).wrote, true);
});

test("a broken dashboard.json is a full build", async () => {
  const r = finishedRun();
  r.file(FILES.json, "{");
  const out = await refresh(r.state, { now: BASE + 120 * MIN, alive: () => true });
  assert.equal(out.wrote, true);
  const d = JSON.parse(fileOf(r, FILES.json));
  assert.equal(d.schema, SCHEMA);
  assert.deepEqual(d.sessions.map((s) => [s.n, s.usd]), [[1, 2], [2, 3]]);
});
