#!/usr/bin/env node
// night-shift report: how a run is going, what it cost and what went wrong,
// read from the state folder and the session transcripts without a model call.
// Sent to Telegram when ~/.claude/night-shift/telegram.json holds a bot token.
//
//   node night-report.mjs show   --state <dir>
//   node night-report.mjs notify --state <dir> [--headline <text>] [--dry]
//   node night-report.mjs card   --state <dir> [--nn <n> | --chain [reason]] [--send]   (default: the /durum card)
//   node night-report.mjs watch  --state <dir> --pid <runner pid> [--announce] [--dry]
//   node night-report.mjs telegram-setup [--chat <id>]   (after pressing Start in the bot's chat)
//
// watch follows chain.log and sends a short card (telegram-cards.mjs) when a
// session ends, a line when the chain waits for a usage limit, resumes or
// retries a session, or a session goes quiet for 30 minutes, and a summary
// when the chain ends or its runner dies. In the bot's chat, /durum answers
// with what runs now and /rapor with the full report that `show` prints.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sessionCard, eventLine, chainCard, statusCard, reportCard, reportSection, chainProgress, progressText, splitHtml } from "./telegram-cards.mjs";
import { sessionPlan } from "./effort.mjs";

const SELF = fileURLToPath(import.meta.url);
const TELEGRAM = path.join(os.homedir(), ".claude", "night-shift", "telegram.json");
const QUIET_MINUTES = 30;
// Anthropic's price ratios to fresh input. They only split a model's dollars
// between rows; the dollars themselves are the sessions' own totals.
const WEIGHT = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, output: 5 };

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
// A file caught half-written (or by a crash) reads as its default: the watcher must outlive it.
const readJson = (f, dflt = {}) => { try { const v = JSON.parse(read(f)); return v && typeof v === "object" ? v : dflt; } catch { return dflt; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jsonl = (f) => read(f).split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hm = (d) => d.toLocaleTimeString("sv-SE").slice(0, 5);
const when = (at) => new Date(at.replace(" ", "T"));
const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usd = (n) => `$${n.toFixed(2)}`;
const pct = (u) => (u == null ? "—" : `%${Math.round(u > 1 ? u : u * 100)}`);
const minutes = (ms) => { const m = Math.round(ms / 60_000); return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : `${m} dk`; };
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

// <projects>/<project>/<sid>: the main transcript is <sid>.jsonl, subagents live under <sid>/.
function transcriptBase(sid) {
  const root = path.join(os.homedir(), ".claude", "projects");
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
  const base = transcriptBase(sid);
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
  const base = transcriptBase(sid);
  const mainEntries = base && fs.existsSync(`${base}.jsonl`) ? jsonl(`${base}.jsonl`) : entries;
  const rows = Object.entries(usageByModel(mainEntries, (j) => !j.parent_tool_use_id && !j.isSidechain))
    .map(([model, usage]) => ({ kind: "ana", model, agents: 0, usage }));
  const agents = agentRows(base);
  rows.push(...agents.rows);

  // Once the session has its totals: give the agents the output their transcripts
  // missed, then split each model's dollars over its rows by weighted tokens.
  if (result?.modelUsage) {
    for (const [key, mu] of Object.entries(result.modelUsage)) {
      const model = key.replace(/\[.*\]$/, "");
      const mine = rows.filter((r) => r.model === model);
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
      for (const r of mine) r.cost = units ? (mu.costUSD || 0) * r.usage.units / units : 0;
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
    // The effort each main-thread call really ran at (settings can drift: 2026-10-30, xhigh → high).
    efforts: [...new Set(mainEntries.filter((j) => j.type === "assistant" && !j.isSidechain && j.perTurnEffort).map((j) => j.perTurnEffort))],
    limits: entries.filter((j) => j.type === "rate_limit_event").map((j) => j.rate_limit_info).filter(Boolean),
    denials: toolResults.map(text).filter((t) => t.includes("night-shift guard:"))
      .map((t) => t.slice(t.indexOf("night-shift guard:") + 19).split(". Do not")[0]),
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
  const dir = path.join(os.homedir(), ".claude", "night-shift", "runs");
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
  const events = chainEvents(state);
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
      const note = runnerNote(e.text);
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
  const price = {};
  for (const s of parsed.filter((p) => p.result)) {
    for (const r of s.rows) {
      const p = (price[r.model] ||= { cost: 0, units: 0 });
      p.cost += r.cost || 0;
      p.units += r.usage.units;
    }
  }
  for (const s of parsed.filter((p) => !p.result)) {
    for (const r of s.rows) if (price[r.model]?.units) { r.cost = r.usage.units * price[r.model].cost / price[r.model].units; r.estimated = true; }
  }

  const issues = [];
  for (const s of parsed) {
    if (s.result?.is_error || (s.result && s.result.subtype !== "success")) issues.push(`❌ #${s.nn} hata ile bitti (${esc(s.result.subtype)})`);
    if (s.end && !s.result) issues.push(`❌ #${s.nn} sonuç satırı olmadan bitti (${esc(s.summary || "")})`);
    if (s.denials.length) issues.push(`⚠️ #${s.nn} guard ${s.denials.length} kez reddetti: ${esc(s.denials.slice(0, 2).join("; "))}`);
    for (const n of s.notes || []) issues.push(`⚠️ #${s.nn} ${esc(n)}`);
    if (!s.end && running && Date.now() - s.mtime > QUIET_MINUTES * 60_000) {
      issues.push(`⚠️ #${s.nn} ${minutes(Date.now() - s.mtime)}'dır sessiz (son adım: ${esc(s.lastStep || "?")})`);
    }
  }
  const since = when(String(run.startedAt || ""));
  for (const e of events.filter((x) => Number.isNaN(since.getTime()) || when(x.at) >= since)) {
    if (e.text.startsWith("usage limit: ")) issues.push(`⏳ ${hm(when(e.at))} limit doldu, ${esc(e.text.replace(/^usage limit: waiting until \S+ /, ""))}'e kadar bekledi`);
    if (/^session \d+: transient error .*; try 1,/.test(e.text)) issues.push(`🔌 ${hm(when(e.at))} ${esc(e.text.replace(/^session (\d+).*$/, "#$1 bağlantı ya da API hatası, yeniden denendi"))}`);
    if (/left no continuation prompt/.test(e.text)) issues.push(`🔁 ${hm(when(e.at))} ${esc(e.text.replace(/^session (\d+).*$/, "#$1 devam promptu yazmadı, yeniden denendi"))}`);
  }
  if (!ended && !running) issues.push("🛑 Runner çalışmıyor ve zincir bitti demedi (pencere kapanmış ya da yeniden başlatılmış olabilir)");
  const nextPrompt = read(path.join(state, "next-prompt.md")).trim();
  return { state, run, events, parsed, ended, running, issues, nextPrompt, sections: new Map() };
}

// A chain.log line about a session's model or handover, as a problem of that job (null for others).
const FABLE_WHY = [[/used up until (\S+ \S+)/, (m) => `Fable payı ${m[1]}'e kadar bitti`],
  [/is at (\S+), at or over the (\S+) ceiling/, (m) => `Fable payı ${m[1]}, ${m[2]} tavanında`],
  [/(\d+) Fable sessions already ran/, (m) => `zincir ${m[1]} Fable oturumu çalıştırdı, pay bilinmiyor`]];
function runnerNote(text) {
  let m;
  if ((m = /^session \d+ asked for Fable, but (.*); it runs on Opus at max$/.exec(text))) {
    const why = FABLE_WHY.map(([re, say]) => { const w = re.exec(m[1]); return w && say(w); }).find(Boolean) || m[1];
    return `Fable istedi, Opus max'te çalıştı (${why})`;
  }
  if (/^session \d+: Fable's allowance is used up/.test(text)) return "Fable payı bittiği için kesildi; parçası Opus max'te sürer";
  if ((m = /^session \d+ was to run on Fable, but (.*)$/.exec(text))) return `Fable'da çalışmadı: ${m[1]}`;
  if ((m = /^session \d+ wrote a next-prompt\.md of (\d+) KB/.exec(text))) return `devam promptu ${m[1]} KB (30 KB üstü; her çağrıda baştan okunur)`;
  if ((m = /^session \d+: MODEL: (\S+) is not a model/.exec(text))) return `MODEL: ${m[1]} tanınmadı, Opus'ta çalıştı`;
  return null;
}

// A job's night-report section, read once per collect (the report runs to thousands of lines).
function sectionOf(c, s) {
  if (!c.run.repo) return null;
  c.reportText ??= read(path.resolve(c.run.repo, c.run.report || "NIGHT_RUNS.md"));
  const key = `${s.nn} ${s.start}`;
  if (!c.sections.has(key)) c.sections.set(key, reportSection(c.reportText, s.nn, hm(when(s.start))));
  return c.sections.get(key);
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
  return progressText(p, now);
}

export function buildReport(state, { headline = "", focus = null, pid = null } = {}) {
  const c = collect(state, pid);
  const { run, parsed, ended, running, issues, nextPrompt } = c;
  state = path.resolve(state);

  const out = [];
  const progress = running ? progressOf(c) : null;
  const status = ended ? `Bitti: ${esc(ended.text.slice(12))}` : running ? `Çalışıyor · iş ${parsed.at(-1)?.nn || "—"}${run.maxSessions ? `/${run.maxSessions}` : ""}${run.until ? ` · bitiş ${run.until}` : ""}${progress ? ` · ${esc(progress)}` : ""}` : "Durdu";
  out.push(`🌙 <b>Gece vardiyası · ${esc(path.basename(run.repo || state))}</b>\n${headline ? `${esc(headline)}\n` : ""}${status} · ${hm(new Date())}`);
  out.push(`<b>Sorunlar</b>\n${issues.length ? issues.join("\n") : "✅ Sorun yok"}`);

  const jobs = parsed.map((s) => {
    const at = spanMs(s) > 12 * 3_600_000 ? (d) => `${d.toLocaleDateString("sv-SE").slice(5)} ${hm(d)}` : hm;
    const span = `${at(when(s.start))}–${s.end ? at(when(s.end)) : ""}`;
    const idle = idleMs(s);
    const took = minutes(spanMs(s) - idle) + (idle >= 60_000 ? ` (+${minutes(idle)} ara)` : "");
    const mark = !s.end ? "sürüyor" : s.result && !s.result.is_error && s.result.subtype === "success" ? "✅" : "❌";
    // Its report title; a prompt's first sentence is the same boilerplate for every job.
    const title = sectionOf(c, s)?.title;
    const extra = !s.end && s.lastStep ? `\n  son adım: ${esc(String(s.lastStep).slice(0, 60))} (${minutes(Date.now() - s.mtime)} önce)` : "";
    return `#${s.nn} ${span} · ${took} · ${mark}${title ? `\n  ${esc(title)}` : ""}${extra}`;
  });
  // next-prompt.md still holds the running session's own prompt until that session hands over.
  const current = parsed.at(-1) && !parsed.at(-1).end ? read(path.join(state, "prompts", `${parsed.at(-1).nn}.md`)).trim() : null;
  const lastDone = parsed.findLast((s) => s.end);
  const next = lastDone && sectionOf(c, lastDone)?.next;
  if (/^STOP\b/i.test(nextPrompt) && nextPrompt !== current) jobs.push(`🛑 ${esc(nextPrompt.split("\n").slice(0, 8).join("\n"))}`);
  else if (next && !ended) jobs.push(`Sıradaki: ${esc(next)}`);
  out.push(`<b>İşler</b>\n${jobs.join("\n") || "henüz iş yok"}`);

  const order = { ana: 0, alt: 1, wf: 2 };
  const rowLines = (rows) => rows.sort((a, b) => order[a.kind] - order[b.kind] || b.usage.units - a.usage.units).map((r) => {
    const count = r.kind === "ana" ? `${r.usage.calls} çağrı` : `${r.agents} ajan`;
    const cost = r.cost != null ? `${r.estimated ? "≈" : ""}${usd(r.cost)}` : "";
    const u = r.usage;
    return `${`${r.kind} ${modelName(r.model)}`.padEnd(15)} ${count.padEnd(10)} ${cost}\n  gir ${tokens(u.input)} oku ${tokens(u.read)} yaz ${tokens(u.write)} çık ${tokens(u.output)}`;
  }).join("\n");
  // Fable's share comes only with Fable calls, so it spans the events that carry it.
  const fableSpan = (ls) => {
    const f = ls.map(fableOf).filter(Boolean);
    return f.length ? ` · Fable ${pct(f[0].utilization)}→${pct(f.at(-1).utilization)}` : "";
  };
  const limitSpan = (ls) => (ls.length ? `5s ${pct(ls[0].unifiedWindows?.five_hour?.utilization)}→${pct(ls.at(-1).unifiedWindows?.five_hour?.utilization)} · 7g ${pct(ls[0].unifiedWindows?.seven_day?.utilization)}→${pct(ls.at(-1).unifiedWindows?.seven_day?.utilization)}${fableSpan(ls)}` : "—");
  const sessionCost = (s) => (s.result ? usd(s.result.total_cost_usd || 0)
    : s.rows.some((r) => r.cost != null) ? `≈${usd(s.rows.reduce((a, r) => a + (r.cost || 0), 0))} (sürüyor)` : "iş bitince");

  const shown = focus === "all" ? parsed : parsed.filter((s) => s.nn === (focus || parsed.at(-1)?.nn));
  for (const s of shown) {
    const other = [`sıkıştırma ${s.compactions}`, `düşünme ${tokens(s.rows.reduce((a, r) => a + r.usage.thinking, 0))}`, `araç hatası ${s.toolErrors}`];
    if (s.workflows.length) other.push(`workflow: ${s.workflows.join(", ")}`);
    if (!s.result && s.rows.some((r) => r.kind !== "ana")) other.push("ajan çıktısı iş bitince tamamlanır");
    out.push(`<b>Token · #${s.nn}</b>\n<pre>${esc(rowLines([...s.rows]))}\ndiğer: ${esc(other.join(" · "))}\ntoplam ${sessionCost(s)}\nlimit ${limitSpan(s.limits)}</pre>`);
  }

  if (parsed.length > 1 || focus === "all") {
    const total = {};
    for (const r of parsed.flatMap((s) => s.rows)) {
      const t = (total[`${r.kind}|${r.model}`] ||= { kind: r.kind, model: r.model, agents: 0, usage: blank(), cost: 0 });
      merge(t.usage, r.usage);
      t.agents += r.agents;
      t.cost += r.cost || 0;
      t.estimated ||= r.estimated;
    }
    const sum = Object.values(total).reduce((a, r) => a + r.cost, 0);
    out.push(`<b>Gece toplamı · ${parsed.length} iş</b>\n<pre>${esc(rowLines(Object.values(total)))}\ntoplam ${parsed.some((s) => !s.result) ? "≈" : ""}${usd(sum)}\nlimit ${limitSpan(parsed.flatMap((s) => s.limits))}</pre>`);
  }

  const timeline = [];
  for (const s of parsed) {
    if (!s.limits.length) continue;
    const w = (l) => l.unifiedWindows || {};
    const fs0 = s.limits.map(fableOf).filter(Boolean);
    const f = (x) => (fs0.length ? ` F ${pct(x?.utilization)}` : "");
    timeline.push(`${hm(when(s.start))} #${s.nn} başı  5s ${pct(w(s.limits[0]).five_hour?.utilization).padEnd(4)} 7g ${pct(w(s.limits[0]).seven_day?.utilization).padEnd(4)}${f(fs0[0])}`.trimEnd());
    timeline.push(`${s.end ? hm(when(s.end)) : hm(new Date())} #${s.nn} ${s.end ? "sonu " : "şimdi"} 5s ${pct(w(s.limits.at(-1)).five_hour?.utilization).padEnd(4)} 7g ${pct(w(s.limits.at(-1)).seven_day?.utilization).padEnd(4)}${f(fs0.at(-1))}`.trimEnd());
  }
  const all = parsed.flatMap((s) => s.limits);
  const latest = all.at(-1)?.unifiedWindows;
  if (latest) {
    const reset = (t, long) => { const d = new Date(t * 1000); return long ? `${d.toLocaleDateString("tr-TR").slice(0, 5)} ${hm(d)}` : hm(d); };
    const fable = all.map(fableOf).filter(Boolean).at(-1);
    timeline.push(`sıfırlanma: 5s ${reset(latest.five_hour?.resetsAt)} · 7g ${reset(latest.seven_day?.resetsAt, true)}${fable?.resetsAt ? ` · Fable ${reset(fable.resetsAt, true)}` : ""}`);
  }
  if (timeline.length) out.push(`<b>Limit çizelgesi</b> (hesabın tamamı)\n<pre>${esc(timeline.join("\n"))}</pre>`);

  if (run.repo && run.startedAt) {
    const commits = git(run.repo, ["log", `--since=${run.startedAt}`, "--format=%h %s"]).split("\n").filter(Boolean);
    const ahead = git(run.repo, ["rev-list", "--count", "@{u}..HEAD"]);
    const head = `<b>Commit'ler</b> · ${commits.length}${ahead ? ` · push bekleyen ${ahead}` : ""}`;
    out.push(`${head}${commits.length ? `\n${commits.slice(0, 8).map((c) => esc(c.slice(0, 72))).join("\n")}${commits.length > 8 ? `\n… ${commits.length - 8} daha` : ""}` : ""}\nRapor: ${esc(run.report || "NIGHT_RUNS.md")}`);
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
const pctOr = (u) => (u == null ? null : pct(u));
// Fable's weekly allowance, in the rate_limit_events of Fable calls only.
const fableOf = (l) => l?.unifiedWindows?.seven_day_overage_included || null;
const lastFable = (ls) => pctOr(ls.map(fableOf).filter(Boolean).at(-1)?.utilization);
const okOf = (s) => Boolean(s.result && !s.result.is_error && s.result.subtype === "success");
const costOf = (s) => (s.result ? s.result.total_cost_usd || 0 : s.rows.reduce((a, r) => a + (r.cost || 0), 0));
const firstCommit = (f) => f.commits[0]?.replace(/^\S+\s/, "");

// One job's card facts: its title and next step from the night report, its own problems and commits.
function jobFacts(c, s) {
  const section = sectionOf(c, s);
  const range = [`--since=${s.start}`, ...(s.end ? [`--until=${s.end}`] : [])];
  const commits = c.run.repo ? git(c.run.repo, ["log", ...range, "--format=%h %s"]).split("\n")
    .filter((l) => l && !/^\S+ docs: gece raporu/.test(l)) : [];
  const w = s.limits.at(-1)?.unifiedWindows || {};
  return {
    nn: s.nn, ok: okOf(s), took: minutes(workMs(s)),
    cost: `${s.result ? "" : "≈"}${usd(costOf(s))}`, five: pctOr(w.five_hour?.utilization), seven: pctOr(w.seven_day?.utilization),
    fable: lastFable(s.limits),
    title: section?.title, next: section?.next, waits: section?.waits || [], older: section?.older || 0,
    progress: s.end ? progressOf(c, s) : null,
    commits,
    problems: [
      ...(s.result && !okOf(s) ? [`hata ile bitti (${s.result.subtype})`] : []),
      ...(s.end && !s.result ? ["sonuç satırı olmadan bitti"] : []),
      ...(s.denials.length ? [`guard ${s.denials.length} kez reddetti: ${s.denials[0]}`] : []),
      ...(effortOff(c.state, c.run, s) ? [`düzey ${s.efforts.join("/")} (${wantOf(c.state, c.run, s.nn).effort} olmalı)`] : []),
      ...(s.notes || []),
    ],
  };
}

// The model and level a session should run at: its last "runs" line in chain.log (night-chain.mjs,
// 2026-11-15 on: Fable at high, a Fable request on Opus at max when refused), else what its prompt
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
  return s ? sessionCard(jobFacts(c, s)) : null;
}

export function chainMessage(state, reason, pid) {
  const c = collect(state, pid);
  const jobs = runJobs(c);
  const facts = jobs.map((s) => jobFacts(c, s));
  const limits = jobs.flatMap((s) => s.limits).map((l) => l.unifiedWindows?.seven_day?.utilization).filter((u) => u != null);
  // A STOP prompt lists what waits for the user under its first line.
  const waitList = /^STOP\b/i.test(c.nextPrompt) ? c.nextPrompt.split("\n").slice(1).map((l) => /^\s*(?:[-*] |\d+\. )(.*)$/.exec(l)?.[1])
    .filter(Boolean).map((l) => l.replace(/\*\*|`/g, "").slice(0, 100)) : [];
  return chainCard({
    project: path.basename(c.run.repo || c.state), reason,
    jobs: facts.map((f) => ({ nn: f.nn, ok: f.ok, title: f.title || firstCommit(f), took: f.took })),
    took: jobs.length ? minutes(jobs.reduce((a, s) => a + workMs(s), 0)) : null,
    cost: usd(jobs.reduce((a, s) => a + costOf(s), 0)),
    seven: limits.length ? `${pct(limits[0])}→${pct(limits.at(-1))}` : null,
    fable: (() => { const f = jobs.flatMap((s) => s.limits).map(fableOf).filter(Boolean); return f.length ? `${pct(f[0].utilization)}→${pct(f.at(-1).utilization)}` : null; })(),
    waits: waitList.length, waitList,
    problems: facts.flatMap((f) => f.problems.map((p) => `#${f.nn} ${p}`)),
  });
}

// /rapor: this run's jobs one line each, with the progress, the limits, problems and what waits.
export function reportMessage(state, pid) {
  const c = collect(state, pid);
  const jobs = runJobs(c);
  const w = jobs.flatMap((s) => s.limits).at(-1)?.unifiedWindows || {};
  return reportCard({
    project: path.basename(c.run.repo || c.state),
    state: c.ended ? `bitti: ${c.ended.text.slice(12).replace(/^STOP:\s*/i, "")}` : c.running ? "çalışıyor" : "durdu",
    at: hm(new Date()),
    progress: c.running ? progressOf(c) : null,
    five: pctOr(w.five_hour?.utilization), seven: pctOr(w.seven_day?.utilization), fable: lastFable(jobs.flatMap((s) => s.limits)),
    cost: jobs.length ?`${jobs.some((s) => !s.result) ? "≈" : ""}${usd(jobs.reduce((a, s) => a + costOf(s), 0))}` : null,
    jobs: jobs.map((s) => (s.end
      ? { nn: s.nn, ok: okOf(s), title: sectionOf(c, s)?.title, took: minutes(workMs(s)) }
      : { nn: s.nn, running: true, took: minutes(workMs(s)), step: s.lastStep && String(s.lastStep).slice(0, 60) })),
    // A day's folder can hold an earlier run: its jobs' problems are not this run's.
    problems: c.issues.filter((i) => { const m = /#(\d+)/.exec(i); return !m || jobs.some((s) => s.nn === m[1]); }),
    waits: waitsOf(c).map((l) => l.replace(/^\s*(?:[-*] |\d+\. )/, "").replace(/\*\*|`/g, "").slice(0, 100)).filter(Boolean),
  });
}

// What waits for the user once the chain is over: a STOP prompt's body (without its own
// heading), else the last finished job's **Waits for you** (its new items, the carried ones counted).
export function userWaits(state) {
  return waitsOf(collect(state, 0));
}

function waitsOf(c) {
  if (/^STOP\b/i.test(c.nextPrompt)) {
    const body = c.nextPrompt.split("\n").slice(1).join("\n").trim().split("\n");
    if (/^\W*(kullanıcıyı bekleyenler|waits for you)\b/i.test(body[0])) body.shift();
    return body.join("\n").trim() ? body.join("\n").trim().split("\n") : [];
  }
  const last = c.parsed.findLast((s) => s.end);
  const f = last && jobFacts(c, last);
  return f ? [...f.waits.map((w) => `- ${w}`), ...(f.older ? [`- ve ${f.older} eski madde (#${f.nn}'in raporunda)`] : [])] : [];
}

export function statusMessage(state, pid) {
  const c = collect(state, pid);
  const cur = c.parsed.at(-1), done = c.parsed.findLast((s) => s.end);
  const w = c.parsed.flatMap((s) => s.limits).at(-1)?.unifiedWindows || {};
  const f = done && jobFacts(c, done);
  return statusCard({
    project: path.basename(c.run.repo || c.state), running: c.running,
    state: c.ended ? `bitti: ${c.ended.text.slice(12)}` : "durdu",
    nn: cur && !cur.end ? cur.nn : null, took: cur && !cur.end ? minutes(workMs(cur)) : null,
    step: cur && !cur.end && cur.lastStep ? String(cur.lastStep).slice(0, 80) : null,
    effort: cur && !cur.end ? cur.efforts.join("/") || null : null,
    five: pctOr(w.five_hour?.utilization), fiveReset: w.five_hour?.resetsAt ? hm(new Date(w.five_hour.resetsAt * 1000)) : null,
    seven: pctOr(w.seven_day?.utilization), fable: lastFable(c.parsed.flatMap((s) => s.limits)),
    last: f &&{ nn: f.nn, ok: f.ok, title: f.title || firstCommit(f) }, next: f?.next,
    progress: c.running ? progressOf(c) : null,
  });
}

// ---------------------------------------------------------------- telegram
// Every request has its own deadline: fetch would wait 300 s for the headers of a connection
// that dropped without a word, and the watcher, with /durum and /rapor behind it, with it.
export async function telegram(method, cfg, body, { graceMs = 10_000 } = {}) {
  const api = process.env.NIGHT_SHIFT_TELEGRAM_API || "https://api.telegram.org";
  const r = await fetch(`${api}/bot${cfg.token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout((body?.timeout || 0) * 1000 + graceMs),
  });
  return r.json();
}

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
  try { cfg = JSON.parse(read(TELEGRAM)); } catch { return "no telegram.json"; }
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

export async function notify(state, headline, opt = {}) {
  const report = buildReport(state, { headline, focus: opt.focus, pid: opt.pid });
  fs.writeFileSync(path.join(state, "status.md"), report.plain);
  if (opt.dry) { console.log(`----- ${headline}\n${report.plain}`); return "dry"; }
  const outcome = await send(report.messages);
  if (outcome !== "sent") console.error(`night-report: ${outcome}`);
  return outcome;
}

// ---------------------------------------------------------------- watch
async function watch(opt) {
  const state = path.resolve(opt.state);
  const pid = Number(opt.pid) || runnerPid(state);
  const lock = path.join(state, "watch.pid");
  const other = Number(read(lock));
  if (other && other !== process.pid && alive(other)) return console.log(`already watched by pid ${other}`);
  fs.writeFileSync(lock, String(process.pid));
  const markFile = path.join(state, "notified.json");
  const mark = { lines: 0, quiet: {}, ...readJson(markFile) };
  const save = () => fs.writeFileSync(markFile, JSON.stringify(mark));
  // Each event is one short card; status.md keeps the full report for `status` and /rapor.
  // A card is sent until Telegram takes it or the give-up time passes; the caller counts its log line after that.
  const retryMs = Number(process.env.NIGHT_SHIFT_SEND_RETRY_MS) || 30_000, giveUpMs = Number(process.env.NIGHT_SHIFT_SEND_GIVEUP_MS) || 1_800_000;
  const say = async (message) => {
    fs.writeFileSync(path.join(state, "status.md"), buildReport(state, { pid }).plain);
    if (!message) return;
    if (opt.dry) return console.log(`----- ${message.silent ? "(sessiz)" : ""}\n${message.text}`);
    const began = Date.now();
    let outcome, tries = 0;
    for (;;) {
      outcome = await send([message]);
      tries++;
      // Unreadable HTML (a stray "<" in a title) must not lose the card: once more, tags stripped.
      if (/^telegram: .*can't parse entities/.test(outcome) && !message.plain) {
        message = { ...message, plain: true, text: message.text.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") };
        continue;
      }
      if (!outcome.startsWith("retry:")) break;
      if (tries === 1) watchLog(state, `card not taken, trying again: ${outcome}`);
      if (Date.now() - began >= giveUpMs) { outcome = `gave up on a card after ${tries} tries: ${outcome}`; break; }
      await sleep(retryMs);
    }
    if (outcome !== "sent") watchLog(state, outcome);
  };
  const cfg = readJson(TELEGRAM);
  if (cfg.token && !opt.dry) {
    await telegram("setMyCommands", cfg, { commands: [
      { command: "durum", description: "Şu an ne çalışıyor" }, { command: "rapor", description: "Tam rapor" }] }).catch(() => {});
  }
  const project = path.basename(readJson(path.join(state, "run.json")).repo || state);
  if (opt.announce) await say(eventLine("start", { project }));
  const started = Date.now();

  let poison = 0; // tries in a row that failed on one log line
  for (;;) {
    try {
      const lines = read(path.join(state, "chain.log")).split("\n").filter(Boolean);
      for (const line of lines.slice(mark.lines)) {
        const t = line.replace(/^\[[^\]]+\] /, "");
        let m;
        // A line is counted after its card was delivered or given up, so a card Telegram did not take is not lost.
        try {
          if ((m = /^session (\d+) ends: /.exec(t))) await say(sessionMessage(state, m[1], pid));
          else if ((m = /^usage limit: waiting until \S+ (\d\d:\d\d)/.exec(t))) await say(eventLine("limit", { until: m[1], progress: progressOf(collect(state, pid)) }));
          else if ((m = /^session (\d+) resumes /.exec(t))) await say(eventLine("resume", { nn: m[1] }));
          else if ((m = /^session (\d+): transient error .*; try 1, waiting until \S+ (\d\d:\d\d)/.exec(t))) await say(eventLine("error", { nn: m[1], until: m[2] })); // later tries stay quiet
          else if ((m = /^session (\d+) left no continuation prompt/.exec(t))) await say(eventLine("retry", { nn: m[1] }));
          else if ((m = /^chain ends: (.*)$/.exec(t))) {
            await say(chainMessage(state, m[1], pid));
            mark.lines++;
            save();
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
          mark.quiet[current[1]] = mtime;
          save();
          const step = collect(state, pid).parsed.findLast((s) => s.nn === current[1])?.lastStep;
          await say(eventLine("quiet", { nn: current[1], minutes: QUIET_MINUTES, step: step && String(step).slice(0, 80) }));
        }
        // Say at once when a running session is on the wrong effort, not only on its card.
        mark.effort ||= {};
        if (!mark.effort[current[1]]) {
          const s = parseSession(state, current[1]);
          const run = readJson(path.join(state, "run.json"));
          if (s.efforts.length) {
            mark.effort[current[1]] = s.efforts.join("/");
            save();
            if (effortOff(state, run, s)) await say(eventLine("effort", { nn: current[1], got: s.efforts.join("/"), want: wantOf(state, run, current[1]).effort }));
          }
        }
      }
      if (pid && !alive(pid)) {
        await sleep(5_000);
        if (read(path.join(state, "chain.log")).split("\n").filter(Boolean).length > mark.lines) continue;
        await say(eventLine("died"));
        return fs.rmSync(lock, { force: true });
      }
      await commands(state, pid, mark, save, started, opt.dry ? 0 : 20);
    } catch (e) {
      watchLog(state, `watch loop: ${e.message}`);
      await sleep(5_000);
    }
  }
}

// /durum and /rapor from the user's own chat, read by long polling in place of the
// loop's wait. Two runs watching the same bot take turns (Telegram answers 409).
async function commands(state, pid, mark, save, started, seconds) {
  const cfg = readJson(TELEGRAM, null);
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
    const reply = cmd === "durum" ? statusMessage(state, pid) : cmd === "rapor" ? reportMessage(state, pid) : null;
    if (!reply) continue;
    const outcome = await send([reply]);
    watchLog(state, `/${cmd}: ${outcome}, ${Math.round((Date.now() - msg.date * 1000) / 1000)} s after the message`);
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

if (path.resolve(process.argv[1] || "") === SELF) {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.cmd === "show") console.log(buildReport(opt.state).plain);
  else if (opt.cmd === "notify") console.log(await notify(path.resolve(opt.state), typeof opt.headline === "string" ? opt.headline : "", opt));
  else if (opt.cmd === "card") {
    const state = path.resolve(opt.state);
    const card = opt.chain ? chainMessage(state, typeof opt.chain === "string" ? opt.chain : "önizleme")
      : opt.nn ? sessionMessage(state, String(opt.nn).padStart(2, "0")) : statusMessage(state);
    console.log(opt.send ? await send([card]) : `${card.silent ? "(sessiz)\n" : ""}${card.text}`);
  } else if (opt.cmd === "watch") await watch(opt);
  else if (opt.cmd === "telegram-setup") {
    const cfg = JSON.parse(read(TELEGRAM) || "{}");
    if (!cfg.token) console.log(`no token in ${TELEGRAM}`);
    else {
      const j = await telegram("getUpdates", cfg);
      if (!j.ok) console.log(`telegram: ${j.description}`);
      else {
        const { chatId, lines } = chooseChat(cfg, j.result, typeof opt.chat === "string" ? opt.chat : null);
        if (chatId != null) fs.writeFileSync(TELEGRAM, JSON.stringify({ ...cfg, chatId }, null, 2));
        console.log(lines.join("\n"));
      }
    }
  } else console.log(read(SELF).split("\n").slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
