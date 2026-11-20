// The dashboard: a run's state folder turned into one data object (dashboard.json), a page that shows it (dashboard.html,
// from assets/dashboard.html) and a script-wrapped copy of the data the page reloads while the run is live
// (dashboard-data.js). No model call: everything is read from the files the runner and the sessions already write.
// The watcher (night-report.mjs) and the runner (night-chain.mjs) load this module with import(); both end in a
// top-level await when they are the entry module, so this module and everything it imports stay clear of both
// (run-read.mjs holds the readers they share).
import fs from "node:fs";
import path from "node:path";
import { when, LOG, parseSession, transcriptBase } from "./run-read.mjs";

const cut = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cents = (x) => Math.round(x * 100) / 100;
const stampOf = (at) => when(at).getTime();
// "5h 10%→20%" in a session's limits line (session-outcome.mjs, windowSpan); "?" for a window the stream did not report.
const span = (key, text) => {
  const m = new RegExp(`(?:^|· )${key} (\\?|\\d+)%?→(\\?|\\d+)%?`).exec(text);
  const num = (v) => (v === "?" ? null : Number(v));
  return m ? [num(m[1]), num(m[2])] : null;
};
const RESUME_WHY = [[/where the last runner stopped/, "stopped"], [/after the error/, "error"], [/after the usage limit/, "limit"]];

// ---------------------------------------------------------------- the log
// chain.log as sessions and their attempts, one pass. events: chainEvents' list ({ at, text }); since: epoch ms, the
// chain's start (run.json's chainStartedAt), before which no line is read. Each try of a session number is an attempt:
// start, resume (after a usage limit, an error or a runner that stopped) or retry (the number started again). An attempt
// that a new runner's "chain starts" finds open was cut off: its end is not known from the log.
export function readChain(events, { since = null } = {}) {
  const sessions = new Map(), out = [], limits = [];
  let started = null, firstLine = null, lastLine = null, endLine = null, wait = null, open = null;
  const session = (n) => {
    if (!sessions.has(n)) sessions.set(n, { n, title: null, model: null, effort: null, attempts: [] });
    return sessions.get(n);
  };
  const event = (t, kind, text) => out.push({ t, kind, text: cut(text) });
  const close = () => { if (open) Object.assign(open, { outcome: "cut", endKnown: false, end: null, usd: null }); open = null; };
  const attempt = (s, kind, t, why = null) => {
    close();
    open = { kind, why, start: t, end: null, endKnown: true, outcome: null, limitType: null, turns: null, usd: null, h5: null, d7: null, usdCum: null };
    s.attempts.push(open);
    return open;
  };
  for (const e of events) {
    const t = stampOf(e.at);
    if (!Number.isFinite(t) || (since != null && t < since)) continue;
    firstLine ??= t;
    lastLine = t;
    const text = e.text;
    let m;
    if (text.startsWith(LOG.chainStarts)) {
      close();
      started ??= t;
      endLine = null;
      event(t, /\(runner reloaded\)/.test(text) ? "reload" : "start", text);
    } else if ((m = LOG.starts.exec(text))) {
      const s = session(Number(m[1]));
      s.title ??= m[2];
      attempt(s, s.attempts.length ? "retry" : "start", t);
      wait = null;
    } else if ((m = LOG.resumes.exec(text))) {
      const s = session(Number(m[1]));
      attempt(s, "resume", t, RESUME_WHY.find(([re]) => re.test(text))?.[1] ?? null);
      wait = null;
      event(t, "resume", text);
    } else if ((m = /^session (\d+) runs (\S+)(?: \([^)]*\))? at (\w+)/.exec(text))) {
      const s = session(Number(m[1]));
      s.model = m[2];
      s.effort = m[3];
    } else if ((m = LOG.ends.exec(text)) && sessions.get(Number(m[1]))?.attempts.length) {
      const s = sessions.get(Number(m[1])), a = s.attempts.at(-1);
      const money = /, (\d+) turns?, \$([\d.]+)/.exec(m[2]);
      a.end = t;
      a.endKnown = true;
      // "success (error)" is a session the CLI ended in an error: not a success.
      a.outcome = /^success(?! \(error\))/.test(m[2]) ? "success" : "error";
      if (money) { a.turns = Number(money[1]); a.usdCum = Number(money[2]); }
      // A result's total carries the conversation's earlier parts, so a resume's dollars are the step up from the last
      // part that has a total; a number started again is a new conversation, whose total is its own.
      let before = 0;
      for (let j = s.attempts.length - 2; a.kind === "resume" && j >= 0; j--) {
        if (s.attempts[j].usdCum != null) { before = s.attempts[j].usdCum; break; }
        if (s.attempts[j].kind !== "resume") break;
      }
      a.usd = a.usdCum == null ? null : cents(a.usdCum - before);
      if (a === open) open = null;
    } else if ((m = /^session (\d+) limits: (.*?); it ran on \S+$/.exec(text)) && sessions.get(Number(m[1]))?.attempts.length) {
      const a = sessions.get(Number(m[1])).attempts.at(-1);
      a.h5 = span("5h", m[2]);
      a.d7 = span("7d", m[2]);
      if (a.h5 || a.d7) {
        limits.push({ t: a.start, h5: a.h5?.[0] ?? null, d7: a.d7?.[0] ?? null });
        limits.push({ t: a.end ?? t, h5: a.h5?.[1] ?? null, d7: a.d7?.[1] ?? null });
      }
    } else if ((m = /^session (\d+): (\w+) cut it off; limit record/.exec(text)) || (m = /^session (\d+): (\w+)'s allowance is used up/.exec(text))) {
      const a = sessions.get(Number(m[1]))?.attempts.at(-1);
      if (a) Object.assign(a, { outcome: "limit", limitType: /cut it off/.test(text) ? m[2] : m[2].toLowerCase() });
      event(t, "limit", text);
    } else if ((m = /^usage limit: waiting until (\S+ \S+)/.exec(text)) || (m = /^five-hour window at .*: the next session starts when it resets (\S+ \S+)/.exec(text))) {
      wait = { until: stampOf(m[1]), text };
      event(t, "limit", text);
    } else if (text.startsWith("runner reloads")) event(t, "reload", text);
    else if (text.startsWith(LOG.chainEnds)) {
      endLine = { t, reason: text.slice(LOG.chainEnds.length) };
      event(t, "end", text);
    } else event(t, "other", text);
  }
  return {
    started: started ?? since ?? firstLine,
    endLine,
    sessions: [...sessions.values()].sort((a, b) => a.n - b.n),
    events: out,
    limits,
    wait,
    lastLine,
  };
}

// ---------------------------------------------------------------- a session's files
// The stream-and-transcript half of a session: what sessionBlock gives, and so what a cached block carries over.
export const CACHE_VERSION = 1;
export const BLOCK_KEYS = ["usd", "estimated", "turns", "calls", "rows", "tokens", "contextPeak", "context", "tools", "subagents", "denials", "denialNotes", "lastStep", "lastSeen", "windows", "src"];
const ROW_KIND = { ana: "main", alt: "sub", wf: "workflow" };
const BEAT = 5 * 60_000;
const streamOf = (state, n) => path.join(state, `session-${String(n).padStart(2, "0")}.jsonl`);
const statOf = (f) => { try { const s = fs.statSync(f); return { size: s.size, mtime: s.mtimeMs }; } catch { return null; } };
// The session id from the stream's head, as lastActivity reads it.
function headSid(file) {
  try {
    const fd = fs.openSync(file, "r"), head = Buffer.alloc(65536);
    try { return /"session_id":"([^"]+)"/.exec(head.toString("utf8", 0, fs.readSync(fd, head, 0, head.length, 0)))?.[1] ?? null; } finally { fs.closeSync(fd); }
  } catch { return null; }
}
// The count, total size and newest mtime of the files under a session's transcript folder (its agents, its workflows).
function treeStat(dir) {
  const acc = { count: 0, total: 0, newest: 0 };
  const walk = (d) => {
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else { const s = statOf(f); if (s) { acc.count++; acc.total += s.size; acc.newest = Math.max(acc.newest, s.mtime); } }
    }
  };
  if (dir) walk(dir);
  return acc;
}
function filesOf(state, n, known) {
  const file = streamOf(state, n), stream = statOf(file);
  const sid = known?.sid || (stream ? headSid(file) : null);
  const base = known?.base || transcriptBase(sid, state);
  const main = base ? statOf(`${base}.jsonl`) : null, tree = treeStat(base);
  const part = (s) => (s ? `${s.size}:${s.mtime}` : "-");
  return { sid, base, stream, main, tree, sig: `${part(stream)}|${part(main)}|${tree.count}:${tree.total}:${tree.newest}` };
}
// What a session's block was read from: when sig is the same on a later pass, the block is too. known (an earlier
// block's src) saves reading the stream's head for the session id.
export function blockSignature(state, n, known = null) {
  const { sid, base, sig } = filesOf(state, n, known);
  return { sid, base, sig };
}

const family = (m) => (m ? /opus|sonnet|haiku|fable|mythos/i.exec(m)?.[0].toLowerCase() ?? null : null);
// A window's utilization as percent, as session-outcome.mjs reads it (a fraction, or a percent above 1).
const pctOf = (u) => (typeof u === "number" ? Math.round(u > 1 ? u : u * 100) : null);
const isMain = (j) => !j.parent_tool_use_id && !j.isSidechain;
// At most max points, the first, the last and the peak among them, the rest evenly spread.
function thin(points, max = 60) {
  if (points.length <= max) return points;
  let peak = 0;
  points.forEach((p, i) => { if (p[1] > points[peak][1]) peak = i; });
  const keep = new Set([peak]), step = (points.length - 1) / (max - 2);
  for (let k = 0; k <= max - 2; k++) keep.add(Math.round(k * step));
  return [...keep].sort((a, b) => a - b).map((i) => points[i]);
}
// The subagents of a session's stream: one per task of the Agent tool. A SendMessage that wakes an agent starts its
// task again under the same id: not a new agent.
function subagentsOf(entries) {
  const uses = new Map(), resolved = new Map(), tasks = new Map();
  let lastT = null;
  for (const j of entries) {
    const t = Date.parse(j.timestamp);
    if (Number.isFinite(t)) lastT = t;
    if (j.type === "assistant") {
      for (const c of j.message?.content || []) if (c.type === "tool_use" && (c.name === "Agent" || c.name === "Task")) uses.set(c.id, { t: lastT, input: c.input || {} });
    } else if (j.type === "user" && j.tool_use_result?.agentId) resolved.set(j.tool_use_result.agentId, j.tool_use_result.resolvedModel);
    else if (j.type === "system" && j.task_id) {
      const k = tasks.get(j.task_id);
      if (j.subtype === "task_started" && j.task_type === "local_agent" && !k) {
        const u = uses.get(j.tool_use_id), input = u?.input || {};
        tasks.set(j.task_id, {
          description: input.description || j.description || "", type: input.subagent_type || j.subagent_type || null,
          model: family(resolved.get(j.task_id)) ?? family(input.model), start: u?.t ?? lastT, end: null, tokens: null, toolUses: null,
          background: Boolean(j.is_backgrounded || input.run_in_background), status: null,
        });
      } else if (k && j.subtype === "task_updated") {
        if (j.patch?.status) k.status = j.patch.status;
        if (Number.isFinite(j.patch?.end_time)) k.end = j.patch.end_time;
      } else if (k && (j.subtype === "task_progress" || j.subtype === "task_notification")) {
        if (Number.isFinite(j.usage?.total_tokens)) k.tokens = j.usage.total_tokens;
        if (Number.isFinite(j.usage?.tool_uses)) k.toolUses = j.usage.tool_uses;
        if (j.subtype === "task_notification" && j.status) k.status = j.status;
      }
    }
  }
  // The model a resolvedModel line named after the task started.
  for (const [id, k] of tasks) k.model = family(resolved.get(id)) ?? k.model;
  return [...tasks.values()];
}
// The limit windows the stream reported, each stamped with the last timestamp before it.
function windowsOf(entries) {
  let lastT = null;
  const seen = [];
  for (const j of entries) {
    const t = Date.parse(j.timestamp);
    if (Number.isFinite(t)) lastT = t;
    if (j.type !== "rate_limit_event") continue;
    const w = j.rate_limit_info?.unifiedWindows;
    seen.push({ t: lastT, h5: pctOf(w?.five_hour?.utilization), d7: pctOf(w?.seven_day?.utilization) });
  }
  return { first: seen[0] ?? null, last: seen.at(-1) ?? null };
}

// One session's stream and transcripts as the dashboard shows them. The files' signature is taken before they are
// read, so a write during the read shows as a change on the next pass, never as a block that looks current.
export function sessionBlock(state, n) {
  const f = filesOf(state, n);
  const p = parseSession(state, String(n).padStart(2, "0"), { lines: true });
  const estimated = !p.result;
  const rows = p.rows.map((r) => ({
    kind: ROW_KIND[r.kind] ?? r.kind, model: r.model, agents: r.agents, calls: r.usage.calls, input: r.usage.input, cacheRead: r.usage.read,
    cacheWrite: r.usage.write, output: r.usage.output, thinking: r.usage.thinking, units: r.usage.units,
    usd: estimated || r.cost == null ? null : r.cost, estimated, untracked: Boolean(r.untracked),
  }));
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const r of rows) for (const k of Object.keys(tokens)) tokens[k] += r[k];
  // The main thread's calls, the last line of each response id: the context each one read.
  const byId = new Map();
  for (const j of p.mainEntries) if (j.type === "assistant" && isMain(j) && j.message?.usage && j.message.model !== "<synthetic>") byId.set(j.message.id || j.requestId || byId.size, j);
  const sizes = [...byId.values()].map((j) => { const u = j.message.usage; return [Date.parse(j.timestamp), (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)]; });
  const tools = {}, seen = new Set();
  for (const j of p.entries) {
    if (j.type !== "assistant" || j.parent_tool_use_id) continue;
    for (const c of j.message?.content || []) if (c.type === "tool_use" && !seen.has(c.id)) { seen.add(c.id); tools[c.name] = (tools[c.name] || 0) + 1; }
  }
  // The last timestamp of each five-minute span: when the session was alive, kept so that a later pass can say when a
  // session whose runner died was last seen without reading its files again.
  const spans = new Map();
  for (const j of p.mainEntries === p.entries ? p.entries : [...p.entries, ...p.mainEntries]) {
    const t = Date.parse(j.timestamp);
    if (Number.isFinite(t)) spans.set(Math.floor(t / BEAT), Math.max(t, spans.get(Math.floor(t / BEAT)) ?? t));
  }
  return {
    usd: p.result ? Number(p.result.total_cost_usd) || 0 : null,
    estimated,
    turns: p.result?.num_turns ?? null,
    calls: byId.size,
    rows,
    tokens,
    contextPeak: sizes.reduce((m, [, v]) => Math.max(m, v), 0),
    context: thin(sizes.filter(([t]) => Number.isFinite(t)).sort((a, b) => a[0] - b[0])),
    tools,
    subagents: subagentsOf(p.entries),
    denials: p.denials.length,
    denialNotes: p.denials,
    lastStep: p.lastStep,
    // The newest write to the stream or any transcript of the session (a session waiting on a long workflow writes
    // nothing itself), as lastActivity reads it; null without a stream.
    lastSeen: f.stream ? Math.max(f.stream.mtime, f.main?.mtime ?? 0, f.tree.newest) : null,
    windows: windowsOf(p.entries),
    src: { v: CACHE_VERSION, sid: f.sid, base: f.base, sig: f.sig, beats: [...spans.values()].sort((a, b) => a - b) },
  };
}
