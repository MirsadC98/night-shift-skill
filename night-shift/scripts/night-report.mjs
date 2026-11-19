#!/usr/bin/env node
// night-shift report: how a run is going, what it cost and what went wrong,
// read from the state folder and the session transcripts without a model call.
// Sent to Telegram when ~/.claude/night-shift/telegram.json holds a bot token, and posted to a webhook (ntfy, Slack
// or Discord) when ~/.claude/night-shift/webhook.json holds { "url": …, "kind": … } (webhook.mjs); to each that is set up.
//
//   node night-report.mjs show   --state <dir>
//   node night-report.mjs notify --state <dir> [--headline <text>] [--dry]
//   node night-report.mjs card   --state <dir> [--nn <n> | --chain [reason]] [--send]   (default: the /status card)
//   node night-report.mjs watch  --state <dir> --pid <runner pid> [--announce] [--dry]
//   node night-report.mjs telegram-setup [--chat <id>]   (after pressing Start in the bot's chat)
//
// watch follows chain.log and sends a short card (telegram-cards.mjs) when a
// session ends, a line when the chain waits for a usage limit, resumes or
// retries a session, or a session goes quiet for 30 minutes, and a summary
// when the chain ends or its runner dies. In the bot's chat, /status answers with what
// runs now, /report with the full report that `show` prints, and /stop stops the chain
// after the session in progress (/stop now at once, as `night-chain.mjs stop --now`);
// /inbox <text> adds the text to the run's inbox.md once the user's global config holds
// "telegramInbox": true; the cards and the report are in the run's language (run.json "lang", lang/index.mjs),
// whose table may name the commands in that language too.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sessionCard, eventLine, chainCard, statusCard, reportCard, reportSection, chainProgress, progressText, splitHtml } from "./telegram-cards.mjs";
import { sessionPlan, resolveMode, isPremium, modelName as familyName, MAIN_MODEL, PREMIUM } from "./effort.mjs";
import { strings, langOf, loadLang } from "./lang/index.mjs";
import { isMain, claudeHome, readGlobalConfig, globalConfigFile } from "./config.mjs";
import { stopRun, workTree } from "./runs.mjs";
import { platform } from "./platform.mjs";
import { sendWebhook, webhookFile, plainText } from "./webhook.mjs";

const SELF = fileURLToPath(import.meta.url);
// A function: the runner sets CLAUDE_CONFIG_DIR from run.json after this module has loaded (claudeHome).
const telegramFile = () => path.join(claudeHome(), "night-shift", "telegram.json");
const QUIET_MINUTES = 30;
// Anthropic's price ratios to fresh input. They only split a model's dollars
// between rows; the dollars themselves are the sessions' own totals.
const WEIGHT = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, output: 5 };

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
// A file caught half-written (or by a crash) reads as its default: the watcher must outlive it.
const readJson = (f, dflt = {}) => { try { const v = JSON.parse(read(f)); return v && typeof v === "object" ? v : dflt; } catch { return dflt; } };
const { alive } = platform;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = (f) => read(f).split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// HH:MM, as a night report's section heading writes a session's start (reportSection finds it by that);
// a time the user reads goes through the language table's clock (T.clock) instead.
const hm = (d) => d.toLocaleTimeString("sv-SE").slice(0, 5);
const when = (at) => new Date(at.replace(" ", "T"));
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (u, T) => (u == null ? "—" : T.pct(Math.round(u > 1 ? u : u * 100)));
const minutes = (ms, T) => T.minutes(Math.round(ms / 60_000));
const modelName = (m) => m.replace(/^claude-/, "").replace(/\[.*\]$/, "").replace(/-(\d+)-(\d+).*$/, " $1.$2");

// ---------------------------------------------------------------- tokens
const blank = () => ({ calls: 0, input: 0, read: 0, write: 0, output: 0, thinking: 0, units: 0 });
function add(acc, u) {
  const write = u.cache_creation_input_tokens || 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens, w5m = u.cache_creation?.ephemeral_5m_input_tokens;
  const writeUnits = w1h != null || w5m != null ? (w1h || 0) * WEIGHT.write1h + (w5m || 0) * WEIGHT.write5m : write * WEIGHT.write1h;
  acc.calls++;
  acc.input += u.input_tokens || 0;
  acc.read += u.cache_read_input_tokens || 0;
  acc.write += write;
  acc.output += u.output_tokens || 0;
  acc.thinking += u.output_tokens_details?.thinking_tokens || 0;
  acc.units += (u.input_tokens || 0) * WEIGHT.input + (u.cache_read_input_tokens || 0) * WEIGHT.read + writeUnits + (u.output_tokens || 0) * WEIGHT.output;
}
const merge = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k]; return a; };

// One response is spread over several lines that repeat its id; the last one counts.
function usageByModel(entries, keep = () => true) {
  const last = new Map();
  for (const j of entries) {
    if (j.type === "assistant" && j.message?.usage && j.message.model !== "<synthetic>" && keep(j)) last.set(j.message.id || j.requestId || last.size, j);
  }
  const byModel = {};
  for (const j of last.values()) add((byModel[j.message.model] ||= blank()), j.message.usage);
  return byModel;
}

// The Claude folder the run used: the one start kept in run.json (CLAUDE_CONFIG_DIR), so a shell without the variable
// still finds the run's transcripts and runner; else this process's (claudeHome).
const claudeOf = (state) => readJson(path.join(state, "run.json")).claudeConfigDir || claudeHome();
// <projects>/<project>/<sid>: the main transcript is <sid>.jsonl, subagents live under <sid>/.
function transcriptBase(sid, state) {
  const root = path.join(claudeOf(state), "projects");
  for (const p of sid && fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const base = path.join(root, p, sid);
    if (fs.existsSync(`${base}.jsonl`) || fs.existsSync(base)) return base;
  }
  return null;
}

// Last sign of life of a session: its stream, or any of its agents' transcripts
// (a session waiting on a long workflow writes nothing itself).
function lastActivity(state, nn) {
  const file = path.join(state, `session-${nn}.jsonl`);
  if (!fs.existsSync(file)) return Date.now();
  let latest = fs.statSync(file).mtimeMs;
  const fd = fs.openSync(file, "r"), head = Buffer.alloc(65536);
  const sid = /"session_id":"([^"]+)"/.exec(head.toString("utf8", 0, fs.readSync(fd, head, 0, head.length, 0)))?.[1];
  fs.closeSync(fd);
  const base = transcriptBase(sid, state);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else latest = Math.max(latest, fs.statSync(f).mtimeMs);
    }
  };
  if (base && fs.existsSync(`${base}.jsonl`)) latest = Math.max(latest, fs.statSync(`${base}.jsonl`).mtimeMs);
  if (base && fs.existsSync(base)) walk(base);
  return latest;
}

// Subagents and workflow agents of one session, one row per kind and model.
// Their transcripts undercount output tokens; parseSession tops that up from the session's totals.
function agentRows(dir) {
  const rows = {}, workflows = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/^agent-.*\.jsonl$/.test(e.name)) {
        const kind = /[\\/]workflows[\\/]/.test(f) ? "wf" : "alt";
        const byModel = usageByModel(jsonl(f));
        const main = Object.entries(byModel).sort((a, b) => b[1].units - a[1].units)[0];
        for (const [model, u] of Object.entries(byModel)) {
          const row = (rows[`${kind}|${model}`] ||= { kind, model, agents: 0, usage: blank() });
          merge(row.usage, u);
          if (model === main[0]) row.agents++;
        }
      }
    }
  };
  if (dir && fs.existsSync(path.join(dir, "subagents"))) walk(path.join(dir, "subagents"));
  const wfDir = dir && path.join(dir, "workflows");
  for (const f of wfDir && fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((n) => n.endsWith(".json")) : []) {
    const name = /name:\s*['"]([^'"]+)/.exec(JSON.parse(read(path.join(wfDir, f))).script || "")?.[1];
    if (name) workflows.push(name);
  }
  return { rows: Object.values(rows), workflows };
}

// ---------------------------------------------------------------- one session
// A guard denial is a failed call whose first line is the hook's (`PreToolUse:Bash hook error: night-shift guard:
// <reason>. Do not work around it; …`). Output that only shows the guard's text, its source read or the hook run
// by hand, is none (2026-11-19: a session that read guard.mjs counted as refused, its source as the reason).
const DENIAL = /^[^\n]*night-shift guard: /;
const denialReason = (t) => {
  const r = t.slice(t.indexOf("night-shift guard: ") + 19).split(". Do not work around it")[0].replace(/\s+/g, " ").trim();
  return r.length > 160 ? `${r.slice(0, 159)}…` : r;
};

// A model billed in the totals that no transcript row names (calls the transcripts do not record): its own row,
// with the totals' tokens and dollars (its keys added up) and no count of calls.
function addUntracked(row, mu) {
  add(row.usage, { input_tokens: mu.inputTokens, cache_read_input_tokens: mu.cacheReadInputTokens, cache_creation_input_tokens: mu.cacheCreationInputTokens, output_tokens: mu.outputTokens });
  row.usage.calls = 0;
  row.cost += mu.costUSD || 0;
  return row;
}
const untrackedRow = (model, mu) => addUntracked({ kind: "ana", model, agents: 0, usage: blank(), cost: 0, untracked: true }, mu);

// T9: a session's start, the context its first main-thread call read (input, cache read and cache write): what the
// header, the prompt, the skills and the tools cost before any work. null when the session made no call.
function startTokens(entries) {
  const u = entries.find((j) => j.type === "assistant" && !j.parent_tool_use_id && !j.isSidechain && j.message?.usage && j.message.model !== "<synthetic>")?.message.usage;
  return u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
}

function parseSession(state, nn) {
  const file = path.join(state, `session-${nn}.jsonl`);
  const entries = jsonl(file);
  const sid = entries.find((j) => j.session_id)?.session_id;
  // Result lines are cumulative: a session writes one each time a background task wakes it,
  // and a session resumed after a usage limit carries its cost on (measured on run 2's #07,
  // 2026-10-30). The last one is the whole session; never add them up.
  const result = entries.findLast((j) => j.type === "result") || null;
  // The stream's usage lines stop at the start of each response, so main-thread
  // tokens come from the session's transcript on disk.
  const base = transcriptBase(sid, state);
  const mainEntries = base && fs.existsSync(`${base}.jsonl`) ? jsonl(`${base}.jsonl`) : entries;
  const rows = Object.entries(usageByModel(mainEntries, (j) => !j.parent_tool_use_id && !j.isSidechain))
    .map(([model, usage]) => ({ kind: "ana", model, agents: 0, usage }));
  const agents = agentRows(base);
  rows.push(...agents.rows);

  // Once the session has its totals: give the agents the output their transcripts
  // missed, then split each model's dollars over its rows by weighted tokens.
  if (result?.modelUsage) {
    // One model's keys ("…[1m]" for the main thread, the plain id for its subagents) bill the same rows: added up first,
    // so that the output the rows missed is counted once, against both keys' output.
    const byModel = new Map();
    for (const [key, mu] of Object.entries(result.modelUsage)) {
      const model = key.replace(/\[.*\]$/, ""), sum = byModel.get(model) || {};
      for (const f of ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD"]) sum[f] = (sum[f] || 0) + (Number(mu?.[f]) || 0);
      byModel.set(model, sum);
    }
    for (const [model, mu] of byModel) {
      const mine = rows.filter((r) => r.model === model);
      if (!mine.length) { if (mu.costUSD || mu.inputTokens || mu.outputTokens) rows.push(untrackedRow(model, mu)); continue; }
      const counted = mine.reduce((s, r) => s + r.usage.output, 0);
      const agentsOf = mine.filter((r) => r.kind !== "ana");
      const calls = agentsOf.reduce((s, r) => s + r.usage.calls, 0);
      const missing = Math.max(0, (mu.outputTokens || 0) - counted);
      for (const r of agentsOf) {
        const extra = calls ? Math.round(missing * r.usage.calls / calls) : 0;
        r.usage.output += extra;
        r.usage.units += extra * WEIGHT.output;
      }
      const units = mine.reduce((s, r) => s + r.usage.units, 0);
      for (const r of mine) r.cost = (r.cost || 0) + (units ? mu.costUSD * r.usage.units / units : 0);
    }
  }
  const tools = entries.filter((j) => j.type === "assistant" && !j.parent_tool_use_id)
    .flatMap((j) => (j.message.content || []).filter((c) => c.type === "tool_use"));
  const toolResults = entries.filter((j) => j.type === "user" && Array.isArray(j.message?.content))
    .flatMap((j) => j.message.content.filter((c) => c.type === "tool_result"));
  const text = (c) => (typeof c.content === "string" ? c.content : (c.content || []).map((p) => p.text || "").join(" "));
  const last = tools.at(-1);
  return {
    nn, rows, result, workflows: agents.workflows,
    startCtx: startTokens(mainEntries),
    // The effort each main-thread call really ran at (settings can drift: 2026-10-30, xhigh → high).
    efforts: [...new Set(mainEntries.filter((j) => j.type === "assistant" && !j.isSidechain && j.perTurnEffort).map((j) => j.perTurnEffort))],
    limits: entries.filter((j) => j.type === "rate_limit_event").map((j) => j.rate_limit_info).filter(Boolean),
    denials: toolResults.filter((c) => c.is_error === true).map(text).filter((t) => DENIAL.test(t)).map(denialReason),
    toolErrors: toolResults.filter((c) => c.is_error).length,
    compactions: entries.filter((j) => j.type === "system" && /compact/.test(j.subtype || "")).length,
    lastStep: last ? (last.input?.description || last.input?.skill || last.input?.file_path || last.name) : null,
    mtime: lastActivity(state, nn),
    stamps: mainEntries.map((j) => Date.parse(j.timestamp)).filter(Number.isFinite),
  };
}

// A job resumed after a restart or a usage limit sat idle from its last transcript line before
// the resume until the resume (run 2's #35 spanned a four-day power cut, 2026-11-01 → 11-05).
const spanMs = (s) => (s.end ? when(s.end) : new Date()) - when(s.start);
const idleMs = (s) => (s.resumes || []).reduce((sum, at) => {
  const back = when(at).getTime(), before = s.stamps.findLast((t) => t < back);
  return sum + (before ? Math.max(0, back - before) : 0);
}, 0);
const workMs = (s) => spanMs(s) - idleMs(s);

// ---------------------------------------------------------------- the run
function chainEvents(state) {
  return read(path.join(state, "chain.log")).split("\n").flatMap((l) => {
    const m = /^\[([^\]]+)\] (.*)$/.exec(l);
    return m ? [{ at: m[1], text: m[2] }] : [];
  });
}

function runnerPid(state) {
  const dir = path.join(claudeOf(state), "night-shift", "runs");
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const p = JSON.parse(read(path.join(dir, f)));
      if (p.state && path.resolve(p.state) === path.resolve(state)) return p.finished ? 0 : p.pid;
    } catch {}
  }
  return 0;
}

const git = (repo, args) => { try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return ""; } };

// What the full report and the Telegram cards both read: the run, its jobs with their tokens, problems.
function collect(state, pid = null) {
  state = path.resolve(state);
  const run = JSON.parse(read(path.join(state, "run.json")) || "{}");
  const T = strings(langOf(run));
  const events = chainEvents(state);
  const main = mainOf(run);
  const sessions = [];
  for (const e of events) {
    let m;
    // A number started again (a retry, a restarted chain) replaces its earlier try;
    // a resumed one is the same job going on after a usage limit.
    if ((m = /^session (\d+) starts: (.*)$/.exec(e.text))) {
      const at = sessions.findIndex((s) => s.nn === m[1]);
      sessions.splice(at < 0 ? sessions.length : at, at < 0 ? 0 : 1, { nn: m[1], start: e.at, task: m[2] });
    } else if ((m = /^session (\d+) resumes /.exec(e.text))) {
      const s = sessions.findLast((x) => x.nn === m[1]);
      if (s) Object.assign(s, { end: null, resumes: [...(s.resumes || []), e.at] });
    }
    else if ((m = /^session (\d+) ends: (.*)$/.exec(e.text))) Object.assign(sessions.findLast((s) => s.nn === m[1]) || {}, { end: e.at, summary: m[2] });
    // What the runner said about a session's model and handover (night-chain.mjs, 2026-11-15 on).
    else if ((m = /^session (\d+)(?::| )/.exec(e.text))) {
      const s = sessions.findLast((x) => x.nn === m[1]);
      const note = runnerNote(e.text, T, main);
      if (s && note) s.notes = [...(s.notes || []), note];
    }
  }
  // A restarted chain logs "chain starts" again; only an end after the last start counts.
  const ended = events.slice(events.findLastIndex((e) => e.text.startsWith("chain starts ")) + 1)
    .findLast((e) => e.text.startsWith("chain ends: "));
  const runner = pid ?? runnerPid(state);
  const running = !ended && runner && alive(runner);
  const parsed = sessions.map((s) => ({ ...s, ...parseSession(state, s.nn) }));

  // A running session has no totals yet: price it at this run's dollars per weighted token.
  const price = unitPrices(parsed.filter((p) => p.result));
  for (const s of parsed.filter((p) => !p.result)) {
    for (const r of s.rows) if (price[r.model]?.units) { r.cost = priced(r, price); r.estimated = true; }
  }

  const issues = [];
  for (const s of parsed) {
    if (s.result?.is_error || (s.result && s.result.subtype !== "success")) issues.push(`❌ #${s.nn} ${T.failed} (${esc(s.result.subtype)})`);
    if (s.end && !s.result) issues.push(`❌ #${s.nn} ${T.noResult} (${esc(s.summary || "")})`);
    if (s.denials.length) issues.push(`⚠️ #${s.nn} ${T.denied(s.denials.length)}: ${esc(s.denials.slice(0, 2).join("; "))}`);
    for (const n of s.notes || []) issues.push(`⚠️ #${s.nn} ${esc(n)}`);
    if (!s.end && running && Date.now() - s.mtime > QUIET_MINUTES * 60_000) {
      issues.push(`⚠️ #${s.nn} ${T.quietFor(minutes(Date.now() - s.mtime, T))} (${T.lastStep}: ${esc(s.lastStep || "?")})`);
    }
  }
  const since = when(String(run.startedAt || ""));
  for (const e of events.filter((x) => Number.isNaN(since.getTime()) || when(x.at) >= since)) {
    if (e.text.startsWith("usage limit: ")) {
      const until = /^usage limit: waiting until (\d{4}-\d\d-\d\d \d\d:\d\d)/.exec(e.text);
      issues.push(`⏳ ${T.clock(when(e.at))} ${T.limitWaited(until ? T.clock(when(until[1])) : esc(e.text.replace(/^usage limit: waiting until \S+ /, "")))}`);
    }
    // A line that does not open with "session N" (none today) is shown as it is.
    const nn = /^session (\d+)/.exec(e.text)?.[1];
    const said = (make) => esc(nn ? make(nn) : e.text);
    if (/^session \d+: transient error .*; try 1,/.test(e.text)) issues.push(`🔌 ${T.clock(when(e.at))} ${said(T.retriedTransient)}`);
    if (/left no continuation prompt/.test(e.text)) issues.push(`🔁 ${T.clock(when(e.at))} ${said(T.retriedNoPrompt)}`);
  }
  if (!ended && !running) issues.push(`🛑 ${T.runnerGone}`);
  const nextPrompt = read(path.join(state, "next-prompt.md")).trim();
  const c = { state, run, T, events, parsed, ended, running, issues, nextPrompt, sections: new Map() };
  for (const s of runJobs(c)) { const p = sectionProblem(c, s); if (p) issues.push(`⚠️ #${s.nn} ${esc(p)}`); }
  return c;
}

// The run's main model when it is Fable or Mythos (fable or mythos mode), else null: a cut-off session's piece
// then goes on at xhigh, not max, and a MODEL line the runner does not run stays on that model.
const mainOf = (run) => { const mode = run.mode || resolveMode({ model: run.model }).mode; return isPremium(mode) ? mode : null; };

// A chain.log line about a session's model or handover, as a problem of that job (null for others).
// The lines name the model in play (night-chain.mjs, 2026-11-18 on); an older log names only Fable and
// counts "<n> Fable sessions", so both shapes are read.
const PREMIUM_WHY = [[/used up until (\S+ \S+)/, (m, T, model) => T.note.fableUntil(m[1], model)],
  [/is at (\S+), at or over the (\S+) ceiling/, (m, T, model) => T.note.fableAt(m[1], m[2], model)],
  [/(\d+) (?:Fable sessions|sessions? on its allowance) already ran/, (m, T, model) => T.note.fableCount(m[1], model)],
  [/^this account cannot run it\b/, (m, T, model) => T.note.cannotRunWhy(model)]];
const whyNote = (why, T, model) => PREMIUM_WHY.map(([re, say]) => { const w = re.exec(why); return w && say(w, T, model); }).find(Boolean) || why;
// A MODEL note's tail names the model its session ran on (logged after the gate since 2026-11-19): an Opus there,
// in fable or mythos mode, is the stand-in the gate moved the session to.
const onStandIn = (text) => /; it runs on \S*opus\S*$/i.test(text);
function runnerNote(text, T, main = null) {
  let m;
  if ((m = /^session \d+: (\w+) is the main model, but (.*); it runs on Opus at (\w+)$/.exec(text))) return T.note.mainFell(whyNote(m[2], T, m[1]), m[3], m[1]);
  if ((m = /^session \d+ asked for (\w+), but (.*); it runs on Opus at max$/.exec(text))) return T.note.fableAsked(whyNote(m[2], T, m[1]), m[1]);
  if ((m = /^session \d+: (\w+)'s allowance is used up/.exec(text))) return (main ? T.note.mainCut : T.note.fableCut)(m[1]);
  if ((m = /^session \d+ was to run on (\w+), but (.*)$/.exec(text))) return T.note.fableNot(m[2], m[1]);
  if ((m = /^session \d+: this account cannot run (\w+) \(.*\); MODEL: (\w+) runs on Opus at max for the rest of this chain$/.exec(text))) return T.note.cannotRun(m[1], m[2]);
  // The line names its limit and what the prompt costs a call since 2026-11-19 (T2); an older one was over 30 KB.
  if ((m = /^session \d+ wrote a next-prompt\.md of (\d+) KB(?: \(over (\d+) KB\))?(?:.*, about (\d+)k tokens a call)?/.exec(text))) return T.note.bigPrompt(m[1], m[2] || "30", m[3] || null);
  // U14 (2026-11-19 on): a known stream field stopped arriving, or the weekly ceiling's window never came.
  if ((m = /^session \d+: its stream had no (\S+), which earlier sessions' streams had/.exec(text))) return T.note.fieldGone(m[1]);
  if (/^session \d+: its stream had no unifiedWindows\.seven_day, which --weekly-ceiling reads/.test(text)) return T.note.ceilingBlind;
  if ((m = /^session \d+: MODEL: (\S+) is not a model/.exec(text))) return main && !onStandIn(text) ? T.note.badModelFable(m[1], familyName(main)) : T.note.badModel(m[1]);
  if ((m = /^session \d+: MODEL: (\S+) is the same model as (\w+), this run's main model/.exec(text))) return T.note.sameModel(m[1], m[2], onStandIn(text) ? familyName(MAIN_MODEL) : m[2]);
  return null;
}

// The language of a state folder's run, and its table, for what has no collect(): the watcher, the card command, `status`.
export const stateLang = (state, repo) => langOf({ repo, ...readJson(path.join(state, "run.json")) });
export const stateStrings = (state, repo) => strings(stateLang(state, repo));

// A night-report commit (`docs: night report …`, or the phrase of the run's own language) is no job's work.
const reText = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const reportCommit = (T) => new RegExp(`^\\S+ docs: (?:${[...new Set([strings("en").reportCommit, T.reportCommit])].filter(Boolean).map(reText).join("|")})`);

// A job's night-report section, read once per collect (the report runs to thousands of lines).
function sectionOf(c, s) {
  if (!workTree(c.run)) return null;
  c.reportText ??= read(path.resolve(workTree(c.run), c.run.report || "NIGHT_RUNS.md"));
  const key = `${s.nn} ${s.start}`;
  if (!c.sections.has(key)) c.sections.set(key, reportSection(c.reportText, s.nn, hm(when(s.start)), /^\d{4}-\d{2}-\d{2}/.exec(s.start)?.[0] ?? null));
  return c.sections.get(key);
}

// Why the cards cannot read a finished job's section, when they cannot: none found by its heading, or one
// without the fixed words (a model that translated them). Nothing when the repository keeps no report, and
// nothing for a job that failed: its failure is the problem, and it may have ended before writing a section.
function sectionProblem(c, s) {
  if (!s.end || !okOf(s)) return null;
  const section = sectionOf(c, s);
  if (!c.reportText?.trim()) return null;
  if (!section) return c.T.noSection;
  return section.lacks.length ? c.T.sectionLacks(section.lacks) : null;
}

// This run's jobs: the day's state folder can also hold an earlier run's (a fresh start the same day).
function runJobs(c) {
  const since = when(String(c.run.startedAt || ""));
  return Number.isNaN(since.getTime()) ? c.parsed : c.parsed.filter((s) => when(s.start) >= since);
}

// A usage-limit wait in progress: the last start, resume or wait in the log is the wait.
function limitWait(c) {
  const e = c.events.findLast((x) => /^(usage limit: waiting until |session \d+ (starts|resumes) )/.test(x.text));
  const m = e && /^usage limit: waiting until (\S+ \S+)/.exec(e.text);
  return m ? when(m[1]) : null;
}

// The chain's progress line, as at the end of job `upto` or, without it, now.
function progressOf(c, upto = null) {
  const all = runJobs(c);
  const jobs = upto ? all.slice(0, all.indexOf(upto) + 1) : all;
  if (upto && !jobs.length) return null;
  const now = upto?.end ? when(upto.end) : new Date();
  const p = chainProgress(jobs.map((s) => ({ ok: okOf(s), ended: Boolean(s.end), workMs: workMs(s), remaining: s.end ? sectionOf(c, s)?.remaining ?? null : null })),
    { now, waitUntil: upto ? null : limitWait(c) });
  return progressText(p, now, c.T);
}

// Dollars and weighted tokens of each model over sessions that have their totals; a row priced at them.
function unitPrices(sessions) {
  const price = {};
  for (const r of sessions.flatMap((s) => s.rows)) {
    const p = (price[r.model] ||= { cost: 0, units: 0 });
    p.cost += r.cost || 0;
    p.units += r.usage.units;
  }
  return price;
}
const priced = (r, price) => (price[r.model]?.units ? r.usage.units * price[r.model].cost / price[r.model].units : 0);
// F5: what session nn cost when it wrote no result line (killed at --session-hours, crashed), for --max-usd: its
// transcript priced as a running session's is above, at the other sessions' totals in this state folder; 0 when none
// of them has a total for its models.
export function estimatedCost(state, nn) {
  try {
    const all = fs.readdirSync(state).map((f) => /^session-(\d+)\.jsonl$/.exec(f)?.[1]).filter(Boolean).map((n) => parseSession(state, n));
    const price = unitPrices(all.filter((p) => p.result && p.nn !== nn));
    return (all.find((p) => p.nn === nn)?.rows || []).reduce((sum, r) => sum + priced(r, price), 0);
  } catch { return 0; }
}

export function buildReport(state, { headline = "", focus = null, pid = null } = {}) {
  const c = collect(state, pid);
  const { run, parsed, ended, running, issues, nextPrompt, T } = c;
  state = path.resolve(state);

  const out = [];
  const progress = running ? progressOf(c) : null;
  const status = ended ? T.ended(esc(ended.text.slice(12))) : running ? T.runningLine({ nn: parsed.at(-1)?.nn || "—", max: run.lastSession ?? run.maxSessions, until: run.until, progress: progress ? esc(progress) : "" }) : T.stopped;
  out.push(`🌙 <b>${T.reportTitle} · ${esc(path.basename(run.repo || state))}</b>\n${headline ? `${esc(headline)}\n` : ""}${status} · ${T.clock(new Date())}`);
  out.push(`<b>${T.problemsHead}</b>\n${issues.length ? issues.join("\n") : `✅ ${T.noProblems}`}`);

  const jobs = parsed.map((s) => {
    const at = spanMs(s) > 12 * 3_600_000 ? (d) => `${d.toLocaleDateString("sv-SE").slice(5)} ${T.clock(d)}` : (d) => T.clock(d);
    const span = `${at(when(s.start))}–${s.end ? at(when(s.end)) : ""}`;
    const idle = idleMs(s);
    const took = minutes(spanMs(s) - idle, T) + (idle >= 60_000 ? ` (${T.gap(minutes(idle, T))})` : "");
    const mark = !s.end ? T.jobRunning : s.result && !s.result.is_error && s.result.subtype === "success" ? "✅" : "❌";
    // Its report title; a prompt's first sentence is the same boilerplate for every job.
    const title = sectionOf(c, s)?.title;
    const extra = !s.end && s.lastStep ? `\n  ${T.lastStep}: ${esc(String(s.lastStep).slice(0, 60))} (${T.ago(minutes(Date.now() - s.mtime, T))})` : "";
    return `#${s.nn} ${span} · ${took} · ${mark}${title ? `\n  ${esc(title)}` : ""}${extra}`;
  });
  // next-prompt.md still holds the running session's own prompt until that session hands over.
  const current = parsed.at(-1) && !parsed.at(-1).end ? read(path.join(state, "prompts", `${parsed.at(-1).nn}.md`)).trim() : null;
  const lastDone = parsed.findLast((s) => s.end);
  const next = lastDone && sectionOf(c, lastDone)?.next;
  if (/^STOP\b/i.test(nextPrompt) && nextPrompt !== current) jobs.push(`🛑 ${esc(nextPrompt.split("\n").slice(0, 8).join("\n"))}`);
  else if (next && !ended) jobs.push(T.nextUp(esc(next)));
  out.push(`<b>${T.jobsHead}</b>\n${jobs.join("\n") || T.noJobs}`);

  const order = { ana: 0, alt: 1, wf: 2 };
  const rowLines = (rows) => rows.sort((a, b) => order[a.kind] - order[b.kind] || b.usage.units - a.usage.units).map((r) => {
    const count = r.untracked ? "—" : r.kind === "ana" ? T.calls(r.usage.calls) : T.agents(r.agents);
    const cost = r.cost != null ? `${r.estimated ? "≈" : ""}${usd(r.cost)}` : "";
    const u = r.usage;
    return `${`${T.kinds[r.kind]} ${modelName(r.model)}`.padEnd(15)} ${count.padEnd(10)} ${cost}\n  ${T.tokenRow(tokens(u.input), tokens(u.read), tokens(u.write), tokens(u.output))}`;
  }).join("\n");
  // Fable's share comes only with Fable or Mythos calls, so it spans the events that carry it, under the name of
  // the model that ran them (shareName).
  const fableSpan = (ss) => {
    const f = ss.flatMap((s) => s.limits).map(fableOf).filter(Boolean);
    return f.length ? ` · ${shareName(c, ss)} ${pct(f[0].utilization, T)}→${pct(f.at(-1).utilization, T)}` : "";
  };
  const limitSpan = (ss) => { const ls = ss.flatMap((s) => s.limits); return ls.length ? `${T.five} ${pct(ls[0].unifiedWindows?.five_hour?.utilization, T)}→${pct(ls.at(-1).unifiedWindows?.five_hour?.utilization, T)} · ${T.seven} ${pct(ls[0].unifiedWindows?.seven_day?.utilization, T)}→${pct(ls.at(-1).unifiedWindows?.seven_day?.utilization, T)}${fableSpan(ss)}` : "—"; };
  const sessionCost = (s) => (s.result ? usd(s.result.total_cost_usd || 0)
    : s.rows.some((r) => r.cost != null) ? `≈${usd(s.rows.reduce((a, r) => a + (r.cost || 0), 0))} (${T.jobRunning})` : T.costWhenDone);

  const shown = focus === "all" ? parsed : parsed.filter((s) => s.nn === (focus || parsed.at(-1)?.nn));
  for (const s of shown) {
    const other = [...(s.startCtx != null ? [T.startTokens(tokens(s.startCtx))] : []),
      T.compactions(s.compactions), T.thinking(tokens(s.rows.reduce((a, r) => a + r.usage.thinking, 0))), T.toolErrors(s.toolErrors)];
    if (s.workflows.length) other.push(T.workflows(s.workflows.join(", ")));
    if (!s.result && s.rows.some((r) => r.kind !== "ana")) other.push(T.agentLater);
    out.push(`<b>${T.tokenHead} · #${s.nn}</b>\n<pre>${esc(rowLines([...s.rows]))}\n${T.otherLabel}: ${esc(other.join(" · "))}\n${T.totalLabel} ${sessionCost(s)}\n${T.limitLabel} ${limitSpan([s])}</pre>`);
  }

  if (parsed.length > 1 || focus === "all") {
    const total = {};
    for (const r of parsed.flatMap((s) => s.rows)) {
      const t = (total[`${r.kind}|${r.model}`] ||= { kind: r.kind, model: r.model, agents: 0, usage: blank(), cost: 0, untracked: true });
      merge(t.usage, r.usage);
      t.agents += r.agents;
      t.cost += r.cost || 0;
      t.estimated ||= r.estimated;
      // calls are counted once any session has a transcript row for the model
      t.untracked &&= Boolean(r.untracked);
    }
    const sum = Object.values(total).reduce((a, r) => a + r.cost, 0);
    // The mean start of the jobs that made a call: what a lean header saves, job by job.
    const starts = parsed.map((s) => s.startCtx).filter((n) => n != null);
    const mean = starts.length ? `\n${T.meanStart(tokens(Math.round(starts.reduce((a, n) => a + n, 0) / starts.length)), starts.length)}` : "";
    out.push(`<b>${T.nightTotal(parsed.length)}</b>\n<pre>${esc(rowLines(Object.values(total)))}${esc(mean)}\n${T.totalLabel} ${parsed.some((s) => !s.result) ? "≈" : ""}${usd(sum)}\n${T.limitLabel} ${limitSpan(parsed)}</pre>`);
  }

  const timeline = [];
  for (const s of parsed) {
    if (!s.limits.length) continue;
    const w = (l) => l.unifiedWindows || {};
    const fs0 = s.limits.map(fableOf).filter(Boolean);
    const initial = fs0.length ? shareName(c, [s])[0] : ""; // F or M: one session ran one model
    const f = (x) => (fs0.length ? ` ${initial} ${pct(x?.utilization, T)}` : "");
    timeline.push(`${T.clock(when(s.start))} #${s.nn} ${T.atStart} ${T.five} ${pct(w(s.limits[0]).five_hour?.utilization, T).padEnd(4)} ${T.seven} ${pct(w(s.limits[0]).seven_day?.utilization, T).padEnd(4)}${f(fs0[0])}`.trimEnd());
    timeline.push(`${s.end ? T.clock(when(s.end)) : T.clock(new Date())} #${s.nn} ${s.end ? T.atEnd : T.atNow} ${T.five} ${pct(w(s.limits.at(-1)).five_hour?.utilization, T).padEnd(4)} ${T.seven} ${pct(w(s.limits.at(-1)).seven_day?.utilization, T).padEnd(4)}${f(fs0.at(-1))}`.trimEnd());
  }
  const all = parsed.flatMap((s) => s.limits);
  const latest = all.at(-1)?.unifiedWindows;
  if (latest) {
    const reset = (t, long) => { const d = new Date(t * 1000); return long ? `${T.dayMonth(d)} ${T.clock(d)}` : T.clock(d); };
    const fable = all.map(fableOf).filter(Boolean).at(-1);
    timeline.push(`${T.resets}: ${T.five} ${reset(latest.five_hour?.resetsAt)} · ${T.seven} ${reset(latest.seven_day?.resetsAt, true)}${fable?.resetsAt ? ` · ${shareName(c, parsed)} ${reset(fable.resetsAt, true)}` : ""}`);
  }
  if (timeline.length) out.push(`<b>${T.timelineHead}</b> ${T.timelineNote}\n<pre>${esc(timeline.join("\n"))}</pre>`);

  if (workTree(run) && run.startedAt) {
    const commits = git(workTree(run), ["log", `--since=${run.startedAt}`, "--format=%h %s"]).split("\n").filter(Boolean);
    const ahead = git(workTree(run), ["rev-list", "--count", "@{u}..HEAD"]);
    const head = `<b>${T.commitsHead}</b> · ${commits.length}${ahead ? ` · ${T.unpushed(ahead)}` : ""}`;
    out.push(`${head}${commits.length ? `\n${commits.slice(0, 8).map((c) => esc(c.slice(0, 72))).join("\n")}${commits.length > 8 ? `\n${T.moreCommits(commits.length - 8)}` : ""}` : ""}\n${T.reportLabel}: ${esc(run.report || "NIGHT_RUNS.md")}`);
  }

  const html = out.join("\n\n");
  const plain = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const messages = [];
  for (const part of out) {
    if (messages.length && messages.at(-1).length + part.length + 2 <= 4000) messages[messages.length - 1] += `\n\n${part}`;
    else messages.push(...splitHtml(part));
  }
  return { html, plain, messages };
}

// ---------------------------------------------------------------- cards
const pctOr = (u, T) => (u == null ? null : pct(u, T));
// Fable's weekly allowance, which Mythos shares, in the rate_limit_events of their calls only.
const fableOf = (l) => l?.unifiedWindows?.seven_day_overage_included || null;
// Whose that allowance is where the user reads it: the model in play, i.e. the premium model the sessions that
// report it ran on (their "runs" line), else the run's main model, else Fable (a log from before Mythos).
function shareName(c, sessions) {
  const ran = new Set(sessions.filter((s) => s.limits.some(fableOf)).map((s) => wantOf(c.state, c.run, s.nn).family).filter(isPremium));
  return (ran.size ? [...ran].sort() : [mainOf(c.run) || PREMIUM[0]]).map(familyName).join("/");
}
const lastFable = (ls, T) => pctOr(ls.map(fableOf).filter(Boolean).at(-1)?.utilization, T);
const okOf = (s) => Boolean(s.result && !s.result.is_error && s.result.subtype === "success");
const costOf = (s) => (s.result ? s.result.total_cost_usd || 0 : s.rows.reduce((a, r) => a + (r.cost || 0), 0));
const firstCommit = (f) => f.commits[0]?.replace(/^\S+\s/, "");

// One job's card facts: its title and next step from the night report, its own problems and commits.
function jobFacts(c, s) {
  const { T } = c;
  const section = sectionOf(c, s);
  const range = [`--since=${s.start}`, ...(s.end ? [`--until=${s.end}`] : [])];
  const isReport = reportCommit(T);
  const commits = workTree(c.run) ? git(workTree(c.run), ["log", ...range, "--format=%h %s"]).split("\n")
    .filter((l) => l && !isReport.test(l)) : [];
  const w = s.limits.at(-1)?.unifiedWindows || {};
  return {
    nn: s.nn, ok: okOf(s), took: minutes(workMs(s), T),
    cost: `${s.result ? "" : "≈"}${usd(costOf(s))}`, five: pctOr(w.five_hour?.utilization, T), seven: pctOr(w.seven_day?.utilization, T),
    fable: lastFable(s.limits, T), fableName: shareName(c, [s]),
    title: section?.title, next: section?.next, waits: section?.waits || [], older: section?.older || 0,
    progress: s.end ? progressOf(c, s) : null,
    commits,
    problems: [
      ...(s.result && !okOf(s) ? [`${T.failed} (${s.result.subtype})`] : []),
      ...(s.end && !s.result ? [T.noResult] : []),
      ...(s.denials.length ? [`${T.denied(s.denials.length)}: ${s.denials[0]}`] : []),
      ...[sectionProblem(c, s)].filter(Boolean),
      ...(effortOff(c.state, c.run, s) ? [T.effortOff(s.efforts.join("/"), wantOf(c.state, c.run, s.nn).effort)] : []),
      ...(s.notes || []),
    ],
  };
}

// The model and level a session should run at: its last "runs" line in chain.log (night-chain.mjs,
// 2026-11-15 on: Fable or Mythos at high, such a request on Opus at max when refused), else what its prompt
// asks for. The runner pins each level, so any other level is drift, a higher one too.
function wantOf(state, run, nn) {
  const m = [...read(path.join(state, "chain.log")).matchAll(new RegExp(`\\] session ${nn} runs (\\w+)(?: \\(([^)]+)\\))? at (\\w+)`, "g"))].at(-1);
  if (m) return { family: m[1].toLowerCase(), model: m[2] || m[1].toLowerCase(), effort: m[3] };
  const p = sessionPlan(read(path.join(state, "prompts", `${nn}.md`)), run);
  return { family: p.family, model: p.model, effort: p.effort };
}
const effortOff = (state, run, s) => { const want = wantOf(state, run, s.nn).effort; return s.efforts.some((e) => e !== want); };

export function sessionMessage(state, nn, pid) {
  const c = collect(state, pid);
  const s = c.parsed.findLast((p) => p.nn === nn);
  return s ? sessionCard(jobFacts(c, s), c.T) : null;
}

export function chainMessage(state, reason, pid) {
  const c = collect(state, pid);
  const { T } = c;
  const jobs = runJobs(c);
  const facts = jobs.map((s) => jobFacts(c, s));
  const limits = jobs.flatMap((s) => s.limits).map((l) => l.unifiedWindows?.seven_day?.utilization).filter((u) => u != null);
  // A STOP prompt lists what waits for the user under its first line.
  const waitList = /^STOP\b/i.test(c.nextPrompt) ? c.nextPrompt.split("\n").slice(1).map((l) => /^\s*(?:[-*] |\d+\. )(.*)$/.exec(l)?.[1])
    .filter(Boolean).map((l) => l.replace(/\*\*|`/g, "").slice(0, 100)) : [];
  return chainCard({
    project: path.basename(c.run.repo || c.state), reason,
    jobs: facts.map((f) => ({ nn: f.nn, ok: f.ok, title: f.title || firstCommit(f), took: f.took })),
    took: jobs.length ? minutes(jobs.reduce((a, s) => a + workMs(s), 0), T) : null,
    cost: usd(jobs.reduce((a, s) => a + costOf(s), 0)),
    seven: limits.length ? `${pct(limits[0], T)}→${pct(limits.at(-1), T)}` : null,
    fable: (() => { const f = jobs.flatMap((s) => s.limits).map(fableOf).filter(Boolean); return f.length ? `${pct(f[0].utilization, T)}→${pct(f.at(-1).utilization, T)}` : null; })(),
    fableName: shareName(c, jobs),
    waits: waitList.length, waitList,
    problems: facts.flatMap((f) => f.problems.map((p) => `#${f.nn} ${p}`)),
    // K6: a run on its own worktree, while the folder is there.
    ...(c.run.tree && fs.existsSync(c.run.tree) ? { tree: c.run.tree, branch: c.run.branch || "night-shift" } : {}),
  }, T);
}

// /report: this run's jobs one line each, with the progress, the limits, problems and what waits.
export function reportMessage(state, pid) {
  const c = collect(state, pid);
  const { T } = c;
  const jobs = runJobs(c);
  const w = jobs.flatMap((s) => s.limits).at(-1)?.unifiedWindows || {};
  return reportCard({
    project: path.basename(c.run.repo || c.state),
    state: c.ended ? T.stateEnded(c.ended.text.slice(12).replace(/^STOP:\s*/i, "")) : c.running ? T.stateRunning : T.stateStopped,
    at: T.clock(new Date()),
    progress: c.running ? progressOf(c) : null,
    five: pctOr(w.five_hour?.utilization, T), seven: pctOr(w.seven_day?.utilization, T), fable: lastFable(jobs.flatMap((s) => s.limits), T), fableName: shareName(c, jobs),
    cost: jobs.length ?`${jobs.some((s) => !s.result) ? "≈" : ""}${usd(jobs.reduce((a, s) => a + costOf(s), 0))}` : null,
    jobs: jobs.map((s) => (s.end
      ? { nn: s.nn, ok: okOf(s), title: sectionOf(c, s)?.title, took: minutes(workMs(s), T) }
      : { nn: s.nn, running: true, took: minutes(workMs(s), T), step: s.lastStep && String(s.lastStep).slice(0, 60) })),
    // A day's folder can hold an earlier run: its jobs' problems are not this run's.
    problems: c.issues.filter((i) => { const m = /#(\d+)/.exec(i); return !m || jobs.some((s) => s.nn === m[1]); }),
    waits: waitsOf(c).map((l) => l.replace(/^\s*(?:[-*] |\d+\. )/, "").replace(/\*\*|`/g, "").slice(0, 100)).filter(Boolean),
  }, T);
}

// What waits for the user once the chain is over: a STOP prompt's body (without its own
// heading), else the last finished job's **Waits for you** (its new items, the carried ones counted).
export function userWaits(state) {
  return waitsOf(collect(state, 0));
}

// The label `wait` gives the list, from a table's own function, which may throw or return something else.
function waitsLabel(t) {
  try {
    const text = t.cli.userWaits(["-"]);
    return typeof text === "string" ? text.split("\n")[0].replace(/:\s*$/, "") : "";
  } catch { return ""; }
}

// The heading a STOP prompt's list may open with: the skill's **Waits for you**, or the label the cards or
// `wait` give that list, in English or in the run's own language. The whole line, markup and a colon aside, is
// the heading: an item that starts with the same words stays.
function isWaitsHead(line = "", T) {
  const text = line.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  return [strings("en"), T].flatMap((t) => [t.waitsHead, waitsLabel(t)]).some((h) => h && text === h.toLowerCase());
}

function waitsOf(c) {
  if (/^STOP\b/i.test(c.nextPrompt)) {
    const body = c.nextPrompt.split("\n").slice(1).join("\n").trim().split("\n");
    if (isWaitsHead(body[0], c.T)) body.shift();
    return body.join("\n").trim() ? body.join("\n").trim().split("\n") : [];
  }
  const last = c.parsed.findLast((s) => s.end);
  const f = last && jobFacts(c, last);
  return f ? [...f.waits.map((w) => `- ${w}`), ...(f.older ? [`- ${c.T.olderInReport(f.older, f.nn)}`] : [])] : [];
}

export function statusMessage(state, pid) {
  const c = collect(state, pid);
  const { T } = c;
  const cur = c.parsed.at(-1), done = c.parsed.findLast((s) => s.end);
  const w = c.parsed.flatMap((s) => s.limits).at(-1)?.unifiedWindows || {};
  const f = done && jobFacts(c, done);
  return statusCard({
    project: path.basename(c.run.repo || c.state), running: c.running,
    state: c.ended ? T.stateEnded(c.ended.text.slice(12)) : T.stateStopped,
    nn: cur && !cur.end ? cur.nn : null, took: cur && !cur.end ? minutes(workMs(cur), T) : null,
    step: cur && !cur.end && cur.lastStep ? String(cur.lastStep).slice(0, 80) : null,
    effort: cur && !cur.end ? cur.efforts.join("/") || null : null,
    five: pctOr(w.five_hour?.utilization, T), fiveReset: w.five_hour?.resetsAt ? T.clock(new Date(w.five_hour.resetsAt * 1000)) : null,
    seven: pctOr(w.seven_day?.utilization, T), fable: lastFable(c.parsed.flatMap((s) => s.limits), T), fableName: shareName(c, c.parsed),
    last: f &&{ nn: f.nn, ok: f.ok, title: f.title || firstCommit(f) }, next: f?.next,
    progress: c.running ? progressOf(c) : null,
  }, T);
}

// ---------------------------------------------------------------- telegram
// Every request has its own deadline: fetch would wait 300 s for the headers of a connection
// that dropped without a word, and the watcher, with /status and /report behind it, with it.
export async function telegram(method, cfg, body, { graceMs = 10_000 } = {}) {
  const api = process.env.NIGHT_SHIFT_TELEGRAM_API || "https://api.telegram.org";
  let r;
  try {
    r = await fetch(`${api}/bot${cfg.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout((body?.timeout || 0) * 1000 + graceMs),
    });
  } catch (e) {
    // fetch names the whole URL in its error, token included: it must not reach watch.log or a console.
    const said = `${e.message}${e.cause?.message ? `: ${e.cause.message}` : ""}`;
    const err = new Error(cfg.token ? said.split(String(cfg.token)).join("<token>") : said);
    err.name = e.name;
    throw err;
  }
  return r.json();
}

// True when the same session's "transient error" line follows (before its next start or resume): that
// retry's card is the error one. A line not in the file yet is not seen, and the end gets its card as before.
const retriedAfter = (later, nn) => {
  for (const l of later) {
    const t = l.replace(/^\[[^\]]+\] /, "");
    if (t.startsWith(`session ${nn}: transient error`)) return true;
    if (t.startsWith(`session ${nn} starts`) || t.startsWith(`session ${nn} resumes `)) return false;
  }
  return false;
};

// The watcher's own trail (its output goes nowhere): commands, their delay, Telegram errors.
const watchLog = (state, line) => { try { fs.appendFileSync(path.join(state, "watch.log"), `[${new Date().toLocaleString("sv-SE")}] ${line}\n`); } catch {} };

// The private chats that wrote to the bot, newest first, each once, with the name Telegram shows.
export function privateChats(updates) {
  const chats = new Map();
  for (const u of [...(updates || [])].reverse()) {
    const c = (u.message || u.my_chat_member)?.chat;
    if (c?.type !== "private" || chats.has(c.id)) continue;
    chats.set(c.id, { id: c.id, name: [[c.first_name, c.last_name].filter(Boolean).join(" "), c.username && `@${c.username}`].filter(Boolean).join(" ") || "?" });
  }
  return [...chats.values()];
}

// telegram-setup: which chat the reports go to. A bot's name is public, so anyone may have pressed
// Start in it: the chat is named before it is saved, never taken unseen, and two chats are a choice
// (--chat <id>), not a guess. Returns the lines to print; chatId is written only for the one chat.
export function chooseChat(cfg, updates, wanted = null) {
  const chats = privateChats(updates);
  const pick = wanted != null ? chats.find((c) => String(c.id) === String(wanted)) : chats.length === 1 ? chats[0] : null;
  if (pick) return { chatId: pick.id, lines: [`chat: ${pick.id} (${pick.name}); the reports go there`] };
  if (wanted != null) return { chatId: null, lines: [`no private chat ${wanted} wrote to the bot${chats.length ? `; these did:\n${chats.map((c) => `  ${c.id}  ${c.name}`).join("\n")}` : ""}`] };
  if (!chats.length) return { chatId: null, lines: [cfg.chatId ? `no new chat; the reports still go to ${cfg.chatId}` : "none yet: press Start in the bot's chat, then run this again"] };
  return { chatId: null, lines: ["more than one chat wrote to this bot; name yours with --chat <id>:", ...chats.map((c) => `  ${c.id}  ${c.name}`)] };
}

// Outcomes: "sent"; why it cannot go; "telegram: ..." when Telegram refused for good; "retry: ..." when
// the request threw or Telegram was busy or down (429, 5xx), so that asking again may work.
async function send(messages) {
  let cfg;
  try { cfg = JSON.parse(read(telegramFile())); } catch { return "no telegram.json"; }
  if (!cfg?.token) return "no token";
  try {
    const chat = cfg.chatId;
    if (!chat) return "no chat yet: press Start in the bot's chat, then run night-report.mjs telegram-setup";
    for (const m of messages) {
      const { text, silent = false, plain = false } = typeof m === "string" ? { text: m } : m;
      const j = await telegram("sendMessage", cfg, { chat_id: chat, text, parse_mode: plain ? undefined : "HTML", disable_web_page_preview: true, disable_notification: silent });
      if (!j.ok) return `${j.error_code === 429 || j.error_code >= 500 ? "retry" : "telegram"}: ${j.description}`;
    }
    return "sent";
  } catch (e) { return `retry: ${e.message}`; }
}

// Where the cards go (C6): Telegram when telegram.json exists, the webhook when webhook.json does, each that does. With
// neither it is Telegram alone, whose "no telegram.json" says why no card went, as before. The bot's own answers (/status,
// /report, /stop, /inbox) are Telegram's and go through send() alone. done: a notifier's own state for one card's tries.
const notifiers = () => {
  const list = [];
  if (fs.existsSync(telegramFile())) list.push({ name: "telegram", send: (messages) => send(messages) });
  if (fs.existsSync(webhookFile())) list.push({ name: "webhook", send: (messages, done) => sendWebhook(messages, done) });
  return list.length ? list : [{ name: "telegram", send: (messages) => send(messages) }];
};

// notify and card --send: once to each notifier; "sent" when every one took it, else the other outcomes.
async function deliver(messages) {
  const outcomes = await Promise.all(notifiers().map((n) => n.send(messages, { parts: 0 })));
  const off = outcomes.filter((o) => o !== "sent");
  return off.length ? off.join("; ") : "sent";
}

export async function notify(state, headline, opt = {}) {
  const report = buildReport(state, { headline, focus: opt.focus, pid: opt.pid });
  fs.writeFileSync(path.join(state, "status.md"), report.plain);
  if (opt.dry) { console.log(`----- ${headline}\n${report.plain}`); return "dry"; }
  const outcome = await deliver(report.messages);
  if (outcome !== "sent") console.error(`night-report: ${outcome}`);
  return outcome;
}

// C3 (2026-11-19): an attended run's questions, <state>/questions.md: the lines that open with "Q<n> · ", each once, in the
// order written. A line counts once it ends in a newline, so one still being written, or cut off by stop --now, is not
// read half. The watcher and `wait` (night-chain.mjs) keep what they reported by the line's text, not by a count: a line a
// session rewrote or removed then neither hides a later question nor reports the rest again.
// A BOM goes too: Windows PowerShell 5's Set-Content -Encoding UTF8 starts the file with one, which hid its first question.
export function questionLines(state) {
  const lines = read(path.join(state, "questions.md")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n").slice(0, -1).map((l) => l.trimEnd());
  return [...new Set(lines.filter((l) => /^Q\d+ · /.test(l)))];
}

// ---------------------------------------------------------------- watch
async function watch(opt) {
  const state = path.resolve(opt.state);
  const T = stateStrings(state);
  const pid = Number(opt.pid) || runnerPid(state);
  const lock = path.join(state, "watch.pid");
  const other = Number(read(lock));
  if (other && other !== process.pid && alive(other)) return console.log(`already watched by pid ${other}`);
  fs.writeFileSync(lock, String(process.pid));
  const markFile = path.join(state, "notified.json");
  const mark = { lines: 0, quiet: {}, ...readJson(markFile) };
  const save = () => fs.writeFileSync(markFile, JSON.stringify(mark));
  // Each event is one short card; status.md keeps the full report for `status` and /report.
  // A card is sent until each notifier takes it or the give-up time passes; the caller counts its log line after that.
  // Each notifier has a loop of its own, all at once, so an outage of one never sends the other's card twice. Once one
  // has the card, another still failing tries once more and gives it up: a dead webhook must not hold Telegram's cards,
  // and the /stop behind them, for the whole give-up time.
  const retryMs = Number(process.env.NIGHT_SHIFT_SEND_RETRY_MS) || 30_000, giveUpMs = Number(process.env.NIGHT_SHIFT_SEND_GIVEUP_MS) || 1_800_000;
  const say = async (message) => {
    fs.writeFileSync(path.join(state, "status.md"), buildReport(state, { pid }).plain);
    if (!message) return;
    if (opt.dry) return console.log(`----- ${message.silent ? `(${T.silent})` : ""}\n${message.text}`);
    const began = Date.now();
    let taken = false;
    const sendTo = async (n) => {
      let card = message, outcome, tries = 0;
      const done = { parts: 0 };
      for (;;) {
        const after = taken; // another notifier had the card before this try began
        outcome = await n.send([card], done);
        tries++;
        // Unreadable HTML (a stray "<" in a title) must not lose the card: once more, tags stripped.
        if (/^telegram: .*can't parse entities/.test(outcome) && !card.plain) {
          card = { ...card, plain: true, text: plainText(card.text) };
          continue;
        }
        if (outcome === "sent") taken = true;
        if (!outcome.startsWith("retry:")) break;
        if (tries === 1) watchLog(state, `card not taken, trying again: ${outcome}`);
        if (after || Date.now() - began >= giveUpMs) { outcome = `gave up on a card after ${tries} tries${after ? " (another notifier has it)" : ""}: ${outcome}`; break; }
        await sleep(retryMs);
      }
      if (outcome !== "sent") watchLog(state, outcome);
    };
    await Promise.all(notifiers().map(sendTo));
  };
  const cfg = readJson(telegramFile());
  if (cfg.token && !opt.dry) {
    await telegram("setMyCommands", cfg, { commands: [
      { command: T.cmdStatus, description: T.cmdStatusDesc }, { command: T.cmdReport, description: T.cmdReportDesc },
      { command: T.cmdStop, description: T.cmdStopDesc },
      ...(inboxOn() ? [{ command: T.cmdInbox, description: T.cmdInboxDesc }] : [])] }).catch(() => {});
  }
  const project = path.basename(readJson(path.join(state, "run.json")).repo || state);
  if (opt.announce) await say(eventLine("start", { project }, T));
  // Each new question of an attended run, as it appears; run.json is read each time, since a new start may change it.
  // A question no card can be made of must not hold the chain's other cards back: like a log line, it is skipped on its
  // third try, and a failed try leaves the pass going on.
  const askTries = new Map();
  const ask = async () => {
    if (!readJson(path.join(state, "run.json")).attended) return;
    mark.questions ||= [];
    for (const q of questionLines(state)) {
      if (mark.questions.includes(q)) continue;
      try { await say(eventLine("question", { project, text: q }, T)); }
      catch (e) {
        askTries.set(q, (askTries.get(q) || 0) + 1);
        if (askTries.get(q) < 3) continue;
        watchLog(state, `watch loop: skipped a question it could not make a card of: ${e.message}`);
      }
      mark.questions.push(q);
      save();
    }
  };
  const started = Date.now();

  let poison = 0; // tries in a row that failed on one log line
  for (;;) {
    try {
      const lines = read(path.join(state, "chain.log")).split("\n").filter(Boolean);
      // After the snapshot of chain.log and before acting on it: a session writes its question before it exits, and the
      // runner writes "chain ends" only after, so the last session's question goes out before the chain's end card.
      await ask();
      for (const line of lines.slice(mark.lines)) {
        const t = line.replace(/^\[[^\]]+\] /, "");
        let m;
        // A line is counted after its card was delivered or given up, so a card Telegram did not take is not lost.
        try {
          // In an outage each retry logs "ends" and then "transient error"; the error is the card, so the "ends" before it is not.
          if ((m = /^session (\d+) ends: /.exec(t))) { if (!retriedAfter(lines.slice(mark.lines + 1), m[1])) await say(sessionMessage(state, m[1], pid)); }
          else if ((m = /^usage limit: waiting until (\S+ \d\d:\d\d)/.exec(t))) await say(eventLine("limit", { until: T.clock(when(m[1])), progress: progressOf(collect(state, pid)) }, T));
          else if ((m = /^session (\d+) resumes /.exec(t))) await say(eventLine("resume", { nn: m[1] }, T));
          else if ((m = /^session (\d+): transient error .*; try 1, waiting until (\S+ \d\d:\d\d)/.exec(t))) await say(eventLine("error", { nn: m[1], until: T.clock(when(m[2])) }, T)); // later tries stay quiet
          else if ((m = /^session (\d+) left no continuation prompt/.exec(t))) await say(eventLine("retry", { nn: m[1] }, T));
          else if ((m = /^rules: (.+)$/.exec(t))) await say(eventLine("rules", { text: m[1] }, T)); // the runner tells a rules file's change once
          else if ((m = /^chain ends: (.*)$/.exec(t))) {
            await say(chainMessage(state, m[1], pid));
            mark.lines++;
            // The chain is over and its card out: a notified.json that cannot be saved must not keep the watcher going.
            try { save(); } catch (e) { watchLog(state, `chain ended; could not save notified.json: ${e.message}`); }
            return fs.rmSync(lock, { force: true });
          }
        } catch (e) {
          // A line no card can be made of would hold every later card back for good: it is skipped on the third try.
          if (++poison < 3) throw e;
          watchLog(state, `watch loop: skipped a line it could not make a card of: ${e.message}`);
        }
        poison = 0;
        mark.lines++;
        save();
      }
      const current = [...lines].reverse().map((l) => /session (\d+) (starts|resumes|ends)/.exec(l)).find(Boolean);
      if (current && current[2] !== "ends") {
        // lastActivity looks past the main stream (a session waiting on a long workflow writes nothing itself).
        const f = path.join(state, `session-${current[1]}.jsonl`);
        let mtime = 0;
        try { mtime = lastActivity(state, current[1]); } catch {}
        if (!mtime) mtime = fs.existsSync(f) ? fs.statSync(f).mtimeMs : Date.now();
        if (Date.now() - mtime > QUIET_MINUTES * 60_000 && mark.quiet[current[1]] !== mtime) {
          const step = collect(state, pid).parsed.findLast((s) => s.nn === current[1])?.lastStep;
          await say(eventLine("quiet", { nn: current[1], minutes: QUIET_MINUTES, step: step && String(step).slice(0, 80) }, T));
          // Marked after the card: a watcher that dies mid-send sends it again on its next pass.
          mark.quiet[current[1]] = mtime;
          save();
        }
        // Say at once when a running session is on the wrong effort, not only on its card.
        mark.effort ||= {};
        if (!mark.effort[current[1]]) {
          const s = parseSession(state, current[1]);
          const run = readJson(path.join(state, "run.json"));
          if (s.efforts.length) {
            if (effortOff(state, run, s)) await say(eventLine("effort", { nn: current[1], got: s.efforts.join("/"), want: wantOf(state, run, current[1]).effort }, T));
            mark.effort[current[1]] = s.efforts.join("/");
            save();
          }
        }
      }
      if (pid && !alive(pid)) {
        await sleep(5_000);
        if (read(path.join(state, "chain.log")).split("\n").filter(Boolean).length > mark.lines) continue;
        await ask();
        await say(eventLine("died", {}, T));
        return fs.rmSync(lock, { force: true });
      }
      // A /stop now this watcher outlived (it is not the runner's child): its answer was the last word, no died card.
      if (await commands(state, pid, mark, save, started, opt.dry ? 0 : 20, T) === "stopped") return fs.rmSync(lock, { force: true });
    } catch (e) {
      watchLog(state, `watch loop: ${e.message}`);
      await sleep(Number(process.env.NIGHT_SHIFT_WATCH_RETRY_MS) || 5_000); // the env variable is for the tests: a poison line takes three of these
    }
  }
}

// What the bot answers for each outcome of runs.mjs's stopRun.
const STOP_LINE = { after: "stopAfter", now: "stopNow", failed: "stopFailed", unsure: "stopUnsure", gone: "stopGone", never: "stopGone", none: "stopNone" };

// /stop and /stop now: the one stop of runs.mjs, for this watcher's own run. The answer to /stop now goes out before the
// kill, since this watcher is the runner's child and dies at it; "stopped" tells the loop the chain is gone.
async function stopCommand(state, cmd, rest, delay, T) {
  const run = readJson(path.join(state, "run.json"));
  const project = path.basename(run.repo || state);
  const word = rest.toLowerCase();
  const now = word === "now" || word === T.cmdNow.toLowerCase();
  const answer = async (outcome) => {
    const sent = await send([eventLine(STOP_LINE[outcome], { project, cmd, now: T.cmdNow }, T)]);
    watchLog(state, `/${cmd}${now ? " now" : ""}: ${outcome}, ${sent}, ${delay()} s after the message`);
  };
  let told = false, r;
  try {
    r = await stopRun(run.repo, { now, state, via: "from Telegram", before: async (o) => { told = true; await answer(o); } });
  } catch (err) {
    // A pointer that is no JSON, a state folder that cannot be written: the update is confirmed, so silence would lose it.
    const sent = await send([eventLine("stopError", { project, text: err.message }, T)]);
    watchLog(state, `/${cmd}${now ? " now" : ""}: failed (${err.message}), ${sent}, ${delay()} s after the message`);
    return null;
  }
  // The answer before the kill said "now"; a runner that outlived it is told apart.
  if (!told || r.outcome !== "now") await answer(r.outcome);
  return r.outcome === "now" ? "stopped" : null;
}

// /inbox <text>: the text goes into the run's inbox.md after the time, on lines of its own; the next session reads it
// first (SKILL.md). Off until the user's own global config holds "telegramInbox": true, read at each command, so that
// turning it on or off needs no restart: it lets a phone steer a chain, and a project's file cannot turn it on
// (config.mjs, GLOBAL_ONLY).
const inboxOn = () => readGlobalConfig().config.telegramInbox === true;
const INBOX_LINE = { added: "inboxAdded", stopping: "inboxStopping", off: "inboxOff", empty: "inboxEmpty", failed: "inboxError" };
async function inboxCommand(state, cmd, rest, delay, T) {
  const project = path.basename(readJson(path.join(state, "run.json")).repo || state);
  let outcome, why = "";
  if (!inboxOn()) outcome = "off";
  else if (!rest) outcome = "empty";
  else {
    try {
      const file = path.join(state, "inbox.md"), old = read(file);
      fs.appendFileSync(file, `${old && !old.endsWith("\n") ? "\n" : ""}[${new Date().toLocaleString("sv-SE").slice(0, 16)} · Telegram] ${rest}\n`);
      // Once a stop is asked no session follows in this chain: the text waits for a start --state.
      outcome = fs.existsSync(path.join(state, "STOP-REQUEST")) ? "stopping" : "added";
    } catch (err) { outcome = "failed"; why = err.message; }
  }
  const sent = await send([eventLine(INBOX_LINE[outcome], { project, cmd, file: globalConfigFile(), text: why }, T)]);
  watchLog(state, `/${cmd}: ${outcome}${why ? ` (${why})` : ""}, ${sent}, ${delay()} s after the message`);
}

// /status, /report, /stop and /inbox from the user's own chat, read by long polling in place of the
// loop's wait. Two runs watching the same bot take turns (Telegram answers 409).
async function commands(state, pid, mark, save, started, seconds, T = strings()) {
  const cfg = readJson(telegramFile(), null);
  if (!seconds || !cfg?.token || !cfg.chatId) return sleep(20_000);
  let j = null;
  try { j = await telegram("getUpdates", cfg, { offset: (mark.update || 0) + 1, timeout: seconds, allowed_updates: ["message"] }); }
  catch (e) { watchLog(state, `getUpdates: ${e.name || ""} ${e.message}`); }
  // A failed poll is tried again soon: a command waits as long as the poll is down.
  if (!j?.ok) { if (j) watchLog(state, `getUpdates: ${j.description}`); return sleep(3_000); }
  for (const u of j.result) {
    mark.update = u.update_id;
    save();
    const msg = u.message;
    // telegram.json may hold the id as text; String() on both keeps it matching either way.
    if (String(msg?.chat?.id) !== String(cfg.chatId) || msg.date * 1000 < started - 60_000) continue;
    const cmd = /^\/(\w+)/.exec(msg.text || "")?.[1];
    const rest = (msg.text || "").replace(/^\/\w+(?:@\w+)?/, "").trim();
    const delay = () => Math.round((Date.now() - msg.date * 1000) / 1000);
    // The English name always answers; the run's table may add a name in its own language.
    const steer = cmd === "stop" || cmd === T.cmdStop ? "stop" : cmd === "inbox" || cmd === T.cmdInbox ? "inbox" : null;
    if (steer) {
      // Telegram confirms an update only with the next poll: one that steers the chain is confirmed first, so a /stop now
      // whose kill takes this watcher with it is not read again by the next chain's watcher, which starts with no offset,
      // and an /inbox is not added twice.
      const ok = await telegram("getUpdates", cfg, { offset: u.update_id + 1, timeout: 0, allowed_updates: ["message"] }).catch((e) => ({ description: e.message }));
      if (!ok?.ok) watchLog(state, `getUpdates (confirming /${cmd}): ${ok?.description}`);
      if (steer === "inbox") await inboxCommand(state, cmd, rest, delay, T);
      else if (await stopCommand(state, cmd, rest, delay, T) === "stopped") return "stopped";
      continue;
    }
    const reply = cmd === "status" || cmd === T.cmdStatus ? statusMessage(state, pid) : cmd === "report" || cmd === T.cmdReport ? reportMessage(state, pid) : null;
    if (!reply) continue;
    const outcome = await send([reply]);
    watchLog(state, `/${cmd}: ${outcome}, ${delay()} s after the message`);
  }
}

// ---------------------------------------------------------------- cli
function parseArgs(argv) {
  const [cmd = "help", ...rest] = argv;
  const o = { cmd };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue;
    const key = rest[i].slice(2);
    o[key] = rest[i + 1] !== undefined && !rest[i + 1].startsWith("--") ? rest[++i] : true;
  }
  return o;
}

if (isMain(import.meta)) {
  const opt = parseArgs(process.argv.slice(2));
  // The run's language table, loaded once before anything reads it; one that is gone or does not load reads
  // English and says so once: in watch.log for the watcher, on stderr for a command the user typed.
  if (typeof opt.state === "string") {
    const lang = await loadLang(stateLang(path.resolve(opt.state)));
    const why = lang.error && `language table: ${lang.error}; what the user reads is in English`;
    if (why && opt.cmd === "watch") watchLog(path.resolve(opt.state), why);
    else if (why) console.error(why);
  }
  if (opt.cmd === "show") console.log(buildReport(opt.state).plain);
  else if (opt.cmd === "notify") console.log(await notify(path.resolve(opt.state), typeof opt.headline === "string" ? opt.headline : "", opt));
  else if (opt.cmd === "card") {
    const state = path.resolve(opt.state);
    const card = opt.chain ? chainMessage(state, typeof opt.chain === "string" ? opt.chain : stateStrings(state).preview)
      : opt.nn ? sessionMessage(state, String(opt.nn).padStart(2, "0")) : statusMessage(state);
    console.log(opt.send ? await deliver([card]) : `${card.silent ? `(${stateStrings(state).silent})\n` : ""}${card.text}`);
  } else if (opt.cmd === "watch") await watch(opt);
  else if (opt.cmd === "telegram-setup") {
    const cfg = JSON.parse(read(telegramFile()) || "{}");
    if (!cfg.token) console.log(`no token in ${telegramFile()}`);
    else {
      const j = await telegram("getUpdates", cfg);
      if (!j.ok) console.log(`telegram: ${j.description}`);
      else {
        const { chatId, lines } = chooseChat(cfg, j.result, typeof opt.chat === "string" ? opt.chat : null);
        if (chatId != null) fs.writeFileSync(telegramFile(), JSON.stringify({ ...cfg, chatId }, null, 2));
        console.log(lines.join("\n"));
      }
    }
  } else {
    // The whole header comment, the shebang left out, up to the first line that is no comment.
    const head = read(SELF).split("\n").slice(1);
    console.log(head.slice(0, head.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  }
}
