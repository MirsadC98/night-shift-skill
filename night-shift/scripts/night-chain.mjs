#!/usr/bin/env node
// night-shift runner: chains fresh headless Claude Code sessions, each the
// equivalent of the user typing /clear and pasting a continuation prompt.
// Sessions hand over through <state>/next-prompt.md; a first line
// "STOP: <reason>" ends the chain.
//
//   node night-chain.mjs start  --repo <dir> (--prompt-file <f> | --prompt <text> | --goal <text> | --goal-file <file>)
//                               [--until HH:MM] [--max-sessions <n>] [--session-hours 4] [--model <m>] [--allow-dirty]
//                               [--effort xhigh] [--fable-ceiling 0.6] [--fable-sessions 2]
//                               [--max-wait-hours 6] [--weekly-ceiling <share>] [--max-usd <dollars>]
//                               [--mode opus|fable|mythos] [--attended [true|false]]
//                               [--lang <code>] [--state <dir>] [--window]
//   (a goal needs no roadmap: the runner wraps it in references/goal.md's planning prompt, and session 1 writes a
//    roadmap for it, approves it and hands its first piece on; a goal starts fresh as a prompt does)
//   (--attended, "attended": true: the user is at hand but not watching. No session waits for them; each
//    writes a question that needs them to <state>/questions.md at once and goes on, as references/attended.md
//    says; --attended false turns a config's true off for one start)
//   (without --until and --max-sessions the chain goes on until a session writes STOP,
//    two handovers fail in a row, or stop is called; a usage limit pauses it, and the
//    session it cut off is resumed with --resume once the limit resets. start without
//    a prompt also resumes such a session, kept in <state>/resume.json, and a session the
//    last runner left unfinished (a power cut, a crash), whose own uncommitted work it lets
//    through. --state goes on in an earlier run's folder, from its next-prompt.md and session
//    count; --max-sessions counts the sessions this start runs. Every session runs
//    --model opus (or --model, "model" in .claude/night-shift.json) at xhigh (--effort, "effort"),
//    its subagents on Sonnet at medium (high when a call asks) and Haiku at high, whatever the user's own settings say (effort.mjs); a
//    prompt that opens with "EFFORT: high|xhigh|max" runs that one session at that level, and one that
//    opens with "MODEL: fable" (or "MODEL: mythos", the same model under its other name, for an account
//    it is open to) runs on that model at high (or its EFFORT) while their shared weekly allowance is
//    under --fable-ceiling ("fableCeiling"; while its ratio is unknown, at most --fable-sessions
//    "fableSessions" of the two in a chain), else on Opus at max; a session its allowance cuts off runs
//    again from its prompt on Opus at max, and so does every such prompt until the allowance resets.
//    A Mythos or Fable session the account cannot run hands its piece to Opus at max the same way.
//    --mode fable or --mode mythos ("mode") makes that model every session's model at high, and Opus
//    at xhigh (never max) stands in while its allowance is at or over the ceiling or used up.
//    --weekly-ceiling ("weeklyCeiling", default none) starts no new session once the seven-day window
//    is at or over that share, and ends the chain with next-prompt.md kept for a start with --state, and
//    --max-usd ("maxUsd", default none) does the same once the sessions this start ran cost that many dollars
//    (one that wrote no result line, killed or crashed, at what its transcript is priced at);
//    at or over 90% of the five-hour window a session waits for its reset)
//   node night-chain.mjs status --repo <dir>
//   node night-chain.mjs wait   --repo <dir> [--state <dir>]  (returns once the chain is over: exit 0
//                               with status's first lines and what waits for the user, 2 if it died;
//                               it follows a reload, and a usage-limit wait does not end it; in an attended
//                               run also on a new question in <state>/questions.md: exit 3 with the question
//                               and how to answer, while the chain goes on; run it again to wait on)
//   node night-chain.mjs stop   --repo <dir> [--now]   (/stop and /stop now in the bot's chat do the same)
//   node night-chain.mjs reload --repo <dir>       (a running chain takes up this code after
//                                                   the session in progress, watcher included)
//   node night-chain.mjs run    --state <dir>      (what start schedules)
//   node night-chain.mjs init --repo <dir>         (writes a starter .claude/night-shift.json and a rules file
//                                                   skeleton, .claude/night-shift-rules.md, never over a file,
//                                                   and prints the next steps)
//   node night-chain.mjs doctor [--repo <dir>]     (checks what a start needs, one line a check: the skill's copy
//                                                   and whether the guard protects its files from a night session,
//                                                   Node, git and the CLI, the config and rule files, the language
//                                                   table, the MCP list, the state folder, the guard's self-test and
//                                                   the hook the runner writes, a linked ~/.claude; exit 1 on a FAIL;
//                                                   no network and no model call)
//   node night-chain.mjs --version                 (this copy's version, which start keeps in run.json)
//
// start schedules `run` through Task Scheduler so the chain outlives the
// editor and the shell that started it. It runs in a hidden console
// (conhost --headless): no window shows, the log is <state>/chain.log, and
// `stop --now` is the emergency stop. --window keeps a visible console, whose
// closing stops the chain. A `run` that finds itself in a visible console
// without --window moves itself to a hidden one through the task. run also
// starts night-report.mjs watch, which sends each session's report to
// Telegram when it is set up. Every session reads <state>/night-settings.json
// anew; runChain rewrites only its own keys there.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildReport, userWaits, stateLang, questionLines, estimatedCost } from "./night-report.mjs";
import { slug, pointerFile, readPointer, writePointer, isRunner, stopRun } from "./runs.mjs";
import { strings, langOf, loadLang, langFile } from "./lang/index.mjs";
import { mergedConfig, isLangCode, MODES, CONFIG_KEYS, stateDirProblem, tempRoot, isMain, claudeHome, readGlobalConfig, globalConfigFile,
  projectConfigFile } from "./config.mjs";
import { sessionOutcome, windowSpan, fieldsGone } from "./session-outcome.mjs";
import { listedServers, mcpArgs, claudeJson, mcpConfigArg, MCP_ARG_MAX } from "./mcp.mjs";
import { ruleFiles, readRuleFile, rulesBlock } from "./rules.mjs";
import { VERSION, NODE_FLOOR } from "./version.mjs";
import { platform } from "./platform.mjs";
import { MAIN_MODEL, SUB_MODEL, MAIN_EFFORT, subEffortText, MAX_NOTE, nightModelSettings, sessionPlan, promptDirectives,
  directiveLines, fableGate, mainGate, fallbackNote, resolveMode, familyOf, isPremium, modelName, runModelIds, premiumNote,
  deniedNote, runsOn } from "./effort.mjs";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.dirname(path.dirname(SELF)); // the folder that holds SKILL.md
// T8 (2026-11-19): what a mode means for a session (when it may ask for Fable, what it never does) is in
// references/mode-<mode>.md, and a new session's header carries its own mode's text: SKILL.md, which every session
// loads, holds none of the three. "" for a mode with no file (a copy of the skill without it).
const modeRules = (mode) => (mode ? read(path.join(SKILL_DIR, "references", `mode-${mode}.md`)).replace(/\r\n/g, "\n").trim() : "");
// U24 (2026-11-19): start --goal "<text>" or --goal-file <path> needs no roadmap. The goal goes into this planning
// prompt, each line quoted ("> "), so that a heading or a MODEL: line in it stays the user's text and never the prompt's
// shape or a directive; session 1 plans the job and hands its first piece to session 2.
const GOAL_PROMPT = path.join(SKILL_DIR, "references", "goal.md");
// C3 (2026-11-19): an attended run's rules (the user at hand, not watching), in a new session's header after its mode's.
const ATTENDED = path.join(SKILL_DIR, "references", "attended.md");
const attendedRules = (run) => (run.attended ? read(ATTENDED).replace(/\r\n/g, "\n").trim() : "");
const goalPrompt = (goal, template) => template.replace(/\r\n/g, "\n").replace("{{goal}}",
  () => goal.replace(/\r\n?/g, "\n").trim().split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n"));
const GUARD = path.join(path.dirname(SELF), "guard.mjs");
const REPORT = path.join(path.dirname(SELF), "night-report.mjs");
const HIDE = path.join(path.dirname(SELF), "hide-windows.cjs");
const NODE = fs.realpathSync(process.execPath);

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
const fail = (msg) => { console.error(`night-shift: ${msg}`); process.exit(1); };
const now = () => new Date().toLocaleString("sv-SE");
const today = () => now().slice(0, 10).replace(/-/g, "");
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const parseOr = (t, d) => { try { return JSON.parse(t) || d; } catch { return d; } };
// The settings files below the runner's layer: the user's, the project's and its local one.
const lowerSettings = (repo) => [path.join(claudeHome(), "settings.json"), path.join(repo, ".claude", "settings.json"),
  path.join(repo, ".claude", "settings.local.json")].map((f) => parseOr(read(f), {}));
// CLAUDE_CODE_EFFORT_LEVEL would set every level, the subagents' included.
const withoutEffortEnv = (env) => { const { CLAUDE_CODE_EFFORT_LEVEL, ...rest } = env; return rest; };
const { alive } = platform;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// "Opus", or "Opus (claude-opus-5-5)" for a full model id: night-report.mjs reads the runs line back.
const modelText = (p) => `${cap(p.family)}${p.model !== p.family ? ` (${p.model})` : ""}`;
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(0, 16);
// A handover prompt over this many bytes is flagged: the next session reads all of it on every call.
// 12 KB since 2026-11-19 (T2), 30 KB before: one project's first prompts grew from 4.6k to 31.8k characters in three
// days, and its first calls by 17k tokens, unflagged; prompts written fresh hold 2–9 KB.
export const PROMPT_WARN_BYTES = 12_000;
// What a byte costs in each call: this chain's first 15 prompts (2.1–6.9 KB, English) added 0.4 tokens a byte to the
// first call's context (2026-11-19), that project's 0.6.
const PROMPT_TOKENS_PER_BYTE = 0.4;
// A fraction (0.6) or a percentage (60).
const ratioArg = (v, d) => { const n = Number(v); return v == null || v === true || Number.isNaN(n) ? d : n > 1 ? n / 100 : n; };
const countArg = (v, d) => { const n = Number(v); return v == null || v === true || !Number.isFinite(n) || n < 0 ? d : Math.floor(n); };
const pct = (u) => `${Math.round(u * 100)}%`;
// <state>/limits.json: { week: { ratio, resetsAt (s), at (ms) }, the seven-day window's last reading (--weekly-ceiling),
// five: the same of the five-hour window (FIVE_HOUR_WAIT), usd: { <conversation id>: dollars } of this start's sessions
// (--max-usd), and fieldsGone's memo { seen, told } (U14). A share as the stream gives it (0–1), or a percentage.
const shareOf = (u) => (u > 1 ? u / 100 : u);
// What each known stream field feeds, for the line that says it stopped arriving (fieldsGone).
const FIELD_USE = {
  rate_limit_event: "the limits line, the Fable gate and --weekly-ceiling have nothing to read",
  "unifiedWindows.five_hour": "the limits line's 5h has nothing to read",
  "unifiedWindows.seven_day": "--weekly-ceiling and the limits line's 7d have nothing to read",
  "unifiedWindows.seven_day_overage_included": "the Fable gate goes by its last reading until that resets, then by the session count",
};
const limitsFile = (state) => path.join(state, "limits.json");
export const readLimits = (state) => { const l = parseOr(read(limitsFile(state)), {}); return l && typeof l === "object" && !Array.isArray(l) ? l : {}; };
const writeLimits = (state, patch) => fs.writeFileSync(limitsFile(state), JSON.stringify({ ...readLimits(state), ...patch }, null, 2));
// The reading when it is at or over the ceiling and its window has not reset, with its share as a ratio; else null.
// A reading that names no reset counts only in the chain that took it (start drops it: nothing says when it goes stale).
export const weekOver = (week, ceiling, at = Date.now()) => {
  if (!ceiling || typeof week?.ratio !== "number" || (week.resetsAt && week.resetsAt * 1000 <= at)) return null;
  return shareOf(week.ratio) >= ceiling ? { ...week, share: shareOf(week.ratio) } : null;
};
// T10 (2026-11-19): a session started at 96 % of the five-hour window was cut four minutes in, after it had started
// three reviewers whose caches then expired. No session starts at or over this share of it; the chain waits for the
// reset its last reading names (a reading that names none is not waited for).
export const FIVE_HOUR_WAIT = 0.9;
export const fiveOver = (five, at = Date.now()) => (five?.resetsAt ? weekOver(five, FIVE_HOUR_WAIT, at) : null);
// T5: what this start's sessions cost, one conversation once, at its latest total.
export const spentUsd = (limits) => Object.values(limits?.usd && typeof limits.usd === "object" ? limits.usd : {}).reduce((a, v) => a + (Number(v) || 0), 0);
const usd = (n) => `$${n.toFixed(2)}`;
// At start: the readings while their windows have not reset, the fields seen, and nothing told yet (each chain tells once);
// no dollars: each start counts its own sessions' against --max-usd, as --max-sessions counts its own sessions.
const keepLimits = (state) => {
  const l = readLimits(state);
  const live = (r) => (r?.resetsAt * 1000 > Date.now() && typeof r.ratio === "number" ? r : null);
  const week = live(l.week), five = live(l.five);
  fs.writeFileSync(limitsFile(state), JSON.stringify({ ...(week ? { week } : {}), ...(five ? { five } : {}), seen: Array.isArray(l.seen) ? l.seen : [], told: [] }, null, 2));
  return week;
};
// Hours as people read them: two decimals at most, no trailing zeros, and "<0.01" instead of a 0 or an exponent.
export const hoursText = (h) => (h >= 0.01 ? String(Number(h.toFixed(2))) : "<0.01");
// start's line about the models: the mode, the main model at its level, and the Opus that stands in
// (fable or mythos mode) or what a MODEL line gets (opus mode). Fable and Mythos share one allowance.
export const modelLine = (run) => {
  const named = (m) => modelText({ family: familyOf(m), model: m });
  const ceiling = pct(run.fableCeiling ?? 0.6);
  return `  model:  ${named(run.model || MAIN_MODEL)} at ${run.effort} (mode ${run.mode}); ${isPremium(run.mode)
    ? `${named(run.opusModel || MAIN_MODEL)} at ${MAIN_EFFORT.opus} while ${modelName(run.mode)}'s weekly allowance is at or over ${ceiling} or used up`
    : `MODEL: fable or MODEL: mythos runs one piece at ${MAIN_EFFORT.fable} while their shared weekly allowance is under ${ceiling} (at most ${run.fableSessions ?? 2} such sessions while its share is unknown), else on Opus at max`}`;
};

// The repository's top folder, or null; quiet keeps git's own error line off the console (doctor names the problem).
function gitRoot(dir, quiet = false) {
  try {
    return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"],
      { cwd: dir, encoding: "utf8", windowsHide: true, ...(quiet ? { stdio: ["ignore", "pipe", "ignore"] } : {}) }).trim());
  } catch { return null; }
}
const repoRoot = (dir) => gitRoot(dir) || fail(`not a git repository: ${dir}`);
// flags: start's, so that a cap the user passes is theirs whatever a project's file says (config.mjs, CAPS).
const projectConfig = (repo, flags = {}) => {
  const { config, from, errors } = mergedConfig(repo, undefined, flags);
  if (errors.length) fail(errors.join("; "));
  return { config, from };
};
// start and status: what each rule file is to the user, in order (a file with no text is left out). A file
// that cannot be used is named, not dropped, so the user is never left thinking rules apply that do not.
const fileStatus = (files) => files.flatMap((file) => {
  const r = readRuleFile(file);
  return r.error ? [{ file, error: r.error }] : r.text ? [{ file, bytes: fs.statSync(file).size }] : [];
});
const ruleStatus = (repo) => fileStatus(Object.values(ruleFiles(repo)));
const ruleLines = (found) => (found.length ? found : [{ none: true }])
  .map((f) => `  rules:  ${f.none ? "none" : f.error ? `${f.file} ${f.error}` : `${f.file} (${f.bytes} bytes)`}`);

// Where start looks for the CLI, in order; doctor looks in the same places.
function locateClaude() {
  const candidates = [process.env.NIGHT_SHIFT_CLAUDE, ...platform.cliCandidates(path.dirname(NODE))].filter(Boolean);
  return { found: candidates.find((c) => fs.existsSync(c)), why: `${platform.cliName} not found; set NIGHT_SHIFT_CLAUDE (tried ${candidates.join(", ")})` };
}
const findClaude = () => { const { found, why } = locateClaude(); return found || fail(why); };

// --until's clock time, 0:00 to 23:59. Before 2026-11-19 "7" passed (its minutes NaN), and the chain had no end time.
const UNTIL = /^([01]?\d|2[0-3]):([0-5]\d)$/;
function deadline(hhmm) {
  const t = UNTIL.exec(String(hhmm));
  if (!t) fail(`--until wants a time HH:MM, such as 07:30 (got ${hhmm})`);
  const [h, m] = [Number(t[1]), Number(t[2])];
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// The session a runner runs first in this state folder: one a limit or a stop cut off goes on, else the one after the last.
const firstSession = (state) => Number(parseOr(read(path.join(state, "resume.json")), null)?.nn) ||
  fs.readdirSync(path.join(state, "prompts")).filter((f) => /^\d+\.md$/.test(f)).length + 1;
// The last session --max-sessions lets run: start stores it (lastSession); a run.json from before 2026-11-19 has only
// maxSessions, which was that number.
const lastSessionOf = (run) => run.lastSession ?? run.maxSessions ?? null;

// The session chain.log shows as started and never ended, with its conversation id.
export function cutOffSession(state) {
  const events = read(path.join(state, "chain.log")).split("\n")
    .map((l) => /\] (?:session (\d+) (starts|resumes|ends)|chain (starts|ends))\b/.exec(l)).filter(Boolean);
  const last = events.at(-1);
  if (!last || !last[1] || last[2] === "ends") return null;
  const nn = last[1];
  const sessionId = /"session_id":"([^"]+)"/.exec(read(path.join(state, `session-${nn}.jsonl`)))?.[1];
  // The model and level it ran on, from its last "runs" line (none in a log from before 2026-11-15).
  const runs = [...read(path.join(state, "chain.log")).matchAll(new RegExp(`\\] session ${nn} runs (\\w+)(?: \\(([^)]+)\\))? at (\\w+)`, "g"))].at(-1);
  return sessionId ? { nn, sessionId, ...(runs ? { model: runs[2] || runs[1].toLowerCase(), effort: runs[3] } : {}) } : null;
}

// Starts `run` for this state detached, through the project's scheduled task (platform.mjs, schedule), and returns
// the task's name, night-shift-<the repository's slug>. A visible console only with --window.
// NIGHT_SHIFT_LAUNCH=direct spawns it instead, and =fail fails (night-chain.test.mjs).
function scheduleRun(run, extra = []) {
  const args = ["run", "--state", run.state, ...(run.window ? [] : ["--headless"]), ...extra];
  if (process.env.NIGHT_SHIFT_LAUNCH === "fail") throw new Error("launch refused (test)");
  if (process.env.NIGHT_SHIFT_LAUNCH === "direct") {
    spawn(NODE, [SELF, ...args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return "direct";
  }
  return platform.schedule({ task: `night-shift-${slug(run.repo)}`, node: NODE, script: SELF, args, window: run.window, state: run.state,
    title: path.basename(run.repo) });
}

// ---------------------------------------------------------------- start
const HANDOVER_MS = 180_000;
// The guard as the runner's settings layer runs it before a session's tool calls; doctor runs this very command.
const guardHook = () => ({ type: "command", command: NODE, args: [GUARD], timeout: 15, onFailure: "block" });
// What a copy of the skill needs beside this script (a copy of scripts/ alone lacks the texts the runner reads).
const SKILL_FILES = ["SKILL.md", ...MODES.map((m) => `references/mode-${m}.md`), "references/goal.md", "references/attended.md",
  "references/interactive.md", "scripts/guard.mjs", "scripts/night-report.mjs", "scripts/hide-windows.cjs"];
// Where a listed MCP server came from, for start's line, and where one is looked for (mcp.mjs).
const MCP_SOURCE = { local: () => "yours, this repository only", project: () => "this repository's .mcp.json", user: () => "yours",
  plugin: (name) => `plugin ${name.split(":")[1]}` };
const MCP_PLACES = (repo) => `${claudeJson(os.homedir(), process.env)}, ${path.join(repo, ".mcp.json")}`;
// start's checks of the config, which doctor makes too. pickMode: the mode and model from start's flags (none for
// doctor) over the config; they may come from different layers (or a flag), so an error names where each came from.
function pickMode(opt, cfg, from) {
  const picked = resolveMode({ mode: opt.mode ?? cfg.mode, model: typeof opt.model === "string" ? opt.model : cfg.model });
  if (!picked.error) return picked;
  const src = [["mode", opt.mode !== undefined ? "--mode" : from.mode], ["model", typeof opt.model === "string" ? "--model" : from.model]]
    .filter(([, s]) => s).map(([k, s]) => `${k} from ${s}`);
  return { error: src.length ? `${picked.error} (${src.join(", ")})` : picked.error };
}
function mcpCheck(cfg, from, repo) {
  // A listed MCP server is started from its own config (mcp.mjs): one no config holds would be missing all night.
  const found = Array.isArray(cfg.mcp) ? listedServers(cfg.mcp, { repo }) : null;
  if (found?.missing.length) {
    return { found, error: `"mcp" in ${from.mcp} names ${found.missing.map((n) => JSON.stringify(n)).join(", ")}, which no MCP config holds (looked in ${MCP_PLACES(repo)} and the installed plugins); ` +
      'a claude.ai connector or a server in an .mcpb bundle starts only with "mcp": "inherit"' };
  }
  // The configs go on the session's command line, which Windows cuts at 32,767 characters: a session that cannot start would be retried for hours.
  const size = found ? mcpConfigArg(found.servers).length : 0;
  if (size > MCP_ARG_MAX) return { found, error: `the configs of the MCP servers "mcp" lists take ${size} characters, more than a session's command line holds (${MCP_ARG_MAX}); list fewer, or set "mcp": "inherit"` };
  return { found, error: null };
}
// The state folder of a start without --state today: stateDir, else one in the temp folder named after the repository.
const defaultState = (repo, cfg) => path.resolve((cfg.stateDir || path.join(tempRoot(), `night-shift-${path.basename(repo)}-{date}`)).replace("{date}", today()));
// A start that failed before run.json (no prompt, a dirty tree) leaves only what start itself made; that is no one else's folder.
const foreignState = (state) => !fs.existsSync(path.join(state, "run.json")) && fs.existsSync(state) && fs.readdirSync(state).some((f) => !["prompts", "next-prompt.md"].includes(f));

async function start(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const ptr = readPointer(repo);
  if (ptr && !ptr.finished) {
    if (isRunner(ptr.pid)) fail(`a run is already active (pid ${ptr.pid}, state ${ptr.state}); reload gives it new runner code`);
    // pid 0: scheduled, not yet picked up. Only a recent one still counts; an older one never came up.
    const age = Date.now() - Date.parse(ptr.scheduledAt);
    if (!ptr.pid && age < HANDOVER_MS) fail(`a run was scheduled ${Math.round(age / 1000)} s ago and its runner has not come up yet; wait, or run stop`);
  }

  const { config: cfg, from } = projectConfig(repo, opt);
  // Unlike the other numbers, a wrong one here is not quietly replaced: a wait of 1 h or 6 h is not what was typed.
  const waitArg = opt["max-wait-hours"];
  if (waitArg !== undefined && !(typeof waitArg === "string" && Number.isFinite(Number(waitArg)) && Number(waitArg) > 0)) {
    fail(`--max-wait-hours must be a positive number of hours (got ${waitArg === true ? "no value" : waitArg})`);
  }
  // The same for the other limits, and a flag that has a config key gets that key's check: before 2026-11-19 a
  // wrong --max-sessions meant no limit, a wrong --session-hours ended each session at once, and a wrong
  // --fable-ceiling became 0.6 over the config's value.
  const got = (v) => (v === true ? "no value" : v);
  const num = (v) => (typeof v === "string" && v.trim() ? Number(v) : NaN);
  if (opt.until !== undefined && !UNTIL.test(String(opt.until))) fail(`--until wants a time HH:MM, such as 07:30 (got ${got(opt.until)})`);
  if (opt["max-sessions"] !== undefined && !/^0*[1-9]\d*$/.test(String(opt["max-sessions"]))) fail(`--max-sessions must be a whole number above 0 (got ${got(opt["max-sessions"])})`);
  const hoursArg = opt["session-hours"];
  // At most 500: a timer over 2^31 ms (about 596 h) fires at once.
  if (hoursArg !== undefined && !(num(hoursArg) > 0 && num(hoursArg) <= 500)) fail(`--session-hours must be a positive number of hours, at most 500 (got ${got(hoursArg)})`);
  for (const [flag, key] of [["effort", "effort"], ["fable-ceiling", "fableCeiling"], ["fable-sessions", "fableSessions"], ["weekly-ceiling", "weeklyCeiling"], ["max-usd", "maxUsd"]]) {
    const v = opt[flag];
    const bad = v !== undefined && CONFIG_KEYS[key](key === "effort" ? v : num(v));
    if (bad) fail(`--${flag} ${bad} (got ${got(v)})`);
  }
  // Dropped in silence before: a --state so given started a new folder instead of the earlier run's.
  if (opt.model === true) fail("--model wants a model name (got no value)");
  if (opt.state === true) fail("--state wants the folder of an earlier run (got no value)");
  // U24: a goal instead of a prompt, refused beside one, since which of the two was meant is not guessed. Read here,
  // before anything is written, so that a refused goal leaves an earlier run's next-prompt.md and resume.json as they were.
  let planning = null;
  if (opt.goal !== undefined || opt["goal-file"] !== undefined) {
    if (opt.prompt !== undefined || opt["prompt-file"] !== undefined) fail("pass a goal (--goal, --goal-file) or a prompt (--prompt, --prompt-file), not both");
    if (opt.goal !== undefined && opt["goal-file"] !== undefined) fail("pass --goal or --goal-file, not both");
    // parseArgs reads a value that starts with -- as the next flag.
    if (opt.goal === true) fail("--goal wants the goal's text (got no value; a goal that starts with -- goes in a file for --goal-file)");
    const file = opt["goal-file"];
    if (file === true) fail("--goal-file wants a file (got no value)");
    if (file !== undefined && !(fs.existsSync(file) && fs.statSync(file).isFile())) fail(`--goal-file ${path.resolve(file)}: no such file`);
    let goal = opt.goal;
    if (file !== undefined) { try { goal = fs.readFileSync(file, "utf8"); } catch (e) { fail(`--goal-file ${path.resolve(file)} cannot be read (${e.code || e.message})`); } }
    if (!goal.trim()) fail(file !== undefined ? `--goal-file ${path.resolve(file)} holds no goal` : "--goal wants the goal's text (got none)");
    const template = read(GOAL_PROMPT);
    if (!template.includes("{{goal}}")) fail(`${GOAL_PROMPT} is missing or has no {{goal}} line; copy the skill folder again`);
    planning = goalPrompt(goal, template);
  }
  // C3: --attended alone or "true" turns it on, "false" turns a config's true off for this start; nothing else is guessed.
  const attArg = opt.attended;
  if (attArg !== undefined && ![true, "true", "false"].includes(attArg)) fail(`--attended takes true or false (got ${attArg})`);
  const attended = attArg !== undefined ? attArg !== "false" : cfg.attended === true;
  if (attended && !read(ATTENDED).trim()) fail(`${ATTENDED} is missing; copy the skill folder again`);
  // A language is never guessed from "PT" or "pt-BR": a night in English that was asked for in another language is worse than a refusal.
  if (opt.lang !== undefined && !isLangCode(opt.lang)) fail(`--lang must be a language code in lowercase, such as en or pt-br (got ${opt.lang === true ? "no value" : opt.lang})`);
  if (opt.mode !== undefined && !MODES.includes(opt.mode)) fail(`--mode must be one of ${MODES.join(", ")} (got ${opt.mode === true ? "no value" : opt.mode})`);
  const picked = pickMode(opt, cfg, from);
  if (picked.error) fail(picked.error);
  // The user's language table (lang/index.mjs) must load now, for the same reason.
  const lang = opt.lang ?? cfg.lang ?? "en";
  const table = await loadLang(lang);
  if (table.error) fail(`${opt.lang !== undefined ? `--lang ${lang}` : `lang ${lang} from ${from.lang}`}: ${table.error}`);
  // A file the runner would have to leave out is refused here, while the user is at the keyboard.
  const badRules = ruleStatus(repo).filter((f) => f.error);
  if (badRules.length) fail(badRules.map((f) => `${f.file} ${f.error}`).join("; "));
  const { found: mcpFound, error: mcpError } = mcpCheck(cfg, from, repo);
  if (mcpError) fail(mcpError);
  let state = typeof opt.state === "string" ? path.resolve(opt.state) : defaultState(repo, cfg);
  // The runner writes here and a session reads its instructions from here: not a folder of the user's own.
  const wide = stateDirProblem(state, { home: os.homedir(), repo, temp: tempRoot() });
  if (wide) fail(`${typeof opt.state === "string" ? "--state" : "stateDir"} ${state} ${wide}`);
  if (typeof opt.state === "string" && !fs.existsSync(path.join(state, "run.json"))) fail(`--state ${state} holds no earlier run`);
  if (foreignState(state)) fail(`${state} is not empty and holds no earlier run; pick another state folder`);
  fs.mkdirSync(path.join(state, "prompts"), { recursive: true });
  // In long form, so the guard, which refuses 8.3 short names, accepts the handover's path whatever way --state or %TEMP% spelled it.
  state = fs.realpathSync.native(state);
  const next = path.join(state, "next-prompt.md");
  // A new prompt, a goal's included, starts fresh; without one, a session a usage limit cut off (resume.json) goes on.
  if (planning) fs.writeFileSync(next, planning);
  else if (opt["prompt-file"]) fs.copyFileSync(opt["prompt-file"], next);
  else if (typeof opt.prompt === "string") fs.writeFileSync(next, opt.prompt);
  else if (!read(next).trim()) fail("no prompt: pass --prompt-file, --prompt, --goal or --goal-file");
  const resumeFile = path.join(state, "resume.json");
  const fresh = Boolean(planning) || Boolean(opt["prompt-file"]) || typeof opt.prompt === "string";
  if (fresh) fs.rmSync(resumeFile, { force: true });
  // A runner that died mid-session (a power cut, a crash, a restart) leaves the session
  // unfinished in chain.log; start without a prompt goes on in that conversation.
  const cut = !fresh && !fs.existsSync(resumeFile) && cutOffSession(state);
  if (cut) fs.writeFileSync(resumeFile, JSON.stringify({ ...cut, why: "stopped" }));
  // The tree may hold the uncommitted work of the session that goes on; anything else must be committed.
  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8", windowsHide: true }).trim();
  if (dirty && !opt["allow-dirty"] && !fs.existsSync(resumeFile)) fail("the working tree has uncommitted changes; commit them first (or pass --allow-dirty)");
  fs.rmSync(path.join(state, "STOP-REQUEST"), { force: true });

  // The task runs with the user's stored environment, not this shell's: keep
  // this PATH, minus fnm's per-shell links, with the real node directory first.
  const sessionPath = [path.dirname(NODE), ...String(process.env.PATH || "").split(path.delimiter).filter((p) => p && !/fnm_multishells/i.test(p))].join(path.delimiter);
  // --max-sessions counts the sessions this start runs, a resumed one first, in an earlier run's folder too.
  const maxSessions = opt["max-sessions"] !== undefined ? Number(opt["max-sessions"]) : null;
  const run = {
    repo,
    state,
    until: opt.until || null,
    deadline: opt.until ? deadline(opt.until) : null,
    maxSessions,
    lastSession: maxSessions ? firstSession(state) + maxSessions - 1 : null,
    sessionHours: hoursArg !== undefined ? Number(hoursArg) : 4,
    mode: picked.mode,
    model: picked.model,
    opusModel: picked.opusModel,
    effort: typeof opt.effort === "string" ? opt.effort : cfg.effort || MAIN_EFFORT[picked.mode],
    // MODEL: fable and MODEL: mythos prompts: that model while their shared weekly allowance is under
    // this share, and at most this many sessions of the two while the share is unknown (effort.mjs, fableGate).
    fableCeiling: ratioArg(opt["fable-ceiling"] ?? cfg.fableCeiling, 0.6),
    fableSessions: countArg(opt["fable-sessions"] ?? cfg.fableSessions, 2),
    // The longest a usage limit's reset may be away for the chain to wait for it; farther ends the chain.
    maxWaitHours: waitArg !== undefined ? Number(waitArg) : cfg.maxWaitHours > 0 ? cfg.maxWaitHours : 6,
    // No new session once the seven-day window's use is at or over this share (null: no ceiling).
    weeklyCeiling: ratioArg(opt["weekly-ceiling"] ?? cfg.weeklyCeiling, null),
    // T5: no new session once the sessions this start ran cost this many dollars (null: no cap). Checked between
    // sessions, never inside one: the CLI's --max-budget-usd would end a session mid-piece, its tree dirty.
    maxUsd: opt["max-usd"] !== undefined ? num(opt["max-usd"]) : cfg.maxUsd ?? null,
    // "none", "inherit" or the list of servers the guard lets through (the guard reads the same file).
    mcp: cfg.mcp ?? "none",
    // C3: the user is at hand but not watching (references/attended.md); a run.json without it is unattended.
    attended,
    lang,
    claude: findClaude(),
    report: cfg.report || "NIGHT_RUNS.md",
    path: sessionPath,
    window: Boolean(opt.window),
    // The task runs with the user's stored environment, which may lack this shell's CLAUDE_CONFIG_DIR: the runner
    // sets it from here, so it, its sessions and the guard use the Claude folder this start used (claudeHome).
    ...(process.env.CLAUDE_CONFIG_DIR ? { claudeConfigDir: claudeHome() } : {}),
    // C4: the copy that started the run, for a report of what ran (a reload takes up newer code without changing it).
    version: VERSION,
    startedAt: now(),
  };
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify(run, null, 2));
  // Each chain counts its own Fable sessions and measures the allowance anew; one used up stays so.
  const fableFile = path.join(state, "fable.json");
  const fable = parseOr(read(fableFile), {});
  fs.writeFileSync(fableFile, JSON.stringify(fable.outUntil > Date.now() ? { outUntil: fable.outUntil } : {}, null, 2));
  // The seven-day window's last reading stays while it has not reset, so a start that goes on here does not spend a
  // session to learn the window is still over the ceiling; the stream fields seen stay, what was told goes (keepLimits).
  const week = keepLimits(state);
  let task;
  try { task = scheduleRun(run); } catch (e) { fail(`Task Scheduler: ${String(e.stderr || e.message).trim().split("\n")[0]}`); }
  writePointer(repo, { pid: 0, state, task, scheduledAt: now(), finished: false });
  console.log(`night-shift started for ${repo}`);
  if (cut) console.log(`  resumes session ${cut.nn} (${cut.sessionId}), which the last runner left unfinished`);
  console.log(`  state:  ${state}`);
  if (planning) console.log("  goal:   the first session plans it into a roadmap (references/goal.md); the work starts in the session after it");
  if (run.attended) console.log(`  attended: no session waits for you; each writes a question that needs you to ${path.join(state, "questions.md")} at once and goes on (references/attended.md)`);
  console.log(modelLine(run));
  console.log(`  until:  ${run.until ? `${run.until} (no new session after that)` : "the work is done (STOP)"}${run.maxSessions ? `, at most ${run.maxSessions} sessions, the last of them session ${String(run.lastSession).padStart(2, "0")}` : ""}`);
  for (const l of ruleLines(ruleStatus(repo))) console.log(l);
  if (run.weeklyCeiling) {
    const over = weekOver(week, run.weeklyCeiling);
    console.log(`  ceiling: no new session once the seven-day window is at or over ${pct(run.weeklyCeiling)}${over
      ? `; it was at ${pct(over.share)} at ${stamp(week.at)}, so none starts before it resets ${stamp(week.resetsAt * 1000)}` : ""}`);
  }
  if (run.maxUsd) console.log(`  cap:    no new session once this start's sessions cost ${usd(run.maxUsd)} or more`);
  if (mcpFound?.found.length) console.log(`  mcp:    ${mcpFound.found.map((f) => `${f.name} (${MCP_SOURCE[f.source](f.name)})`).join(", ")}; no other server starts`);
  else if (cfg.mcp === "inherit") console.log("  mcp:    inherit: every MCP server you have starts in each session, and the guard lets all their tools through");
  console.log(`  status: node "${SELF}" status --repo "${repo}"`);
  console.log(`  stop:   node "${SELF}" stop --repo "${repo}" [--now]`);
}

// ---------------------------------------------------------------- run
async function runChain(opt) {
  const state = path.resolve(opt.state || fail("run needs --state"));
  const stored = JSON.parse(read(path.join(state, "run.json")) || fail(`no run.json in ${state}`));
  // A run.json from before modes has no mode: its model says which it is, and a Fable (or Mythos) one runs
  // at that model's level, not at the effort that was stored for Opus.
  const run = stored.mode ? stored : (({ error, ...r }) => ({ ...stored, ...r, ...(isPremium(r.mode) ? { effort: MAIN_EFFORT[r.mode] } : {}) }))(resolveMode({ model: stored.model }));
  // Fable or mythos mode: that model (`main`) runs every session, and Opus stands in for it.
  const premiumMode = isPremium(run.mode);
  const main = premiumMode ? run.mode : null;
  const { repo } = run;
  // The Claude folder start used (claudeHome), for this runner, its sessions, their guard and the watcher.
  if (run.claudeConfigDir && !process.env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = run.claudeConfigDir;
  const logFile = path.join(state, "chain.log");
  const log = (line) => { const l = `[${now()}] ${line}`; console.log(l); fs.appendFileSync(logFile, l + "\n"); };
  const next = path.join(state, "next-prompt.md");
  const stopFile = path.join(state, "STOP-REQUEST");
  const reloadFile = path.join(state, "RELOAD-REQUEST");
  // NIGHT_SHIFT_RELOADED: set by the hand-over of runners from before --reloaded (2026-10-31).
  const reloaded = Boolean(opt.reloaded) || process.env.NIGHT_SHIFT_RELOADED === "1";
  // In a visible console without --window (launch.cmd by hand, or an older runner's hand-over):
  // go on in a hidden one through the task, before touching anything.
  if (!run.window && !opt.headless) {
    try {
      scheduleRun(run, reloaded ? ["--reloaded"] : []);
      log("runner moves to a hidden console (conhost --headless) through the scheduled task");
      process.exit(0);
    } catch (e) { log(`could not move to a hidden console (${String(e.stderr || e.message).trim().split("\n")[0]}); runs here`); }
  }
  const pointer = { ...(readPointer(repo) || {}), pid: process.pid, state, finished: false, startedAt: now(), reloadable: true };
  writePointer(repo, pointer);
  // A runner handing over may mark the pointer finished after this one wrote it; put it back. Not once a stop was asked:
  // a stop from inside this runner's tree (the bot's /stop now, runs.mjs) marks it finished before its kill, and that
  // mark must stand; no hand-over follows a stop request. NIGHT_SHIFT_HEAL_MS: a shorter tick for night-chain.test.mjs.
  const heal = setInterval(() => {
    if (fs.existsSync(stopFile)) return;
    const p = readPointer(repo);
    if (!p || p.pid !== process.pid || p.finished) writePointer(repo, pointer);
  }, Number(process.env.NIGHT_SHIFT_HEAL_MS) || 30_000);

  // Keep the machine awake while this process lives; the helper exits with it.
  const awake = platform.keepAwake(process.pid);
  // Telegram reports come from a process of its own, so it can still report this one dying.
  const startWatcher = (announce) => spawn(NODE, [REPORT, "watch", "--state", state, "--pid", String(process.pid), ...(announce ? ["--announce"] : [])],
    { detached: true, stdio: "ignore", windowsHide: true }).unref();
  startWatcher(!reloaded);

  // A crash would end the process with nothing in chain.log and the pointer still "running".
  // A throw inside runChain is a rejection of its promise, so the body below is wrapped as well.
  const die = (e) => {
    const reason = `the runner crashed: ${String((e && e.message) || e).split("\n")[0].slice(0, 200)}`;
    try { clearInterval(heal); } catch {}
    try { log(`chain ends: ${reason}`); } catch {}
    try { writePointer(repo, { ...pointer, finished: true, finishedAt: now(), reason }); } catch {}
    try { awake.kill(); } catch {}
    process.exit(1);
  };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
  try {

  // What was added to an earlier run's settings by hand (an env, another hook) stays;
  // the guard, the limit wait, the subagent model, the efforts and crossSessionInbound are written over.
  // Before every session, not once: the file sits in a folder the sessions can write, and one
  // that dropped the guard's hook from it would run every later session without the guard.
  const settings = path.join(state, "night-settings.json");
  // levels: this session's { [family]: level }; Opus keeps the run's level and Fable and Mythos their own
  // otherwise. Each level is written under the ids the run starts sessions with too (D6: Mythos reads
  // only its id's key).
  const writeSettings = (levels = {}) => {
    const prev = parseOr(read(settings), {});
    fs.writeFileSync(settings, JSON.stringify({
      ...prev,
      hooks: { ...prev.hooks, PreToolUse: [{ matcher: "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|mcp__.*",
        hooks: [guardHook()] }] },
      // A session that set this to true would turn every hook, the guard's included, off.
      disableAllHooks: false,
      // K3 (2026-11-19): a message from another of the user's sessions is not the user's word, and nothing of the chain
      // sends one; a session still gets its own subagents' results with it (CLI 2.1.327). Only managed policy outranks this
      // layer. Written over like the hook: a session could have set "accept" here for the sessions after it.
      crossSessionInbound: "refuse",
      autoContinueAtUsageLimit: true,
      // No one reads a headless session's prose: the user's Explanatory style only added insight blocks.
      outputStyle: prev.outputStyle ?? "default",
      // In this layer, above the user's and the project's files: VS Code's and Desktop's pickers
      // save their pick as the user's default (run 2's #08–#20 ran at high, 2026-10-30), and the
      // user may work on Fable while the chain runs. --effort is kept for max (effort.mjs).
      // Not NODE_OPTIONS or NIGHT_SHIFT_*: a session could plant a --require or point the guard's
      // state folder elsewhere through them (Windows names are case-blind, hence the i).
      env: { ...Object.fromEntries(Object.entries(prev.env && typeof prev.env === "object" ? prev.env : {}).filter(([k]) => !/^(NODE_OPTIONS$|NIGHT_SHIFT_)/i.test(k))), CLAUDE_CODE_SUBAGENT_MODEL: SUB_MODEL },
      modelSettings: nightModelSettings(prev.modelSettings, lowerSettings(repo), { opus: premiumMode ? MAIN_EFFORT.opus : run.effort || MAIN_EFFORT.opus,
        ...(premiumMode ? { [main]: run.effort || MAIN_EFFORT[main] } : {}), ...levels }, runModelIds(run)),
    }, null, 2));
  };
  writeSettings();

  const finish = (reason) => {
    clearInterval(heal);
    log(`chain ends: ${reason}`);
    writePointer(repo, { ...pointer, finished: true, finishedAt: now(), reason });
    awake.kill();
    process.exit(0);
  };

  // Only a process that still is this run's watcher: the pid in watch.pid may belong to another by now.
  const watcherPid = () => {
    const w = Number(read(path.join(state, "watch.pid")));
    if (!w || !alive(w)) return 0;
    // A command line not known is no watcher's.
    const cmd = (platform.commandLine(w) ?? "").toLowerCase();
    return /night-report\.mjs"?\s+watch\b/.test(cmd) && cmd.includes(state.toLowerCase()) ? w : 0;
  };
  // reload: a fresh `run` of the code on disk takes the chain over, started through the scheduled
  // task like the first one, and this process ends. The watcher is replaced too, so no editor or
  // shell has to stay open to bring new code to a running chain. It goes first: a new watcher
  // refuses to start while the old one still holds watch.pid.
  const handOver = () => {
    fs.rmSync(reloadFile, { force: true });
    const w = watcherPid();
    if (w) { try { process.kill(w); } catch {} fs.rmSync(path.join(state, "watch.pid"), { force: true }); }
    try { scheduleRun(run, ["--reloaded"]); } catch (e) {
      log(`reload failed (${String(e.stderr || e.message).trim().split("\n")[0]}); this runner goes on`);
      if (w) startWatcher(false);
      return;
    }
    log(`runner reloads its code${w ? `; watcher ${w} replaced` : ""}`);
    clearInterval(heal);
    awake.kill();
    process.exit(0);
  };

  // A session cut off by a usage limit is resumed in the same conversation once
  // the limit resets; resume.json keeps it across a restarted chain too.
  const resumeFile = path.join(state, "resume.json");
  const pendingResume = () => parseOr(read(resumeFile), null);
  // Ends the chain when the seven-day window's last reading is at or over --weekly-ceiling (weekOver), or when this
  // start's sessions cost --max-usd or more (spentUsd); else returns.
  const ceilingStop = () => {
    const limits = readLimits(state);
    const over = weekOver(limits.week, run.weeklyCeiling);
    if (over) finish(`the seven-day window is at ${pct(over.share)}, at or over the ${pct(run.weeklyCeiling)} weekly ceiling (--weekly-ceiling)${over.resetsAt
      ? ` until it resets ${stamp(over.resetsAt * 1000)}` : ""}; next-prompt.md stays for a start with --state`);
    const spent = spentUsd(limits);
    if (run.maxUsd && spent >= run.maxUsd) finish(`this start's sessions cost ${usd(spent)}, at or over the ${usd(run.maxUsd)} cap (--max-usd); next-prompt.md stays for a start with --state`);
  };
  let session = firstSession(state);
  const lastAllowed = lastSessionOf(run);
  let failures = 0;
  // A run of API or network errors: when it began, how many tries it took, and how many resumes in
  // a row ended without a turn (a conversation that cannot be resumed).
  let streak = 0, streakStart = 0, deadResumes = 0;

  // Fable or Mythos for the sessions that ask for it (MODEL: fable, MODEL: mythos): one weekly allowance,
  // so one <state>/fable.json keeps the chain's sessions of the two, the allowance's last known share,
  // once it ran out until when, and a name the account was found unable to run (effort.mjs, fableGate).
  const fableFile = path.join(state, "fable.json");
  const readFable = () => parseOr(read(fableFile), {});
  const writeFable = (patch) => fs.writeFileSync(fableFile, JSON.stringify({ ...readFable(), ...patch }, null, 2));
  const fableCeiling = run.fableCeiling ?? 0.6, fableSessions = run.fableSessions ?? 2;
  const opusModel = run.opusModel || MAIN_MODEL;
  // The user's rule files, read before every session, a resumed one too. Per file, the last text this runner
  // read and the last line it told the user, so a file that stays broken is reported once, not every session.
  const ruleMemo = { global: { text: "", told: "" }, project: { text: "", told: "" } };
  const readRules = () => {
    for (const [which, file] of Object.entries(ruleFiles(repo))) {
      const m = ruleMemo[which], r = readRuleFile(file);
      let note = "";
      if (r.error) note = `${file} ${r.error}; ${m.text ? "the last text read stays in force" : "this session runs without it"}`;
      else if (r.text) m.text = r.text;
      else if (m.text) { m.text = ""; note = `${file} is gone or empty; its rules no longer apply`; }
      if (note && note !== m.told) log(`rules: ${note}`);
      m.told = note;
    }
    return rulesBlock({ global: ruleMemo.global.text, project: ruleMemo.project.text });
  };
  // The MCP flags, worked out before every session: a listed server's config may change while the chain runs.
  // A listed server no config holds any more is told once; the sessions start without it.
  const mcpTold = new Set();
  const readMcp = () => {
    const { args, missing } = mcpArgs(run.mcp, { repo });
    for (const name of missing.filter((n) => !mcpTold.has(n))) { mcpTold.add(name); log(`mcp: ${JSON.stringify(name)} is in no MCP config any more; sessions start without it`); }
    return args;
  };
  // Why the gate refused a session, after "asked for <Model>, but" or "<Model> is the main model, but".
  // The count is of Fable and Mythos sessions together: they draw on one allowance.
  const whyText = (g) => (g.why === "out" ? `its allowance is used up until ${stamp(g.until)}`
    : g.why === "ceiling" ? `its allowance is at ${pct(g.ratio)}, at or over the ${pct(g.ceiling)} ceiling`
      : g.why === "unavailable" ? "this account cannot run it (found earlier in this chain)"
        : `${g.sessions} session${g.sessions === 1 ? "" : "s"} on its allowance already ran in this chain while the allowance's share is unknown`);

  // In this process, so `wait` (which waits for it to exit) goes on through a limit. A STOP request ends it early.
  // NIGHT_SHIFT_LIMIT_TICK_MS: a shorter look at the clock for night-chain.test.mjs.
  const isStop = (body) => /^STOP\b/i.test(body);
  const waitUntil = async (until) => {
    const tick = Number(process.env.NIGHT_SHIFT_LIMIT_TICK_MS) || 60_000;
    while (Date.now() < until && !fs.existsSync(stopFile)) await new Promise((r) => setTimeout(r, tick));
  };

  log(`chain starts in ${repo}${reloaded ? " (runner reloaded)" : ""}, until ${run.until || "the work is done"}, from session ${session}${lastAllowed ? ` to ${lastAllowed}` : ""}, ${run.model || MAIN_MODEL} at ${run.effort || "xhigh"}, subagents ${SUB_MODEL} (${subEffortText()}), ${premiumMode
    ? `${modelName(main)} as the main model under ${pct(fableCeiling)} of its allowance, else ${opusModel} at ${MAIN_EFFORT.opus}`
    : `Fable or Mythos on request under ${pct(fableCeiling)} of their shared allowance (${fableSessions} sessions while unknown)`}`);
  // The user's language table, loaded once by this runner; one that is gone or does not load reads English (lang/index.mjs).
  const langLoad = await loadLang(langOf(run));
  if (langLoad.error) log(`language table: ${langLoad.error}; what the user reads is in English`);
  while (!lastAllowed || session <= lastAllowed) {
    if (fs.existsSync(stopFile)) finish("stop requested");
    if (fs.existsSync(reloadFile)) handOver(); // returns only when the hand-over failed
    const prompt = read(next).trim();
    // MODEL and EFFORT lines are the runner's: STOP is looked for in what follows them, and the
    // session gets only that. A STOP handover wins over the deadline: the session that wrote it
    // after --until finished the work, and the chain must not end as if work were left.
    const asked = sessionPlan(prompt, run);
    if (isStop(asked.body)) finish(asked.body.split("\n")[0]);
    if (run.deadline && Date.now() >= run.deadline) finish(`reached ${run.until}`);
    if (!prompt) finish("next-prompt.md is empty");
    if (!asked.body.trim()) finish("next-prompt.md holds only MODEL/EFFORT lines");
    // --weekly-ceiling and --max-usd: no new session while the seven-day window's last reading, or what this start's
    // sessions cost, is at or over it. A session a limit or an error cut off still goes on: its work may be uncommitted.
    // next-prompt.md stays for a later start.
    if (!pendingResume()) ceilingStop();
    // T10: at or over FIVE_HOUR_WAIT of the five-hour window, the next session waits for its reset, a resumed one too: cut
    // off again, its work would stay half done. A reset no session may start after (--until), or farther than
    // --max-wait-hours, ends the chain now, as the usage-limit wait below does, with next-prompt.md kept.
    const full = fiveOver(readLimits(state).five);
    if (full) {
      const until = full.resetsAt * 1000;
      const why = `the five-hour window is at ${pct(full.share)}, at or over ${pct(FIVE_HOUR_WAIT)}, and resets ${stamp(until)}`;
      if (run.deadline && until > run.deadline) finish(`${why}, after ${run.until}; next-prompt.md stays for a start with --state`);
      const maxWait = run.maxWaitHours ?? 6;
      if (until - Date.now() > maxWait * 3_600_000) finish(`${why}, more than ${hoursText(maxWait)} h away (--max-wait-hours); next-prompt.md stays for a start with --state`);
      log(`five-hour window at ${pct(full.share)} (no session starts at or over ${pct(FIVE_HOUR_WAIT)}): the next session starts when it resets ${stamp(until)}`);
      // The line the watcher, status and the report read as a usage-limit wait.
      log(`usage limit: waiting until ${new Date(until).toLocaleString("sv-SE")}`);
      await waitUntil(until);
      continue;
    }

    const nn = String(session).padStart(2, "0");
    fs.writeFileSync(path.join(state, "prompts", `${nn}.md`), prompt);
    const before = fs.statSync(next).mtimeMs;
    const resume = pendingResume();
    // A resumed session goes on as it ran (resume.json, or the runs line of a session the last runner
    // left). A new one that asks for Fable or Mythos gets it while the gate allows; a resumed one unless
    // the allowance is used up or the account cannot run that model.
    let plan = resume?.model ? { ...asked, model: resume.model, family: familyOf(resume.model), effort: resume.effort || asked.effort } : asked;
    if (isPremium(plan.family)) {
      // Fable or mythos mode: no count rule, and the stand-in runs at xhigh (or the level its prompt asked), never at max on its own.
      const g = premiumMode ? mainGate(readFable(), { ceiling: fableCeiling })
        : fableGate(readFable(), { ceiling: fableCeiling, maxSessions: fableSessions, family: plan.family });
      if (!g.ok && (!resume || g.why === "out" || g.why === "unavailable")) {
        plan = { ...plan, model: opusModel, family: "opus", effort: premiumMode ? asked.askedEffort || MAIN_EFFORT.opus : "max", downgrade: g, wanted: plan.family, why: whyText(g) };
      }
    }
    log(resume ? `session ${nn} resumes ${resume.sessionId} ${resume.why === "stopped" ? "where the last runner stopped" : resume.why === "error" ? "after the error" : "after the usage limit"}`
      : `session ${nn} starts: ${asked.body.split("\n")[0].slice(0, 120)}`);
    // After the gate: a session it moved to the stand-in must not read as run on the main model.
    if (asked.note && !resume) log(`session ${nn}: ${runsOn(asked.note, plan.model)}`);
    if (plan.downgrade) log(premiumMode ? `session ${nn}: ${modelName(main)} is the main model, but ${plan.why}; it runs on Opus at ${plan.effort}`
      : `session ${nn} asked for ${modelName(plan.wanted)}, but ${plan.why}; it runs on Opus at max`);
    // night-report.mjs and cutOffSession read this line back.
    log(`session ${nn} runs ${modelText(plan)} at ${plan.effort}${plan.effort === "max" && asked.effort === "max" && (!plan.downgrade || premiumMode) ? " (its prompt asks for it)" : ""}`);
    // Fable and Mythos sessions count together: one allowance.
    if (isPremium(plan.family) && !resume && !premiumMode) writeFable({ sessions: (readFable().sessions || 0) + 1 });
    writeSettings({ [plan.family]: plan.effort });
    const result = await runSession(run, session, plan, nn, resume, readRules(), readMcp());
    // U14, before the end line, at which the watcher makes the session's card.
    const lost = fieldsGone({ fields: result.fields, turns: result.mainModels.length > 0, premium: result.mainModels.some((m) => isPremium(familyOf(m))) },
      readLimits(state), { ceiling: run.weeklyCeiling });
    for (const f of lost.gone) log(`session ${nn}: its stream had no ${f}, which earlier sessions' streams had (the CLI may have renamed it); ${FIELD_USE[f]}`);
    if (lost.ceilingBlind) log(`session ${nn}: its stream had no unifiedWindows.seven_day, which --weekly-ceiling reads; until a session's stream has it, the ceiling stops no session`);
    writeLimits(state, lost.memo);
    // T5: a conversation's latest total replaces its earlier one (a resumed session's includes what came before), but
    // never lowers it. F5: a part that ends without a result line (killed at --session-hours, crashed) reports no dollars,
    // and the killed ones are the dearest: it counts what the report prices its transcript at.
    if (result.sessionId) {
      const spent = readLimits(state).usd || {}, cost = result.resulted ? result.cost : estimatedCost(state, nn);
      if (!result.resulted && run.maxUsd) log(cost ? `session ${nn} wrote no result line: --max-usd counts ${usd(cost)} for it, what its transcript is priced at`
        : `session ${nn} wrote no result line, and no other session's dollars price its transcript: --max-usd counts nothing for it`);
      writeLimits(state, { usd: { ...spent, [result.sessionId]: Math.max(Number(spent[result.sessionId]) || 0, cost || 0) } });
    }
    // A session that wrote its handover has done its piece, even when a limit cut off what came after.
    const wrote = fs.statSync(next).mtimeMs > before && read(next).trim() !== prompt;
    // T2: before the end line too, so the session's card has it.
    const size = wrote ? Buffer.byteLength(read(next).trim()) : 0;
    if (size > PROMPT_WARN_BYTES) log(`session ${nn} wrote a next-prompt.md of ${Math.round(size / 1000)} KB (over ${PROMPT_WARN_BYTES / 1000} KB): ` +
      `every call of the next session reads all of it again, about ${Math.round((size * PROMPT_TOKENS_PER_BYTE) / 1000)}k tokens a call`);
    log(`session ${nn} ends: ${result.summary}`);
    const ran = result.mainModels.join(", ") || result.model || "no model reply";
    log(`session ${nn} limits: ${windowSpan(result.windows)}; it ran on ${ran}`);
    const fw = result.windows.latest?.seven_day_overage_included;
    if (fw?.utilization != null) writeFable({ ratio: fw.utilization, ratioResetsAt: fw.resetsAt ?? null, ratioAt: Date.now() });
    const sw = result.windows.latest?.seven_day, fh = result.windows.latest?.five_hour;
    if (typeof sw?.utilization === "number") writeLimits(state, { week: { ratio: sw.utilization, resetsAt: sw.resetsAt ?? null, at: Date.now() } });
    if (typeof fh?.utilization === "number") writeLimits(state, { five: { ratio: fh.utilization, resetsAt: fh.resetsAt ?? null, at: Date.now() } });
    if (isPremium(plan.family) && (result.switchedTo || result.mainModels.some((m) => familyOf(m) !== plan.family)))
      log(`session ${nn} was to run on ${modelName(plan.family)}, but ${result.switchedTo ? `the CLI switched it to ${result.switchedTo}` : `its turns ran on ${ran}`}`);

    // The allowance cut a Fable or Mythos session off: its piece goes on from its prompt on Opus at max
    // (a new conversation, so a session of its own), unless it already wrote the next prompt. Every
    // MODEL: fable or MODEL: mythos prompt runs on Opus at max until the allowance resets (fableGate).
    if (isPremium(plan.family) && result.fableOut) {
      streak = streakStart = deadResumes = 0; // the API answered: a streak must not span this wait
      const until = result.fableResetAt || Date.now() + 24 * 3_600_000;
      const name = modelName(plan.family);
      writeFable({ outUntil: until });
      log(`session ${nn}: ${name}'s allowance is used up (${result.apiError || result.limitType || "refused"}) until ${stamp(until)}${result.fableResetAt ? "" : " (a guess: the CLI gave no reset time)"}; limit record ${JSON.stringify(result.limitInfo)}`);
      fs.rmSync(resumeFile, { force: true });
      if (!wrote) {
        // Fable or mythos mode: no EFFORT line unless the piece's own prompt had one; the main model takes the piece back by itself after the reset.
        const level = premiumMode ? asked.askedEffort || MAIN_EFFORT.opus : "max";
        fs.writeFileSync(next, `${premiumMode ? (asked.askedEffort ? `EFFORT: ${level}\n` : "") : "EFFORT: max\n"}The previous ${name} session (${nn}) was cut off because the ${name} allowance ran out; this piece goes on at Opus ${premiumMode ? level : "max"}. ` +
          `First look at git status and git diff: unfinished work may be there; do not redo finished work.\n\n${plan.body}`);
        log(`session ${nn}'s piece goes on in the next session on Opus at ${level}`);
      }
      session++;
      continue;
    }
    if (result.limited) {
      streak = streakStart = deadResumes = 0; // the API answered: a streak must not span the limit wait
      if (result.limitInfo) log(`session ${nn}: ${result.limitType || "a usage limit"} cut it off; limit record ${JSON.stringify(result.limitInfo)}`);
      // After a handover there is nothing to resume: next-prompt.md carries the chain.
      if (wrote) {
        fs.rmSync(resumeFile, { force: true });
        // A STOP handover ends the chain at the loop's top: no reset to wait for, nor one too far away.
        if (isStop(sessionPlan(read(next).trim(), run).body)) { session++; continue; }
        // Nor one the weekly ceiling would end the chain after: the next session is a new one.
        ceilingStop();
      } else if (result.sessionId) fs.writeFileSync(resumeFile, JSON.stringify({ nn, sessionId: result.sessionId, why: "limit", model: plan.model, effort: plan.effort }));
      // A reset the chain cannot use ends it, with resume.json (or the handover) kept for the next start.
      if (result.resetAt && run.deadline && result.resetAt > run.deadline) finish(`the usage limit resets ${stamp(result.resetAt)}, after ${run.until}`);
      const maxWait = run.maxWaitHours ?? 6;
      if (result.resetAt && result.resetAt - Date.now() > maxWait * 3_600_000) finish(`the usage limit resets ${stamp(result.resetAt)}, more than ${hoursText(maxWait)} h away (--max-wait-hours)`);
      const until = Math.min(result.resetAt || Date.now() + 30 * 60_000, run.deadline || Infinity);
      if (wrote) log(`session ${nn}: the limit cut it off after its handover; session ${String(session + 1).padStart(2, "0")} starts when it resets`);
      log(`usage limit: waiting until ${new Date(until).toLocaleString("sv-SE")}`);
      await waitUntil(until);
      if (wrote) { failures = 0; session++; continue; }
      fs.rmSync(path.join(state, "prompts", `${nn}.md`), { force: true });
      continue;
    }
    // Opus mode: a Fable or Mythos session the account cannot run (refused as not found before any turn,
    // session-outcome.mjs) does not end the chain. Its piece goes on from its prompt on Opus at max, and
    // fable.json remembers the name, so a later ask for it is refused at the gate instead of tried again.
    // It never had a turn: it is not counted as a session on the allowance. In fable or mythos mode the
    // main model that cannot run ends the chain below: only the user can change the mode.
    if (result.modelUnavailable && isPremium(plan.family) && !premiumMode) {
      streak = streakStart = deadResumes = 0;
      const f = readFable(), name = modelName(plan.family);
      writeFable({ unavailable: [...new Set([...(Array.isArray(f.unavailable) ? f.unavailable : []), plan.family])],
        ...(resume ? {} : { sessions: Math.max(0, (f.sessions || 0) - 1) }) });
      log(`session ${nn}: this account cannot run ${name} (${result.errorText}); MODEL: ${plan.family} runs on Opus at max for the rest of this chain`);
      fs.rmSync(resumeFile, { force: true });
      if (!wrote) {
        fs.writeFileSync(next, `EFFORT: max\nThe previous session (${nn}) could not run on ${name}: this account cannot run it (refused as not found before its first turn). ` +
          `This piece goes on at Opus max. ${resume ? "First look at git status and git diff: the conversation it resumed may have left unfinished work; do not redo finished work."
            : "Nothing of it was done in that session."}\n\n${plan.body}`);
        log(`session ${nn}'s piece goes on in the next session on Opus at max`);
      }
      session++;
      continue;
    }
    // The session cannot run (a refused login, a bad request): the next one would fail the same way.
    if (result.fatal) finish(`session ${nn} cannot run: ${result.errorText}`);
    let retryHandover = false;
    if (result.transient && !wrote) {
      streak++;
      streakStart ||= Date.now();
      const maxWait = run.maxWaitHours ?? 6;
      if (Date.now() - streakStart > maxWait * 3_600_000) finish(`session ${nn} kept failing for ${hoursText(maxWait)} h (${result.errorText})`);
      if (result.mainModels.length > 0 && result.sessionId) {
        // It worked before the error: the same conversation goes on, so nothing is done twice.
        fs.writeFileSync(resumeFile, JSON.stringify({ nn, sessionId: result.sessionId, why: "error", model: plan.model, effort: plan.effort }));
        deadResumes = 0;
      } else if (resume) {
        // A resume that dies without a turn gets one more try; then the conversation is given up
        // and the piece goes on from the recovery note below. An API or network error is not a dead
        // conversation: it waits out the outage and resumes the same one.
        const outage = result.apiError != null || result.apiErrorStatus != null || /^API Error\b|\b(?:ENOTFOUND|ECONN\w*|ETIMEDOUT|EAI_AGAIN)\b/.test(result.errorText);
        if (!outage && ++deadResumes >= 2) { fs.rmSync(resumeFile, { force: true }); retryHandover = true; }
      } else if (isPremium(plan.family) && !premiumMode && result.mainModels.length === 0) writeFable({ sessions: Math.max(0, (readFable().sessions || 0) - 1) }); // it never had a turn: the retry is not a second session on the allowance
      if (!retryHandover) {
        const ms = Number(process.env.NIGHT_SHIFT_BACKOFF_MS) || [1, 2, 5, 10, 20, 30][Math.min(streak, 6) - 1] * 60_000;
        const until = Math.min(Date.now() + ms, run.deadline || Infinity);
        log(`session ${nn}: transient error (${result.errorText}); try ${streak}, waiting until ${stamp(until)}`);
        await waitUntil(until);
        fs.rmSync(path.join(state, "prompts", `${nn}.md`), { force: true });
        continue;
      }
    }
    streak = streakStart = deadResumes = 0;
    fs.rmSync(resumeFile, { force: true });
    const after = read(next).trim();
    if (fs.statSync(next).mtimeMs <= before || after === prompt) {
      // A given-up conversation is the resume's fault, not a failed handover: it does not count.
      if (!retryHandover && ++failures >= 2) finish("two sessions in a row ended without writing next-prompt.md");
      // The retry does the same piece, so its MODEL and EFFORT lines stay the first lines.
      const d = promptDirectives(prompt);
      fs.writeFileSync(next, `${directiveLines(d)}The previous night session (${nn}) ended without writing a continuation prompt (${result.summary}). ` +
        `Work out the state from git log, the project's logs and the night report; do not redo finished work.\n\n${d.model || d.effort ? d.body : prompt}`);
      log(`session ${nn} left no continuation prompt; retrying with a recovery note`);
    } else failures = 0;
    session++;
  }
  // The last allowed session may have written a STOP handover: that reason ends the chain, not the cap.
  const last = sessionPlan(read(next).trim(), run).body;
  if (isStop(last)) finish(last.split("\n")[0]);
  finish(run.lastSession ? `reached ${run.maxSessions} sessions (--max-sessions; the last was session ${String(lastAllowed).padStart(2, "0")})` : `reached ${run.maxSessions} sessions`);
  } catch (e) { die(e); }
}

// plan: sessionPlan's { model, family, effort, body }, with downgrade (the gate's answer), wanted (the
// family it asked for) and why (the gate's answer in words) when Fable or Mythos was refused.
// rules: the user's rulesBlock ("" for none), the header's last part (a new session's before its separator, a resumed one's after an empty line).
// mcp: the MCP flags (mcp.mjs, mcpArgs); none for "inherit", --strict-mcp-config alone for no server.
function runSession(run, session, plan, nn, resume, rules = "", mcp = ["--strict-mcp-config"]) {
  const resumeId = resume?.sessionId;
  const { effort, body } = plan;
  const header = resumeId ? [
    ...(resume.why === "stopped" ? [
      `The session was cut off: the runner stopped (the computer may have shut down or restarted); night shift, ${now()}.`,
      `Running subagents and tools died; inspect half-written files with git status and git diff and redo that step if needed.`,
    ] : [resume.why === "error" ? `A connection or API error has passed (night shift, ${now()}).` : `The usage limit has reset (night shift, ${now()}).`]),
    `Go on where you stopped: check the unfinished step with git status and do not redo finished work. End the session with the night-shift skill's three steps`,
    `(commit, night report, ${path.join(run.state, "next-prompt.md")}).`,
    ...(rules ? ["", rules] : []),
  ].join("\n") : [
    `Night shift (night-shift), session ${session}${lastSessionOf(run) ? `/${lastSessionOf(run)}` : ""}, ${now()}.`,
    run.attended
      ? `The user is at hand ${run.until ? `until ${run.until}` : "until the chain ends"} but not watching: no session ever waits for them, and AskUserQuestion stays off.`
      : `The user is away ${run.until ? `until ${run.until}` : "until the chain ends"} and cannot answer any question.`,
    `First invoke the night-shift skill and follow its "Inside a night session" part.`,
    `The user reads ${strings(langOf(run)).name}: write the night report's own text and its Waits-for-you items in that language, and keep the report's fixed words as the skill gives them.`,
    `Mode: ${run.mode}.`,
    ...[modeRules(run.mode), attendedRules(run)].filter(Boolean),
    `Skill folder: ${SKILL_DIR}. Continuation file: ${path.join(run.state, "next-prompt.md")}. Night report: ${run.report}.`,
    // Opus mode: a Fable or Mythos session is for its one piece, and a refused one is told why. Fable or
    // mythos mode: the stand-in is told the main model cannot run it and why.
    ...(isPremium(plan.family) && !isPremium(run.mode) ? [premiumNote(plan.family)] : []),
    ...(plan.downgrade && isPremium(run.mode) ? [fallbackNote(plan.why, { asked: plan.askedEffort, family: run.mode })] : []),
    ...(plan.downgrade && !isPremium(run.mode) ? [deniedNote(plan.wanted, plan.downgrade.why)] : []),
    ...(effort === "max" ? [MAX_NOTE] : []),
    ...(rules ? ["", rules] : []),
    "",
    "---",
    "",
  ].join("\n");
  const args = ["-p", "--output-format", "stream-json", "--verbose",
    "--permission-mode", "auto", "--permission-prompts", "none",
    "--settings", path.join(run.state, "night-settings.json"),
    "--disallowedTools", "AskUserQuestion,EnterPlanMode,ExitPlanMode"];
  args.push("--model", plan.model);
  // Without MCP no server starts at all, with a list only the listed ones (each from its own config), with "inherit"
  // every server of the user's; the guard still decides per server.
  args.push(...mcp);
  if (effort === "max") args.push("--effort", "max");
  // Without --fork-session the conversation keeps its id, so the report still finds its transcript.
  if (resumeId) args.push("--resume", resumeId);
  const out = path.join(run.state, `session-${nn}.jsonl`);
  // A resumed session appends to its stream; only its own part says how it ended (the limit before it is still there).
  const from = resumeId && fs.existsSync(out) ? fs.statSync(out).size : 0;
  const err = path.join(run.state, `session-${nn}.err`);
  // A .mjs "claude" is the stand-in night-chain.test.mjs runs.
  const [cmd, pre] = /\.m?js$/i.test(run.claude) ? [NODE, [run.claude]] : [run.claude, []];
  return new Promise((resolve0) => {
    // A claude that cannot start emits "error" (and no "exit"); a failure may emit both.
    let settled = false;
    const resolve = (r) => { if (!settled) { settled = true; resolve0(r); } };
    const child = spawn(cmd, [...pre, ...args], {
      cwd: run.repo,
      // -p stops background agents 10 min after the main turn ends (run 2's #18 lost its work so);
      // the session timer above still bounds the session.
      // Every Node process of the session hides the windows of what it starts (hide-windows.cjs).
      env: { ...withoutEffortEnv(process.env), PATH: run.path, NIGHT_SHIFT: "1", NIGHT_SHIFT_STATE: run.state, NIGHT_SHIFT_SKILL: SKILL_DIR, NIGHT_SHIFT_REPO: run.repo,
        NIGHT_SHIFT_SESSION: String(session), NIGHT_SHIFT_UNTIL: run.until || "", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
        // A Fable or Mythos session whose allowance runs out would go on, on another model, on its own;
        // this ends it instead (model_substitution_disabled), so the runner hands the piece to Opus.
        // Only for those two: it also turns off the overload fallback and compaction's model choice.
        ...(isPremium(plan.family) ? { CLAUDE_CODE_NO_MODEL_FALLBACK: "1" } : {}),
        // Forward slashes: NODE_OPTIONS reads a backslash inside quotes as an escape.
        NODE_OPTIONS: [`--require "${HIDE.replace(/\\/g, "/")}"`, ...String(process.env.NODE_OPTIONS || "").split(/\s+(?=--)/).filter((o) => o && !o.includes("hide-windows.cjs"))].join(" ") },
      // A resumed session appends to its stream, so the report counts both parts.
      stdio: ["pipe", fs.openSync(out, resumeId ? "a" : "w"), fs.openSync(err, "w")],
      windowsHide: true,
    });
    child.stdin.on("error", () => {});
    child.stdin.end(resumeId ? header + "\n" : header + body + "\n");
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      platform.killTree(child.pid);
    }, run.sessionHours * 3_600_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ...sessionOutcome("", "", null), transient: true, errorText: `claude could not start: ${e.code || e.message}`.slice(0, 160),
        summary: `claude could not start (${e.code || e.message})` });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const outcome = sessionOutcome(fs.readFileSync(out).subarray(from).toString("utf8"), read(err), code, { timedOut, hours: run.sessionHours });
      resolve({ ...outcome, sessionId: outcome.sessionId || resumeId || null });
    });
  });
}

// ---------------------------------------------------------------- status / wait / stop
const statusHead = (ptr, running, T) => [running ? T.cli.statusRunning(ptr.pid, ptr.startedAt)
  : ptr.finished ? T.cli.statusFinished(ptr.finishedAt, ptr.reason) : T.cli.statusScheduled(ptr.scheduledAt), T.cli.statusState(ptr.state)];

// status and wait: the run's language table, before anything reads it; one that is gone or does not load reads English.
async function readLang(code) {
  const r = await loadLang(code);
  if (r.error) console.error(`language table: ${r.error}; what the user reads is in English`);
  return strings(code);
}

async function status(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const ptr = readPointer(repo);
  if (!ptr) return console.log((await readLang(langOf({ repo }))).cli.noRun);
  const running = !ptr.finished && isRunner(ptr.pid);
  const T = await readLang(stateLang(ptr.state, repo));
  console.log(`${[...statusHead(ptr, running, T), ...ruleLines(ruleStatus(repo))].join("\n")}\n`);
  console.log(buildReport(ptr.state, { focus: "all", pid: running ? ptr.pid : 0 }).plain);
}

// wait: for an interactive session that runs it in the background and tells the user when the
// chain is over. No polling: the system waits on the runner's process (platform.mjs, waitExit), and the
// pointer file's changes (fs.watch) bring the next runner of a reload. A usage-limit wait passes
// inside the runner, so it does not wake this. Exit 0 when the chain ended (STOP, two failed
// handovers, stop, a limit the user set), 2 when its runner died without an end line.
const pointerOr = (repo) => { try { return readPointer(repo); } catch { return null; } }; // mid-write

// Resolves with the PowerShell's exit code once the process is gone; 3: the pid now belongs to a
// program that is no runner (Windows reused it), so the runner is gone too (not wait's own exit 3).
// signal: aborting it kills the PowerShell and resolves "woken", so a wait woken by a question leaves none behind.
const exitOf = (pid, signal) => platform.waitExit(pid, { signal, unless: "night-chain\\.mjs" });

// The pointer once ok(pointer) holds, or null after ms; woken by the pointer file's changes.
const pointerChange = (repo, ok, ms) => new Promise((resolve) => {
  let watcher, settled = false;
  const check = () => { const p = pointerOr(repo); return p && ok(p) ? p : null; };
  const done = (p) => { if (settled) return; settled = true; clearTimeout(timer); watcher?.close(); resolve(p); };
  const timer = setTimeout(() => done(check()), ms);
  try { watcher = fs.watch(path.dirname(pointerFile(repo)), () => { const p = check(); if (p) done(p); }); } catch {}
  const p = check();
  if (p) done(p);
});

// The last line chain.log has about runners: an end, a hand-over to a new runner, or a start.
const lastRunnerEvent = (state) => read(path.join(state, "chain.log")).split("\n")
  .map((l) => /\] (chain starts|chain ends: |runner reloads its code|runner moves to a hidden console)/.exec(l)?.[1])
  .filter(Boolean).at(-1) || "";

async function waitChain(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const first = pointerOr(repo) || fail("no night-shift run recorded for this repository");
  const state = path.resolve(first.state);
  const same = (a) => platform.samePath(a, state);
  if (typeof opt.state === "string" && !same(opt.state)) fail(`${path.resolve(opt.state)} is not this repository's last run (${state})`);
  const runner = (not) => (p) => Boolean(p.state && same(p.state) && p.pid && p.pid !== not && alive(p.pid));
  const run = JSON.parse(read(path.join(state, "run.json")) || "{}");
  const T = await readLang(stateLang(state, repo));
  const report = (head) => [...head, "", ...buildReport(state, { pid: 0 }).plain.split("\n\n").slice(0, 2).flatMap((b) => [b, ""])];
  // C3 (B4 item 2, K7): an attended run's questions (questionLines). What a wait reported is kept by its text in
  // <state>/wait.json, saved before it prints, so a waiter started again reports only what is new; one per state folder.
  const markFile = path.join(state, "wait.json");
  const reported = () => parseOr(read(markFile), {}).questions || [];
  const unseen = () => (run.attended ? questionLines(state).filter((q) => !reported().includes(q)) : []);
  // Through a rename, so a second waiter never reads half a file; a mark that cannot be saved only means that a question
  // may be reported again, never that one is lost.
  const keep = (qs) => {
    if (!qs.length) return;
    const tmp = `${markFile}.${process.pid}`;
    try { fs.writeFileSync(tmp, JSON.stringify({ questions: [...reported(), ...qs] }, null, 2)); fs.renameSync(tmp, markFile); } catch {}
  };
  const over = () => {
    const waits = userWaits(state);
    const asked = unseen();
    keep(asked);
    console.log([...report(statusHead(pointerOr(repo) || first, false, T)),
      T.cli.userWaits(waits), "",
      ...(asked.length ? [T.cli.asked, ...asked, ""] : []),
      T.cli.reportLine(path.resolve(repo, run.report || "NIGHT_RUNS.md"), `node "${SELF}" status --repo "${repo}"`)].join("\n"));
  };
  const crashed = (why) => {
    const tail = read(path.join(state, "chain.log")).trim().split("\n").slice(-3).map((l) => `  ${l}`);
    const asked = unseen();
    keep(asked);
    console.log([...report([T.cli.crashed(why), T.cli.statusState(state)]), T.cli.logTail, ...tail, "",
      ...(asked.length ? [T.cli.asked, ...asked, ""] : []),
      T.cli.resumeHint(`node "${SELF}" start --repo "${repo}" --state "${state}"`)].join("\n"));
    process.exitCode = 2;
  };

  // The wake is armed for the whole wait, the runner's start and a hand-over included: a watch on the state folder (the
  // file may not exist yet) and a poll beside it. It kills the PowerShell that waits for the runner and exits 3.
  const stopWaiting = new AbortController();
  if (run.attended && !first.finished) {
    let woken = false;
    // A chain that is down (its end logged, or the pointer's runner gone with no hand-over logged) does not go on:
    // over() or crashed() lists what is left, never an exit 3 that says it goes on.
    const down = () => {
      const event = lastRunnerEvent(state), p = pointerOr(repo);
      return event === "chain ends: " || Boolean(p?.pid && !alive(p.pid) && !event.startsWith("runner "));
    };
    const look = () => {
      if (woken || down()) return;
      const qs = unseen();
      if (!qs.length) return;
      woken = true;
      keep(qs);
      stopWaiting.abort();
      // The exit waits for the text: a write to a pipe may still be pending.
      process.stdout.write(`${[T.cli.asks, ...qs, "", T.cli.answerHint(path.join(state, "inbox.md"), `node "${SELF}" wait --repo "${repo}"`)].join("\n")}\n`, () => process.exit(3));
    };
    try { fs.watch(state, (ev, name) => { if (!name || name === "questions.md") look(); }).unref(); } catch {}
    setInterval(look, 2_000).unref();
    look();
  }

  let pid = first.pid;
  if (!pid && !first.finished) {
    console.log(T.cli.notStartedYet);
    const p = await pointerChange(repo, (x) => x.finished || runner(0)(x), HANDOVER_MS);
    if (!p) return crashed(T.cli.neverStarted(HANDOVER_MS / 60_000));
    pid = p.pid;
  }
  if (pid && alive(pid)) console.log(T.cli.waiting(pid, state));
  for (;;) {
    if (pid && alive(pid)) {
      const code = await exitOf(pid, stopWaiting.signal).catch((e) => fail(`could not wait for runner pid ${pid}: ${e.message}`));
      if (stopWaiting.signal.aborted) return; // woken by a question: its text is going out, and the exit follows it
      if (code !== 3 && alive(pid)) fail(`could not wait for runner pid ${pid} (PowerShell exit ${code})`);
    }
    let next = pointerOr(repo);
    if (!next || !runner(pid)(next)) {
      const event = lastRunnerEvent(state);
      if (event === "chain ends: ") return over();
      const handover = event.startsWith("runner ");
      next = handover
        // A reload starts the next runner before this one exits; it may not have written the pointer yet.
        ? await pointerChange(repo, runner(pid), HANDOVER_MS)
        // stop --now marks the pointer finished before and after it kills the runner (a copy from before 2026-11-19 only after).
        : await pointerChange(repo, (x) => x.finished || runner(pid)(x), 5_000);
      if (!next || !runner(pid)(next)) {
        if (next?.finished) return over();
        return crashed(handover ? T.cli.handoverLost(pid, HANDOVER_MS / 60_000) : T.cli.diedNoEnd(pid));
      }
    }
    console.log(T.cli.handedOver(pid, next.pid));
    pid = next.pid;
  }
}

// The one stop is runs.mjs's, shared with the bot's /stop; these are the CLI's words for what it found.
async function stop(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const { outcome, pid } = await stopRun(repo, { now: Boolean(opt.now) });
  console.log({
    none: "no active run",
    never: "its runner never started; marked finished",
    gone: "the runner was already gone; marked finished",
    unsure: `could not check what pid ${pid} is, so nothing was killed; the chain stops after the session in progress`,
    failed: `could not kill pid ${pid}; the chain stops after the session in progress`,
    now: "stopped now; the session in progress was killed (check git status)",
    after: "the chain stops after the session in progress",
  }[outcome]);
}

function reload(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const ptr = readPointer(repo);
  if (!ptr || ptr.finished || !isRunner(ptr.pid)) return console.log("no active run");
  // A runner from before reload never looks for the request; only its settings can still change.
  if (!ptr.reloadable) return console.log(`this runner predates reload and would ignore it; settings changes go into ${path.join(ptr.state, "night-settings.json")}, which every new session reads`);
  fs.writeFileSync(path.join(ptr.state, "RELOAD-REQUEST"), now());
  console.log("the runner takes up its new code after the session in progress (after a limit wait, if one runs)");
}

// ---------------------------------------------------------------- doctor
// C4: what a start needs, checked without starting anything, one line a check: ok, warn (a start goes on, but look),
// skip (no repository for the project's checks) or FAIL (start would refuse, or the guard would not hold); exit 1 on a
// FAIL. The config is read as start reads it with no flags, so a cap a project's file raises fails here with start's
// message. No network and no model call: the CLI is only looked for, and the guard runs as the hook the runner writes,
// on sample calls. The one thing written is a probe folder in the state folder, or in its nearest folder that exists
// when it does not yet, removed at once (the guard's self-test makes and removes its own in the temp folder).
async function doctor(opt) {
  const rows = [];
  const line = (verdict, what, text) => ({ verdict, line: `  ${verdict.padEnd(4)}  ${what}: ${text}` });
  const row = (verdict, what, text) => rows.push(line(verdict, what, text));
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const same = platform.samePath;

  // The skill: a whole copy, whose files the guard refuses a night session (asked below, once the hook is known).
  const missing = SKILL_FILES.filter((f) => !fs.existsSync(path.join(SKILL_DIR, f)));
  const skillRow = rows.length;
  row(missing.length ? "FAIL" : "ok", "skill", missing.length ? `${SKILL_DIR} lacks ${missing.join(", ")}; copy the whole skill folder again` : SKILL_DIR);
  const major = Number(process.versions.node.split(".")[0]);
  row(major >= NODE_FLOOR ? "ok" : "FAIL", "node", `${process.version}${major >= NODE_FLOOR ? "" : `; night-shift needs Node ${NODE_FLOOR} or later`}`);
  let git = "";
  try { git = execFileSync("git", ["--version"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* not on PATH */ }
  row(git ? "ok" : "FAIL", "git", git || "not found on PATH; the runner runs git in the repository");
  const cli = locateClaude();
  row(cli.found ? "ok" : "FAIL", "claude", cli.found || cli.why);

  // The project's checks need a repository: --repo, else the one this folder is in.
  let repo = null;
  if (opt.repo === true) row("FAIL", "repo", "--repo wants a folder (got no value)");
  else if (typeof opt.repo === "string") { repo = gitRoot(opt.repo, true); row(repo ? "ok" : "FAIL", "repo", repo || `not a git repository: ${path.resolve(opt.repo)}`); }
  else { repo = gitRoot(process.cwd(), true); row(repo ? "ok" : "skip", "repo", repo || `${process.cwd()} is in no git repository; pass --repo <dir> for the project's checks`); }

  // The config files as start reads them: the user's, and the project's over it.
  const own = globalConfigFile();
  const merged = repo ? mergedConfig(repo) : (({ config, errors }) =>
    ({ config, from: Object.fromEntries(Object.keys(config).map((k) => [k, own])), errors: errors.map((e) => `${own}: ${e}`) }))(readGlobalConfig());
  for (const file of [own, ...(repo ? [projectConfigFile(repo)] : [])]) {
    const errors = merged.errors.filter((e) => e.startsWith(`${file}: `)).map((e) => e.slice(file.length + 2));
    row(errors.length ? "FAIL" : "ok", "config", errors.length ? `${file}: ${errors.join("; ")}` : fs.existsSync(file) ? file : `${file} (none; the defaults apply)`);
  }
  const { config: cfg, from } = merged;
  const picked = pickMode({}, cfg, from);
  row(picked.error ? "FAIL" : "ok", "model", picked.error || modelLine({ ...picked, effort: cfg.effort || MAIN_EFFORT[picked.mode],
    fableCeiling: ratioArg(cfg.fableCeiling, 0.6), fableSessions: countArg(cfg.fableSessions, 2) }).replace(/^\s*model:\s*/, ""));
  const rules = fileStatus(Object.values(ruleFiles(repo || process.cwd())).slice(0, repo ? 2 : 1));
  if (!rules.length) row("ok", "rules", "none");
  for (const f of rules) row(f.error ? "FAIL" : "ok", "rules", f.error ? `${f.file} ${f.error}` : `${f.file} (${f.bytes} bytes)`);
  const lang = cfg.lang ?? "en";
  const table = await loadLang(lang);
  row(table.error ? "FAIL" : "ok", "lang", table.error ? `lang ${lang} from ${from.lang}: ${table.error}` : lang === "en" ? "en (built in)" : `${lang} (${langFile(lang)})`);
  let state = "";
  if (repo) {
    const mcp = mcpCheck(cfg, from, repo);
    row(mcp.error ? "FAIL" : "ok", "mcp", mcp.error || (mcp.found ? mcp.found.found.map((f) => f.name).join(", ") || "an empty list: no server starts" : cfg.mcp ?? "none"));
    // The state folder a start without --state would use today: valid, not someone else's, and writable.
    state = defaultState(repo, cfg);
    const wide = stateDirProblem(state, { home: os.homedir(), repo, temp: tempRoot() });
    let foreign = null;
    try { foreign = !wide && foreignState(state) && "is not empty and holds no earlier run; start would refuse it"; } catch (e) { foreign = `cannot be read (${e.code || e.message})`; }
    if (wide) row("FAIL", "state", `${cfg.stateDir ? "stateDir " : ""}${state} ${wide}`);
    else if (fs.existsSync(state) && !fs.statSync(state).isDirectory()) row("FAIL", "state", `${state} is a file`);
    else if (foreign) row("FAIL", "state", `${state} ${foreign}`);
    else {
      let at = state;
      while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
      let error = null;
      try { fs.rmSync(fs.mkdtempSync(path.join(at, ".night-shift-doctor-")), { recursive: true, force: true }); } catch (e) { error = e.code || e.message; }
      row(error ? "FAIL" : "ok", "state", error ? `${state} cannot be written (${error})`
        : `${state}${fs.existsSync(path.join(state, "run.json")) ? " (holds a run; start --state goes on in it)" : ""}; writable`);
    }
  }

  // The guard: its own cases, then the hook command the runner writes, on calls as a session makes them.
  const self = spawnSync(NODE, [GUARD, "--self-test"], { encoding: "utf8", windowsHide: true, timeout: 120_000 });
  row(self.status === 0 ? "ok" : "FAIL", "guard", `self-test: ${String(self.stdout || "").trim().split("\n").at(-1) || (self.error ? self.error.message : `exit ${self.status}`)}`);
  const hook = guardHook(), cmd = `${hook.command} ${hook.args.join(" ")}`;
  const env = { ...withoutEffortEnv(process.env), NIGHT_SHIFT: "1", NIGHT_SHIFT_REPO: repo || "", NIGHT_SHIFT_STATE: state, NIGHT_SHIFT_SKILL: SKILL_DIR };
  const ask = (tool_name, tool_input) => {
    const r = spawnSync(hook.command, hook.args, { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: repo || process.cwd() }),
      encoding: "utf8", windowsHide: true, timeout: hook.timeout * 1000, env });
    let out = null;
    try { out = JSON.parse(r.stdout || "null")?.hookSpecificOutput ?? null; } catch { return { broken: `answered no JSON: ${String(r.stdout).trim().slice(0, 80)}` }; }
    if (out?.permissionDecision === "deny") return { deny: String(out.permissionDecisionReason || "") };
    if (r.error || r.status !== 0) return { broken: r.error ? r.error.message : `exit ${r.status}: ${String(r.stderr || "").trim().split("\n")[0]}` };
    return {};
  };
  const push = ask("Bash", { command: "git push --force origin main" }), plain = ask("Bash", { command: "git status" });
  if (push.broken || plain.broken) row("FAIL", "hook", `${cmd} ${push.broken || plain.broken}`);
  else if (!push.deny || /could not check/.test(push.deny)) row("FAIL", "hook", `${cmd} let "git push --force origin main" through${push.deny ? `: ${push.deny}` : ""}`);
  else if (plain.deny) row("FAIL", "hook", `${cmd} refuses "git status" too: ${plain.deny}`);
  else row("ok", "hook", `${cmd} refuses "git push --force origin main" and lets "git status" through`);
  // The skill's row: the guard names the run's copy as the skill itself (at ~/.claude/skills/night-shift, or wherever the
  // runner's NIGHT_SHIFT_SKILL puts it) unless the repository holds it, where a chain may develop the skill.
  if (!missing.length) {
    const w = ask("Write", { file_path: path.join(SKILL_DIR, "SKILL.md") });
    const rel = repo ? path.relative(real(repo), real(SKILL_DIR)) : "..";
    const inside = rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    rows[skillRow] = w.deny && /the night-shift skill itself/.test(w.deny) ? line("ok", "skill", `${SKILL_DIR}; the guard refuses a night session's writes to it`)
      : inside ? line("warn", "skill", `${SKILL_DIR} is inside the repository ${repo}, where the guard leaves the skill's files writable, so a night session could change this copy's; install it outside the repository`)
        : line("warn", "skill", `${SKILL_DIR}; the guard ${w.broken ? `cannot be asked about it: ${w.broken}` : w.deny ? `refuses a write to it only because ${w.deny}` : "lets a write to it through"}, so a night session could change this copy's files`);
  }
  // A ~/.claude that is a link (a junction to a folder elsewhere): the guard must know what it protects there by the target's path too.
  // Only the folder itself counts as a link: a home reached through a linked parent (macOS's /var) is no link of its own.
  // The guard must refuse the write as Claude's settings: a target outside the writable roots is refused for that alone.
  const home = claudeHome(), target = real(home), settings = path.join(target, "settings.json");
  const dangling = !fs.existsSync(home) && (() => { try { return fs.lstatSync(home).isSymbolicLink(); } catch { return false; } })();
  if (dangling) row("FAIL", "home", `${home} is a link to a folder that does not exist`);
  else if (!fs.existsSync(home)) row("warn", "home", `${home} does not exist yet; Claude Code makes it when it first runs`);
  else if (same(target, path.join(real(path.dirname(home)), path.basename(home)))) row("ok", "home", `${home} (not a link)`);
  else {
    const w = ask("Write", { file_path: settings });
    const known = w.deny && /Claude settings/.test(w.deny);
    row(known ? "ok" : "FAIL", "home", known ? `${home} is a link to ${target}; the guard refuses a write to ${settings} too`
      : `${home} is a link to ${target}, and the guard ${w.broken ? `cannot be asked about ${settings}: ${w.broken}`
        : w.deny ? `does not refuse ${settings} as Claude's settings, only because ${w.deny}` : `lets a write to ${settings} through`}`);
  }

  const failed = rows.filter((r) => r.verdict === "FAIL").length, warned = rows.filter((r) => r.verdict === "warn").length;
  console.log([`night-shift ${VERSION} doctor`, ...rows.map((r) => r.line), failed
    ? `${failed} check${failed === 1 ? "" : "s"} failed: fix each FAIL line before a start`
    : `all checks pass${warned ? ` (${warned} warning${warned === 1 ? "" : "s"})` : ""}`].join("\n"));
  process.exitCode = failed ? 1 : 0;
}

// ---------------------------------------------------------------- init
// C4: a starter .claude/night-shift.json and a rules skeleton for a repository, never over a file that exists (each is
// opened with "wx"), then the next steps. The starter holds only a project's own keys, so nothing in it overrides the
// user's own config.json, and its examples are comments (a key that starts with _). The skeleton is one comment, which
// rules.mjs drops, so an untouched one adds nothing to a session's header.
const INIT_CONFIG = {
  _: "night-shift's settings for this repository. Every key is optional; the night-shift README's \"Per-project settings\" names them all. A key that starts with _ is a comment: drop the _ to turn an example on.",
  report: "NIGHT_RUNS.md",
  mcp: "none",
  _lessons: "docs/agents/NOTES.md",
  _deny: [{ pattern: "\\bmy-app\\.exe\\b", reason: "that is the app running on my desktop" }],
};
// examples/night-shift-rules.md opens with this text and has rules below it (skill-text.test.mjs checks).
export const INIT_RULES = `<!--
This project's rules for night-shift. Every night session on this repository gets the text of this file in its
header, where it wins over the skill's defaults and over your own rules file (~/.claude/night-shift/rules.md).
Text inside these comment marks reaches no session: write your rules below the closing mark, in any language.
The whole file, this comment included, is at most 8 KB. A rule cannot loosen the guard: what it refuses stays refused.

A rule can change:
- which decisions wait for you in the morning (the five tests in the skill's SKILL.md, "What reaches the user");
- how the work is split into pieces, and when a session asks for another model;
- the stops the guard does not enforce: your live desktop, physical tests, messages, work outside the roadmap.

For example:
- The app on my desktop is never started; tests run headless only.
- A change to the save file format waits for me.
-->
`;
function init(opt) {
  if (opt.repo === true) fail("--repo wants a folder (got no value)");
  const repo = repoRoot(typeof opt.repo === "string" ? opt.repo : process.cwd());
  const files = [[projectConfigFile(repo), `${JSON.stringify(INIT_CONFIG, null, 2)}\n`, "starter settings, every key optional"],
    [ruleFiles(repo).project, INIT_RULES, "your rules for this project, none until you write them below its comment"]];
  try { fs.mkdirSync(path.join(repo, ".claude"), { recursive: true }); } catch (e) { fail(`${path.join(repo, ".claude")} cannot be made (${e.code || e.message})`); }
  const lines = [`night-shift init for ${repo}`], wrote = [];
  for (const [file, text, what] of files) {
    try { fs.writeFileSync(file, text, { flag: "wx" }); wrote.push(file); lines.push(`  wrote  ${file}: ${what}`); }
    catch (e) {
      if (e.code !== "EEXIST") { console.log(lines.join("\n")); fail(`${file} cannot be written (${e.code || e.message})`); }
      lines.push(`  kept   ${file}: it exists; init writes over nothing`);
    }
  }
  const steps = [
    ...(wrote.length ? [`Commit ${wrote.length === 2 ? "the two files" : path.relative(repo, wrote[0])}: start wants a committed tree (unless .gitignore keeps them out).`] : []),
    `Check the setup: node "${SELF}" doctor --repo "${repo}"`,
    `Ask a Claude Code chat for a night shift ("run a night shift on the plan in docs/plan.md until it is done"), or start one:\n     node "${SELF}" start --repo "${repo}" --prompt-file <file>   (or --goal "<what to do>" without a plan)`,
  ];
  console.log([...lines, "next:", ...steps.map((s, i) => `  ${i + 1}. ${s}`)].join("\n"));
}

// Only as a command: night-chain.test.mjs imports cutOffSession.
const opt = parseArgs(process.argv.slice(2));
const commands = { start, run: runChain, status, wait: waitChain, stop, reload, doctor, init, "--version": () => console.log(`night-shift ${VERSION}`) };
if (!isMain(import.meta)) { /* imported */ }
else if (commands[opt.cmd]) await commands[opt.cmd](opt);
else {
  const lines = read(SELF).split("\n");
  console.log(lines.slice(1, lines.findIndex((l, i) => i > 0 && /^\/\/ start schedules/.test(l))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
