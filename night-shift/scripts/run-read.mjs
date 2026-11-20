// What a state folder's files say, with no card and no language logic beyond what a fact needs: the session streams and
// their transcripts, chain.log's lines, the run's pointer, the pricing of a session that has no totals yet, the waits of a
// STOP prompt. night-report.mjs (the report, the cards, the watcher) and dashboard.mjs both read a run through it.
// A module of its own because dashboard.mjs is loaded with import() from inside the watcher and the runner: night-report.mjs
// and night-chain.mjs end in a top-level await when they are the entry module, so a module that imported either one, at
// any depth, would never settle there (runs.mjs tells the same story). This one imports neither.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { strings } from "./lang/index.mjs";
import { claudeHome } from "./config.mjs";

// Anthropic's price ratios to fresh input. They only split a model's dollars
// between rows; the dollars themselves are the sessions' own totals.
export const WEIGHT = { input: 1, read: 0.1, write5m: 1.25, write1h: 2, output: 5 };

export const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
// A file caught half-written (or by a crash) reads as its default: the watcher must outlive it.
export const readJson = (f, dflt = {}) => { try { const v = JSON.parse(read(f)); return v && typeof v === "object" ? v : dflt; } catch { return dflt; } };
export const jsonl = (f) => read(f).split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : []; } catch { return []; } });
// chain.log's stamps are local time without a zone.
export const when = (at) => new Date(at.replace(" ", "T"));

// The lines of chain.log that start, resume and end a session, and the chain's own start and end (night-chain.mjs writes them).
export const LOG = {
  starts: /^session (\d+) starts: (.*)$/,
  resumes: /^session (\d+) resumes /,
  ends: /^session (\d+) ends: (.*)$/,
  chainStarts: "chain starts ",
  chainEnds: "chain ends: ",
};

// ---------------------------------------------------------------- tokens
export const blank = () => ({ calls: 0, input: 0, read: 0, write: 0, output: 0, thinking: 0, units: 0 });
export function add(acc, u) {
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
export const merge = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k]; return a; };

// One response is spread over several lines that repeat its id; the last one counts.
export function usageByModel(entries, keep = () => true) {
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
export const claudeOf = (state) => readJson(path.join(state, "run.json")).claudeConfigDir || claudeHome();
// <projects>/<project>/<sid>: the main transcript is <sid>.jsonl, subagents live under <sid>/.
export function transcriptBase(sid, state) {
  const root = path.join(claudeOf(state), "projects");
  for (const p of sid && fs.existsSync(root) ? fs.readdirSync(root) : []) {
    const base = path.join(root, p, sid);
    if (fs.existsSync(`${base}.jsonl`) || fs.existsSync(base)) return base;
  }
  return null;
}

// Last sign of life of a session: its stream, or any of its agents' transcripts
// (a session waiting on a long workflow writes nothing itself).
export function lastActivity(state, nn) {
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
export function agentRows(dir) {
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
export const DENIAL = /^[^\n]*night-shift guard: /;
export const denialReason = (t) => {
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
export function startTokens(entries) {
  const u = entries.find((j) => j.type === "assistant" && !j.parent_tool_use_id && !j.isSidechain && j.message?.usage && j.message.model !== "<synthetic>")?.message.usage;
  return u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
}

// lines: the result also holds the stream's parsed lines (entries), the main transcript's (mainEntries), the session id
// and the transcripts' base path, so that a caller reading more of the session reads its files once.
export function parseSession(state, nn, { lines = false } = {}) {
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
    ...(lines ? { entries, mainEntries, sid, base } : {}),
  };
}

// ---------------------------------------------------------------- the run
export function chainEvents(state) {
  return read(path.join(state, "chain.log")).split("\n").flatMap((l) => {
    const m = /^\[([^\]]+)\] (.*)$/.exec(l);
    return m ? [{ at: m[1], text: m[2] }] : [];
  });
}

// The pointer that names this state folder, in the run's own Claude folder: { file, ...pointer }, or null. A pointer file
// that is no JSON is skipped.
export function pointerOf(state) {
  const dir = path.join(claudeOf(state), "night-shift", "runs");
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const file = path.join(dir, f), p = JSON.parse(read(file));
      if (p.state && path.resolve(p.state) === path.resolve(state)) return { file, ...p };
    } catch {}
  }
  return null;
}

export const git = (repo, args, { timeout } = {}) => {
  try { return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, ...(timeout ? { timeout } : {}) }).trim(); } catch { return ""; }
};

// Dollars and weighted tokens of each model over sessions that have their totals; a row priced at them.
export function unitPrices(sessions) {
  const price = {};
  for (const r of sessions.flatMap((s) => s.rows)) {
    const p = (price[r.model] ||= { cost: 0, units: 0 });
    p.cost += r.cost || 0;
    p.units += r.usage.units;
  }
  return price;
}
export const priced = (r, price) => (price[r.model]?.units ? r.usage.units * price[r.model].cost / price[r.model].units : 0);

// A night-report commit (`docs: night report …`, or the phrase of the run's own language) is no job's work.
const reText = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const reportCommit = (T) => new RegExp(`^\\S+ docs: (?:${[...new Set([strings("en").reportCommit, T.reportCommit])].filter(Boolean).map(reText).join("|")})`);

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
export function isWaitsHead(line = "", T) {
  const text = line.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
  return [strings("en"), T].flatMap((t) => [t.waitsHead, waitsLabel(t)]).some((h) => h && text === h.toLowerCase());
}

// What a STOP prompt says waits for the user: its body's lines without its own heading, or null when the prompt is no STOP.
export function stopWaits(nextPrompt, T) {
  if (!/^STOP\b/i.test(nextPrompt)) return null;
  const body = nextPrompt.split("\n").slice(1).join("\n").trim().split("\n");
  if (isWaitsHead(body[0], T)) body.shift();
  return body.join("\n").trim() ? body.join("\n").trim().split("\n") : [];
}

// What a STOP prompt lists as waiting, one entry an item without its list marker, or null when the prompt is no STOP.
// An item is a list item ("- a", "* a", "1. a"), with the indented lines under it. A body without a list has items only
// under a heading of that list (isWaitsHead): the lines below it, but the count. Everything else is prose and no item:
// a summary, a heading in other words, **Remaining:**, and a closing sentence that says nothing waits (2026-11-20: one
// such sentence was the page's one thing waiting, the card's "Waits for you · 1" and wait's list). The price: a
// STOP prompt that names what waits in a plain sentence, with neither a list nor that heading, is counted as nothing;
// `wait` still prints its body, under "no items listed" (night-report.mjs's userWaits). A list item that is only the
// night report's word for nothing ("- New: none.", "- none") is no item either, as in a report's section.
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const listItem = (l) => l.replace(ITEM, "").trim();
const isNone = (item) => /^(?:new\s*:\s*)?none[\s.]*$/i.test(item.replace(/[*`]/g, ""));
export function stopItems(nextPrompt, T) {
  if (!/^STOP\b/i.test(nextPrompt)) return null;
  const lines = nextPrompt.split("\n").slice(1);
  if (!lines.some((l) => ITEM.test(l))) {
    const at = lines.findIndex((l) => isWaitsHead(l, T));
    return at < 0 ? [] : lines.slice(at + 1).filter((l) => !isWaitsHead(l, T) && !/^\s*\*\*Remaining:\*\*/.test(l)).map((l) => l.trim()).filter(Boolean);
  }
  const items = [];
  let inside = false;
  for (const l of lines) {
    if (ITEM.test(l)) { items.push(listItem(l)); inside = true; }
    else if (inside && /^\s+\S/.test(l)) items[items.length - 1] += ` ${l.trim()}`;
    else inside = false;
  }
  return items.filter((i) => i && !isNone(i));
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
