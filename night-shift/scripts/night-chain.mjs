#!/usr/bin/env node
// night-shift runner: chains fresh headless Claude Code sessions, each the
// equivalent of the user typing /clear and pasting a continuation prompt.
// Sessions hand over through <state>/next-prompt.md; a first line
// "STOP: <reason>" ends the chain.
//
//   node night-chain.mjs start  --repo <dir> (--prompt-file <f> | --prompt <text>) [--until HH:MM]
//                               [--max-sessions <n>] [--session-hours 4] [--model <m>] [--allow-dirty]
//                               [--effort xhigh] [--fable-ceiling 0.6] [--fable-sessions 2]
//                               [--max-wait-hours 6] [--mode opus|fable|mythos] [--lang <code>]
//                               [--state <dir>] [--window]
//   (without --until and --max-sessions the chain goes on until a session writes STOP,
//    two handovers fail in a row, or stop is called; a usage limit pauses it, and the
//    session it cut off is resumed with --resume once the limit resets. start without
//    a prompt also resumes such a session, kept in <state>/resume.json, and a session the
//    last runner left unfinished (a power cut, a crash), whose own uncommitted work it lets
//    through. --state goes on
//    in an earlier run's folder, from its next-prompt.md and session count. Every session runs
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
//    at xhigh (never max) stands in while its allowance is at or over the ceiling or used up)
//   node night-chain.mjs status --repo <dir>
//   node night-chain.mjs wait   --repo <dir> [--state <dir>]  (returns once the chain is over: exit 0
//                               with status's first lines and what waits for the user, 2 if it died;
//                               it follows a reload, and a usage-limit wait does not end it)
//   node night-chain.mjs stop   --repo <dir> [--now]
//   node night-chain.mjs reload --repo <dir>       (a running chain takes up this code after
//                                                   the session in progress, watcher included)
//   node night-chain.mjs run    --state <dir>      (what start schedules)
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

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { buildReport, userWaits, stateLang } from "./night-report.mjs";
import { strings, langOf, loadLang } from "./lang/index.mjs";
import { mergedConfig, isLangCode, MODES, stateDirProblem, tempRoot, isMain } from "./config.mjs";
import { sessionOutcome, windowSpan } from "./session-outcome.mjs";
import { ruleFiles, readRuleFile, rulesBlock } from "./rules.mjs";
import { MAIN_MODEL, SUB_MODEL, MAIN_EFFORT, subEffortText, MAX_NOTE, nightModelSettings, sessionPlan, promptDirectives,
  directiveLines, fableGate, mainGate, fallbackNote, resolveMode, familyOf, isPremium, modelName, runModelIds, premiumNote,
  deniedNote } from "./effort.mjs";

const SELF = fileURLToPath(import.meta.url);
const SKILL_DIR = path.dirname(path.dirname(SELF)); // the folder that holds SKILL.md
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
const lowerSettings = (repo) => [path.join(os.homedir(), ".claude", "settings.json"), path.join(repo, ".claude", "settings.json"),
  path.join(repo, ".claude", "settings.local.json")].map((f) => parseOr(read(f), {}));
// CLAUDE_CODE_EFFORT_LEVEL would set every level, the subagents' included.
const withoutEffortEnv = (env) => { const { CLAUDE_CODE_EFFORT_LEVEL, ...rest } = env; return rest; };
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
// "Opus", or "Opus (claude-opus-5-5)" for a full model id: night-report.mjs reads the runs line back.
const modelText = (p) => `${cap(p.family)}${p.model !== p.family ? ` (${p.model})` : ""}`;
const stamp = (ms) => new Date(ms).toLocaleString("sv-SE").slice(0, 16);
// A handover prompt over this many bytes is flagged: the next session reads all of it on every call.
// Of 127 prompts of 2026-10-30 … 11-15 the median was 15 KB; only the 10-30 run's prompts, which
// grew by accumulation to 98 KB, and four of 11-11 went over 30 KB.
export const PROMPT_WARN_BYTES = 30_000;
// A fraction (0.6) or a percentage (60).
const ratioArg = (v, d) => { const n = Number(v); return v == null || v === true || Number.isNaN(n) ? d : n > 1 ? n / 100 : n; };
const countArg = (v, d) => { const n = Number(v); return v == null || v === true || !Number.isFinite(n) || n < 0 ? d : Math.floor(n); };
const pct = (u) => `${Math.round(u * 100)}%`;
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

function repoRoot(dir) {
  try {
    return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", windowsHide: true }).trim());
  } catch { fail(`not a git repository: ${dir}`); }
}
const projectConfig = (repo) => {
  const { config, from, errors } = mergedConfig(repo);
  if (errors.length) fail(errors.join("; "));
  return { config, from };
};
// start and status: what each rule file is to the user, in order (a file with no text is left out). A file
// that cannot be used is named, not dropped, so the user is never left thinking rules apply that do not.
const ruleStatus = (repo) => Object.values(ruleFiles(repo)).flatMap((file) => {
  const r = readRuleFile(file);
  return r.error ? [{ file, error: r.error }] : r.text ? [{ file, bytes: fs.statSync(file).size }] : [];
});
const ruleLines = (found) => (found.length ? found : [{ none: true }])
  .map((f) => `  rules:  ${f.none ? "none" : f.error ? `${f.file} ${f.error}` : `${f.file} (${f.bytes} bytes)`}`);
const slug = (repo) => `${path.basename(repo)}-${crypto.createHash("sha1").update(repo.toLowerCase()).digest("hex").slice(0, 8)}`;
const pointerFile = (repo) => path.join(os.homedir(), ".claude", "night-shift", "runs", `${slug(repo)}.json`);
const readPointer = (repo) => { const t = read(pointerFile(repo)); return t ? JSON.parse(t) : null; };
const writePointer = (repo, data) => {
  fs.mkdirSync(path.dirname(pointerFile(repo)), { recursive: true });
  fs.writeFileSync(pointerFile(repo), JSON.stringify(data, null, 2));
};

function findClaude() {
  const candidates = [
    process.env.NIGHT_SHIFT_CLAUDE,
    path.join(path.dirname(NODE), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
  ].filter(Boolean);
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) fail(`claude.exe not found; set NIGHT_SHIFT_CLAUDE (tried ${candidates.join(", ")})`);
  return found;
}

function deadline(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) fail(`--until wants HH:MM, got ${hhmm}`);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

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

// A PowerShell single-quoted string. PowerShell ends one at ' and at the typographic quotes
// ‘ ’ ‚ ‛ alike, so each is doubled: a state folder or a repository named with one must stay text.
export const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;

// The command line of a process: "" when it is gone, null when it could not be asked.
const commandLine = (pid) => {
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true });
  } catch { return null; }
};

// A live pid may belong to another program once the runner died without an end line (Windows
// reuses numbers): a runner is a live process whose command line names this file. Not knowing counts as one.
const isRunner = (pid) => { if (!alive(pid)) return false; const line = commandLine(pid); return line === null || /night-chain\.mjs/i.test(line); };

// Starts `run` for this state through the project's scheduled task and returns the task's name.
// No trigger, so only start (or a runner handing over) runs it and a finished chain never comes
// back on its own; no time limit (schtasks' default stops a task after 72 h) and no battery stop,
// because the chain has no end time. Parallel, so a runner handing over can start the next one.
// NIGHT_SHIFT_LAUNCH=direct spawns it instead, and =fail fails (night-chain.test.mjs).
function scheduleRun(run, extra = []) {
  const args = ["run", "--state", run.state, ...(run.window ? [] : ["--headless"]), ...extra];
  if (process.env.NIGHT_SHIFT_LAUNCH === "fail") throw new Error("launch refused (test)");
  if (process.env.NIGHT_SHIFT_LAUNCH === "direct") {
    spawn(NODE, [SELF, ...args], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return "direct";
  }
  const launcher = path.join(run.state, "launch.cmd");
  // The folder's name goes into a cmd line: only what cmd reads as plain text.
  fs.writeFileSync(launcher, `@echo off\r\ntitle night-shift ${path.basename(run.repo).replace(/[^\w .-]/g, "_")}\r\n"${NODE}" "${SELF}" %*\r\n`);
  const argLine = args.map((a) => `"${a}"`).join(" ");
  // A visible console runs launch.cmd; a hidden one is conhost --headless, which no default
  // terminal (Windows Terminal) takes over, so every child shares that hidden console too.
  const [exe, argv] = run.window ? [launcher, argLine]
    : [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "conhost.exe"), `--headless "${NODE}" "${SELF}" ${argLine}`];
  const task = `night-shift-${slug(run.repo)}`;
  const q = psQuote;
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; " +
    `$a = New-ScheduledTaskAction -Execute ${q(exe)} -Argument ${q(argv)}; ` +
    "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances Parallel; " +
    `Register-ScheduledTask -TaskName ${q(task)} -Action $a -Settings $s -Force | Out-Null; Start-ScheduledTask -TaskName ${q(task)}`],
  { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  return task;
}

// ---------------------------------------------------------------- start
const HANDOVER_MS = 180_000;
async function start(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const ptr = readPointer(repo);
  if (ptr && !ptr.finished) {
    if (isRunner(ptr.pid)) fail(`a run is already active (pid ${ptr.pid}, state ${ptr.state}); reload gives it new runner code`);
    // pid 0: scheduled, not yet picked up. Only a recent one still counts; an older one never came up.
    const age = Date.now() - Date.parse(ptr.scheduledAt);
    if (!ptr.pid && age < HANDOVER_MS) fail(`a run was scheduled ${Math.round(age / 1000)} s ago and its runner has not come up yet; wait, or run stop`);
  }

  const { config: cfg, from } = projectConfig(repo);
  // Unlike the other numbers, a wrong one here is not quietly replaced: a wait of 1 h or 6 h is not what was typed.
  const waitArg = opt["max-wait-hours"];
  if (waitArg !== undefined && !(typeof waitArg === "string" && Number.isFinite(Number(waitArg)) && Number(waitArg) > 0)) {
    fail(`--max-wait-hours must be a positive number of hours (got ${waitArg === true ? "no value" : waitArg})`);
  }
  // A language is never guessed from "PT" or "pt-BR": a night in English that was asked for in another language is worse than a refusal.
  if (opt.lang !== undefined && !isLangCode(opt.lang)) fail(`--lang must be a language code in lowercase, such as en or pt-br (got ${opt.lang === true ? "no value" : opt.lang})`);
  if (opt.mode !== undefined && !MODES.includes(opt.mode)) fail(`--mode must be one of ${MODES.join(", ")} (got ${opt.mode === true ? "no value" : opt.mode})`);
  const picked = resolveMode({ mode: opt.mode ?? cfg.mode, model: typeof opt.model === "string" ? opt.model : cfg.model });
  if (picked.error) {
    // mode and model may come from different layers (or a flag); the user has to know which one to change.
    const src = [["mode", opt.mode !== undefined ? "--mode" : from.mode], ["model", typeof opt.model === "string" ? "--model" : from.model]]
      .filter(([, s]) => s).map(([k, s]) => `${k} from ${s}`);
    fail(src.length ? `${picked.error} (${src.join(", ")})` : picked.error);
  }
  // The user's language table (lang/index.mjs) must load now, for the same reason.
  const lang = opt.lang ?? cfg.lang ?? "en";
  const table = await loadLang(lang);
  if (table.error) fail(`${opt.lang !== undefined ? `--lang ${lang}` : `lang ${lang} from ${from.lang}`}: ${table.error}`);
  // A file the runner would have to leave out is refused here, while the user is at the keyboard.
  const badRules = ruleStatus(repo).filter((f) => f.error);
  if (badRules.length) fail(badRules.map((f) => `${f.file} ${f.error}`).join("; "));
  let state = path.resolve(typeof opt.state === "string" ? opt.state
    : (cfg.stateDir || path.join(tempRoot(), `night-shift-${path.basename(repo)}-{date}`)).replace("{date}", today()));
  // The runner writes here and a session reads its instructions from here: not a folder of the user's own.
  const wide = stateDirProblem(state, { home: os.homedir(), repo, temp: tempRoot() });
  if (wide) fail(`${typeof opt.state === "string" ? "--state" : "stateDir"} ${state} ${wide}`);
  if (typeof opt.state === "string" && !fs.existsSync(path.join(state, "run.json"))) fail(`--state ${state} holds no earlier run`);
  // A start that failed before run.json (no prompt, a dirty tree) leaves only what start itself made; that is no one else's folder.
  const foreign = !fs.existsSync(path.join(state, "run.json")) && fs.existsSync(state) && fs.readdirSync(state).some((f) => !["prompts", "next-prompt.md"].includes(f));
  if (foreign) fail(`${state} is not empty and holds no earlier run; pick another state folder`);
  fs.mkdirSync(path.join(state, "prompts"), { recursive: true });
  // In long form, so the guard, which refuses 8.3 short names, accepts the handover's path whatever way --state or %TEMP% spelled it.
  state = fs.realpathSync.native(state);
  const next = path.join(state, "next-prompt.md");
  // A new prompt starts fresh; without one, a session a usage limit cut off (resume.json) goes on.
  if (opt["prompt-file"]) fs.copyFileSync(opt["prompt-file"], next);
  else if (typeof opt.prompt === "string") fs.writeFileSync(next, opt.prompt);
  else if (!read(next).trim()) fail("no prompt: pass --prompt-file or --prompt");
  const resumeFile = path.join(state, "resume.json");
  const fresh = Boolean(opt["prompt-file"]) || typeof opt.prompt === "string";
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
  const run = {
    repo,
    state,
    until: opt.until || null,
    deadline: opt.until ? deadline(opt.until) : null,
    maxSessions: opt["max-sessions"] ? Number(opt["max-sessions"]) : null,
    sessionHours: Number(opt["session-hours"] || 4),
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
    // "none", "inherit" or the list of servers the guard lets through (the guard reads the same file).
    mcp: cfg.mcp ?? "none",
    lang,
    claude: findClaude(),
    report: cfg.report || "NIGHT_RUNS.md",
    path: sessionPath,
    window: Boolean(opt.window),
    startedAt: now(),
  };
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify(run, null, 2));
  // Each chain counts its own Fable sessions and measures the allowance anew; one used up stays so.
  const fableFile = path.join(state, "fable.json");
  const fable = parseOr(read(fableFile), {});
  fs.writeFileSync(fableFile, JSON.stringify(fable.outUntil > Date.now() ? { outUntil: fable.outUntil } : {}, null, 2));
  let task;
  try { task = scheduleRun(run); } catch (e) { fail(`Task Scheduler: ${String(e.stderr || e.message).trim().split("\n")[0]}`); }
  writePointer(repo, { pid: 0, state, task, scheduledAt: now(), finished: false });
  console.log(`night-shift started for ${repo}`);
  if (cut) console.log(`  resumes session ${cut.nn} (${cut.sessionId}), which the last runner left unfinished`);
  console.log(`  state:  ${state}`);
  console.log(modelLine(run));
  console.log(`  until:  ${run.until ? `${run.until} (no new session after that)` : "the work is done (STOP)"}${run.maxSessions ? `, at most ${run.maxSessions} sessions` : ""}`);
  for (const l of ruleLines(ruleStatus(repo))) console.log(l);
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
  // A runner handing over may mark the pointer finished after this one wrote it; put it back.
  const heal = setInterval(() => {
    const p = readPointer(repo);
    if (!p || p.pid !== process.pid || p.finished) writePointer(repo, pointer);
  }, 30_000);

  // Keep Windows awake while this process lives; the helper exits with it.
  const awake = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `$k=Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace NightShift -PassThru; ` +
    `[void]$k::SetThreadExecutionState([uint32]2147483649); while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60 }`],
  { stdio: "ignore", windowsHide: true });
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
  // the guard, the limit wait, the subagent model and the efforts are written over.
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
        hooks: [{ type: "command", command: NODE, args: [GUARD], timeout: 15, onFailure: "block" }] }] },
      // A session that set this to true would turn every hook, the guard's included, off.
      disableAllHooks: false,
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
    try {
      const cmd = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${w}").CommandLine`], { encoding: "utf8", windowsHide: true }).toLowerCase();
      return /night-report\.mjs"?\s+watch\b/.test(cmd) && cmd.includes(state.toLowerCase()) ? w : 0;
    } catch { return 0; }
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
  let session = Number(pendingResume()?.nn) ||
    fs.readdirSync(path.join(state, "prompts")).filter((f) => /^\d+\.md$/.test(f)).length + 1;
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

  log(`chain starts in ${repo}${reloaded ? " (runner reloaded)" : ""}, until ${run.until || "the work is done"}, from session ${session}${run.maxSessions ? ` to ${run.maxSessions}` : ""}, ${run.model || MAIN_MODEL} at ${run.effort || "xhigh"}, subagents ${SUB_MODEL} (${subEffortText()}), ${premiumMode
    ? `${modelName(main)} as the main model under ${pct(fableCeiling)} of its allowance, else ${opusModel} at ${MAIN_EFFORT.opus}`
    : `Fable or Mythos on request under ${pct(fableCeiling)} of their shared allowance (${fableSessions} sessions while unknown)`}`);
  // The user's language table, loaded once by this runner; one that is gone or does not load reads English (lang/index.mjs).
  const langLoad = await loadLang(langOf(run));
  if (langLoad.error) log(`language table: ${langLoad.error}; what the user reads is in English`);
  while (!run.maxSessions || session <= run.maxSessions) {
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
    if (asked.note && !resume) log(`session ${nn}: ${asked.note}`);
    if (plan.downgrade) log(premiumMode ? `session ${nn}: ${modelName(main)} is the main model, but ${plan.why}; it runs on Opus at ${plan.effort}`
      : `session ${nn} asked for ${modelName(plan.wanted)}, but ${plan.why}; it runs on Opus at max`);
    // night-report.mjs and cutOffSession read this line back.
    log(`session ${nn} runs ${modelText(plan)} at ${plan.effort}${plan.effort === "max" && asked.effort === "max" && (!plan.downgrade || premiumMode) ? " (its prompt asks for it)" : ""}`);
    // Fable and Mythos sessions count together: one allowance.
    if (isPremium(plan.family) && !resume && !premiumMode) writeFable({ sessions: (readFable().sessions || 0) + 1 });
    writeSettings({ [plan.family]: plan.effort });
    const result = await runSession(run, session, plan, nn, resume, readRules());
    log(`session ${nn} ends: ${result.summary}`);
    // A session that wrote its handover has done its piece, even when a limit cut off what came after.
    const wrote = fs.statSync(next).mtimeMs > before && read(next).trim() !== prompt;
    const ran = result.mainModels.join(", ") || result.model || "no model reply";
    log(`session ${nn} limits: ${windowSpan(result.windows)}; it ran on ${ran}`);
    const fw = result.windows.last?.seven_day_overage_included;
    if (fw?.utilization != null) writeFable({ ratio: fw.utilization, ratioResetsAt: fw.resetsAt ?? null, ratioAt: Date.now() });
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
    } else {
      failures = 0;
      const size = Buffer.byteLength(after);
      if (size > PROMPT_WARN_BYTES) log(`session ${nn} wrote a next-prompt.md of ${Math.round(size / 1000)} KB (over ${PROMPT_WARN_BYTES / 1000} KB): the next session reads all of it on every call`);
    }
    session++;
  }
  // The last allowed session may have written a STOP handover: that reason ends the chain, not the cap.
  const last = sessionPlan(read(next).trim(), run).body;
  if (isStop(last)) finish(last.split("\n")[0]);
  finish(`reached ${run.maxSessions} sessions`);
  } catch (e) { die(e); }
}

// plan: sessionPlan's { model, family, effort, body }, with downgrade (the gate's answer), wanted (the
// family it asked for) and why (the gate's answer in words) when Fable or Mythos was refused.
// rules: the user's rulesBlock ("" for none), the header's last part (a new session's before its separator, a resumed one's after an empty line).
function runSession(run, session, plan, nn, resume, rules = "") {
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
    `Night shift (night-shift), session ${session}${run.maxSessions ? `/${run.maxSessions}` : ""}, ${now()}.`,
    `The user is away ${run.until ? `until ${run.until}` : "until the chain ends"} and cannot answer any question.`,
    `First invoke the night-shift skill and follow its "Inside a night session" part.`,
    `The user reads ${strings(langOf(run)).name}: write the night report's own text and its Waits-for-you items in that language, and keep the report's fixed words as the skill gives them.`,
    `Mode: ${run.mode}.`,
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
  // Without MCP no server starts at all; with "inherit" or a list the user's servers load and the guard decides per server.
  if ((run.mcp ?? "none") === "none") args.push("--strict-mcp-config");
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
      try { execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true }); } catch {}
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
// chain is over. No polling: a hidden PowerShell waits on the runner's process handle, and the
// pointer file's changes (fs.watch) bring the next runner of a reload. A usage-limit wait passes
// inside the runner, so it does not wake this. Exit 0 when the chain ended (STOP, two failed
// handovers, stop, a limit the user set), 2 when its runner died without an end line.
const pointerOr = (repo) => { try { return readPointer(repo); } catch { return null; } }; // mid-write

// Resolves with the PowerShell's exit code once the process is gone; 3: the pid now belongs to a
// program that is no runner (Windows reused it), so the runner is gone too.
const exitOf = (pid) => new Promise((resolve, reject) => {
  const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 0 }; ` +
    `$c = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine; ` +
    "if ($c -and $c -notmatch 'night-chain\\.mjs') { exit 3 }; $p.WaitForExit(); exit 0"],
  { stdio: "ignore", windowsHide: true });
  ps.on("error", reject);
  ps.on("exit", resolve);
});

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
  const same = (a) => path.resolve(a).toLowerCase() === state.toLowerCase();
  if (typeof opt.state === "string" && !same(opt.state)) fail(`${path.resolve(opt.state)} is not this repository's last run (${state})`);
  const runner = (not) => (p) => Boolean(p.state && same(p.state) && p.pid && p.pid !== not && alive(p.pid));
  const run = JSON.parse(read(path.join(state, "run.json")) || "{}");
  const T = await readLang(stateLang(state, repo));
  const report = (head) => [...head, "", ...buildReport(state, { pid: 0 }).plain.split("\n\n").slice(0, 2).flatMap((b) => [b, ""])];
  const over = () => {
    const waits = userWaits(state);
    console.log([...report(statusHead(pointerOr(repo) || first, false, T)),
      T.cli.userWaits(waits), "",
      T.cli.reportLine(path.resolve(repo, run.report || "NIGHT_RUNS.md"), `node "${SELF}" status --repo "${repo}"`)].join("\n"));
  };
  const crashed = (why) => {
    const tail = read(path.join(state, "chain.log")).trim().split("\n").slice(-3).map((l) => `  ${l}`);
    console.log([...report([T.cli.crashed(why), T.cli.statusState(state)]), T.cli.logTail, ...tail, "",
      T.cli.resumeHint(`node "${SELF}" start --repo "${repo}" --state "${state}"`)].join("\n"));
    process.exitCode = 2;
  };

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
      const code = await exitOf(pid).catch((e) => fail(`could not wait for runner pid ${pid}: ${e.message}`));
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
        // stop --now kills the runner first and marks the pointer finished after.
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

function stop(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const ptr = readPointer(repo);
  if (!ptr || ptr.finished) return console.log("no active run");
  fs.writeFileSync(path.join(ptr.state, "STOP-REQUEST"), now());
  if (!isRunner(ptr.pid)) {
    const reason = ptr.pid ? "its runner was already gone" : "its runner never started";
    writePointer(repo, { ...ptr, finished: true, finishedAt: now(), reason });
    return console.log(`${ptr.pid ? "the runner was already gone" : reason}; marked finished`);
  }
  if (opt.now) {
    // A runner that died without an end line leaves its pid in the pointer, and Windows gives
    // the number to another program: only a process that still is a runner is killed.
    const line = commandLine(ptr.pid);
    // Not knowing is no reason to kill, nor to call a live chain finished: STOP-REQUEST still ends it.
    if (line === null) return console.log(`could not check what pid ${ptr.pid} is, so nothing was killed; the chain stops after the session in progress`);
    try { execFileSync("taskkill", ["/T", "/F", "/PID", String(ptr.pid)], { stdio: "ignore", windowsHide: true }); } catch {}
    writePointer(repo, { ...ptr, finished: true, finishedAt: now(), reason: "stopped now by the user" });
    console.log("stopped now; the session in progress was killed (check git status)");
  } else console.log("the chain stops after the session in progress");
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

// Only as a command: night-chain.test.mjs imports cutOffSession.
const opt = parseArgs(process.argv.slice(2));
const commands = { start, run: runChain, status, wait: waitChain, stop, reload };
if (!isMain(import.meta)) { /* imported */ }
else if (commands[opt.cmd]) await commands[opt.cmd](opt);
else {
  const lines = read(SELF).split("\n");
  console.log(lines.slice(1, lines.findIndex((l, i) => i > 0 && /^\/\/ start schedules/.test(l))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
