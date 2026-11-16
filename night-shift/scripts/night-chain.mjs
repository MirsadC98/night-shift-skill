#!/usr/bin/env node
// night-shift runner: chains fresh headless Claude Code sessions, each the
// equivalent of the user typing /clear and pasting a continuation prompt.
// Sessions hand over through <state>/next-prompt.md; a first line
// "STOP: <reason>" ends the chain.
//
//   node night-chain.mjs start  --repo <dir> (--prompt-file <f> | --prompt <text>) [--until HH:MM]
//                               [--max-sessions <n>] [--session-hours 4] [--model <m>] [--allow-dirty]
//                               [--effort xhigh] [--fable-ceiling 0.6] [--fable-sessions 2]
//                               [--max-wait-hours 6]
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
//    opens with "MODEL: fable" runs on Fable at high (or its EFFORT) while Fable's weekly allowance is
//    under --fable-ceiling ("fableCeiling"; while its ratio is unknown, at most --fable-sessions
//    "fableSessions" in a chain), else on Opus at max; a Fable session its allowance cuts off runs
//    again from its prompt on Opus at max, and so does every MODEL: fable prompt until the allowance resets)
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
import { buildReport, userWaits } from "./night-report.mjs";
import { readProjectConfig, stateDirProblem } from "./config.mjs";
import { sessionOutcome, windowSpan } from "./session-outcome.mjs";
import { MAIN_MODEL, SUB_MODEL, MAIN_EFFORT, subEffortText, MAX_NOTE, FABLE_NOTE, nightModelSettings, sessionPlan,
  promptDirectives, directiveLines, fableGate, familyOf } from "./effort.mjs";

const SELF = fileURLToPath(import.meta.url);
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

function repoRoot(dir) {
  try {
    return path.resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", windowsHide: true }).trim());
  } catch { fail(`not a git repository: ${dir}`); }
}
const projectConfig = (repo) => {
  const { config, errors } = readProjectConfig(repo);
  if (errors.length) fail(`${path.join(repo, ".claude", "night-shift.json")}: ${errors.join("; ")}`);
  return config;
};
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
function start(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const ptr = readPointer(repo);
  if (ptr && !ptr.finished) {
    if (isRunner(ptr.pid)) fail(`a run is already active (pid ${ptr.pid}, state ${ptr.state}); reload gives it new runner code`);
    // pid 0: scheduled, not yet picked up. Only a recent one still counts; an older one never came up.
    const age = Date.now() - Date.parse(ptr.scheduledAt);
    if (!ptr.pid && age < HANDOVER_MS) fail(`a run was scheduled ${Math.round(age / 1000)} s ago and its runner has not come up yet; wait, or run stop`);
  }

  const cfg = projectConfig(repo);
  const state = path.resolve(typeof opt.state === "string" ? opt.state
    : (cfg.stateDir || path.join(os.tmpdir(), `night-shift-${path.basename(repo)}-{date}`)).replace("{date}", today()));
  // The runner writes here and a session reads its instructions from here: not a folder of the user's own.
  const wide = stateDirProblem(state, { home: os.homedir(), repo, temp: os.tmpdir() });
  if (wide) fail(`${typeof opt.state === "string" ? "--state" : "stateDir"} ${state} ${wide}`);
  if (typeof opt.state === "string" && !fs.existsSync(path.join(state, "run.json"))) fail(`--state ${state} holds no earlier run`);
  // A start that failed before run.json (no prompt, a dirty tree) leaves only what start itself made; that is no one else's folder.
  const foreign = !fs.existsSync(path.join(state, "run.json")) && fs.existsSync(state) && fs.readdirSync(state).some((f) => !["prompts", "next-prompt.md"].includes(f));
  if (foreign) fail(`${state} is not empty and holds no earlier run; pick another state folder`);
  fs.mkdirSync(path.join(state, "prompts"), { recursive: true });
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
    model: typeof opt.model === "string" ? opt.model : cfg.model || MAIN_MODEL,
    effort: typeof opt.effort === "string" ? opt.effort : cfg.effort || "xhigh",
    // MODEL: fable prompts: Fable while its weekly allowance is under this share, and at most this
    // many Fable sessions while the share is unknown (effort.mjs, fableGate).
    fableCeiling: ratioArg(opt["fable-ceiling"] ?? cfg.fableCeiling, 0.6),
    fableSessions: countArg(opt["fable-sessions"] ?? cfg.fableSessions, 2),
    // The longest a usage limit's reset may be away for the chain to wait for it; farther ends the chain.
    maxWaitHours: (() => { const n = Number(opt["max-wait-hours"] ?? cfg.maxWaitHours); return Number.isFinite(n) && n > 0 ? n : 6; })(),
    // "none", "inherit" or the list of servers the guard lets through (the guard reads the same file).
    mcp: cfg.mcp ?? "none",
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
  console.log(`  until:  ${run.until ? `${run.until} (no new session after that)` : "the work is done (STOP)"}${run.maxSessions ? `, at most ${run.maxSessions} sessions` : ""}`);
  console.log(`  status: node "${SELF}" status --repo "${repo}"`);
  console.log(`  stop:   node "${SELF}" stop --repo "${repo}" [--now]`);
}

// ---------------------------------------------------------------- run
async function runChain(opt) {
  const state = path.resolve(opt.state || fail("run needs --state"));
  const run = JSON.parse(read(path.join(state, "run.json")) || fail(`no run.json in ${state}`));
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
  // levels: this session's { [family]: level }; Opus keeps the run's level and Fable its own otherwise.
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
      modelSettings: nightModelSettings(prev.modelSettings, lowerSettings(repo), { opus: run.effort || "xhigh", fable: MAIN_EFFORT.fable, ...levels }),
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

  // Fable for the sessions that ask for it (MODEL: fable): <state>/fable.json keeps the chain's Fable
  // sessions, the allowance's last known share and, once it ran out, until when (effort.mjs, fableGate).
  const fableFile = path.join(state, "fable.json");
  const readFable = () => parseOr(read(fableFile), {});
  const writeFable = (patch) => fs.writeFileSync(fableFile, JSON.stringify({ ...readFable(), ...patch }, null, 2));
  const fableCeiling = run.fableCeiling ?? 0.6, fableSessions = run.fableSessions ?? 2;
  const opusModel = run.model && familyOf(run.model) === "opus" ? run.model : MAIN_MODEL;
  const whyText = (g) => (g.why === "out" ? `its allowance is used up until ${stamp(g.until)}`
    : g.why === "ceiling" ? `its allowance is at ${pct(g.ratio)}, at or over the ${pct(g.ceiling)} ceiling`
      : `${g.sessions} Fable sessions already ran in this chain while its allowance's share is unknown`);

  // In this process, so `wait` (which waits for it to exit) goes on through a limit. A STOP request ends it early.
  // NIGHT_SHIFT_LIMIT_TICK_MS: a shorter look at the clock for night-chain.test.mjs.
  const isStop = (body) => /^STOP\b/i.test(body);
  const waitUntil = async (until) => {
    const tick = Number(process.env.NIGHT_SHIFT_LIMIT_TICK_MS) || 60_000;
    while (Date.now() < until && !fs.existsSync(stopFile)) await new Promise((r) => setTimeout(r, tick));
  };

  log(`chain starts in ${repo}${reloaded ? " (runner reloaded)" : ""}, until ${run.until || "the work is done"}, from session ${session}${run.maxSessions ? ` to ${run.maxSessions}` : ""}, ${run.model || MAIN_MODEL} at ${run.effort || "xhigh"}, subagents ${SUB_MODEL} (${subEffortText()}), Fable on request under ${pct(fableCeiling)} of its allowance (${fableSessions} sessions while unknown)`);
  while (!run.maxSessions || session <= run.maxSessions) {
    if (fs.existsSync(stopFile)) finish("stop requested");
    if (fs.existsSync(reloadFile)) handOver(); // returns only when the hand-over failed
    if (run.deadline && Date.now() >= run.deadline) finish(`reached ${run.until}`);
    const prompt = read(next).trim();
    if (!prompt) finish("next-prompt.md is empty");
    // MODEL and EFFORT lines are the runner's: STOP is looked for in what follows them, and the
    // session gets only that.
    const asked = sessionPlan(prompt, run);
    if (isStop(asked.body)) finish(asked.body.split("\n")[0]);
    if (!asked.body.trim()) finish("next-prompt.md holds only MODEL/EFFORT lines");

    const nn = String(session).padStart(2, "0");
    fs.writeFileSync(path.join(state, "prompts", `${nn}.md`), prompt);
    const before = fs.statSync(next).mtimeMs;
    const resume = pendingResume();
    // A resumed session goes on as it ran (resume.json, or the runs line of a session the last runner
    // left). A new one that asks for Fable gets it while the gate allows; a resumed one unless the
    // allowance is used up.
    let plan = resume?.model ? { ...asked, model: resume.model, family: familyOf(resume.model), effort: resume.effort || asked.effort } : asked;
    if (plan.family === "fable") {
      const g = fableGate(readFable(), { ceiling: fableCeiling, maxSessions: fableSessions });
      if (!g.ok && (!resume || g.why === "out")) plan = { ...plan, model: opusModel, family: "opus", effort: "max", downgrade: g };
    }
    log(resume ? `session ${nn} resumes ${resume.sessionId} ${resume.why === "stopped" ? "where the last runner stopped" : resume.why === "error" ? "after the error" : "after the usage limit"}`
      : `session ${nn} starts: ${asked.body.split("\n")[0].slice(0, 120)}`);
    if (asked.note && !resume) log(`session ${nn}: ${asked.note}`);
    if (plan.downgrade) log(`session ${nn} asked for Fable, but ${whyText(plan.downgrade)}; it runs on Opus at max`);
    // night-report.mjs and cutOffSession read this line back.
    log(`session ${nn} runs ${modelText(plan)} at ${plan.effort}${plan.effort === "max" && asked.effort === "max" && !plan.downgrade ? " (its prompt asks for it)" : ""}`);
    if (plan.family === "fable" && !resume) writeFable({ sessions: (readFable().sessions || 0) + 1 });
    writeSettings({ [plan.family]: plan.effort });
    const result = await runSession(run, session, plan, nn, resume);
    log(`session ${nn} ends: ${result.summary}`);
    // A session that wrote its handover has done its piece, even when a limit cut off what came after.
    const wrote = fs.statSync(next).mtimeMs > before && read(next).trim() !== prompt;
    const ran = result.mainModels.join(", ") || result.model || "no model reply";
    log(`session ${nn} limits: ${windowSpan(result.windows)}; it ran on ${ran}`);
    const fw = result.windows.last?.seven_day_overage_included;
    if (fw?.utilization != null) writeFable({ ratio: fw.utilization, ratioResetsAt: fw.resetsAt ?? null, ratioAt: Date.now() });
    if (plan.family === "fable" && (result.switchedTo || result.mainModels.some((m) => familyOf(m) !== "fable")))
      log(`session ${nn} was to run on Fable, but ${result.switchedTo ? `the CLI switched it to ${result.switchedTo}` : `its turns ran on ${ran}`}`);

    // Fable's allowance cut the session off: its piece goes on from its prompt on Opus at max (a new
    // conversation, so a session of its own), unless it already wrote the next prompt. Every
    // MODEL: fable prompt runs on Opus at max until the allowance resets (fableGate).
    if (plan.family === "fable" && result.fableOut) {
      const until = result.fableResetAt || Date.now() + 24 * 3_600_000;
      writeFable({ outUntil: until });
      log(`session ${nn}: Fable's allowance is used up (${result.apiError || result.limitType || "refused"}) until ${stamp(until)}${result.fableResetAt ? "" : " (a guess: the CLI gave no reset time)"}; limit record ${JSON.stringify(result.limitInfo)}`);
      fs.rmSync(resumeFile, { force: true });
      if (!wrote) {
        fs.writeFileSync(next, `EFFORT: max\nÖnceki Fable oturumu (${nn}) Fable payı bittiği için kesildi; bu parça Opus max'te sürüyor. ` +
          `Önce git status ve git diff'e bak: yarım kalan iş orada olabilir; bitmiş işi yeniden yapma.\n\n${plan.body}`);
        log(`session ${nn}'s piece goes on in the next session on Opus at max`);
      }
      session++;
      continue;
    }
    if (result.limited) {
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
      if (result.resetAt && result.resetAt - Date.now() > maxWait * 3_600_000) finish(`the usage limit resets ${stamp(result.resetAt)}, more than ${maxWait} h away (--max-wait-hours)`);
      const until = Math.min(result.resetAt || Date.now() + 30 * 60_000, run.deadline || Infinity);
      if (wrote) log(`session ${nn}: the limit cut it off after its handover; session ${String(session + 1).padStart(2, "0")} starts when it resets`);
      log(`usage limit: waiting until ${new Date(until).toLocaleString("sv-SE")}`);
      await waitUntil(until);
      if (wrote) { failures = 0; session++; continue; }
      fs.rmSync(path.join(state, "prompts", `${nn}.md`), { force: true });
      continue;
    }
    // The session cannot run (a refused login, a bad request): the next one would fail the same way.
    if (result.fatal) finish(`session ${nn} cannot run: ${result.errorText}`);
    let retryHandover = false;
    if (result.transient && !wrote) {
      streak++;
      streakStart ||= Date.now();
      const maxWait = run.maxWaitHours ?? 6;
      if (Date.now() - streakStart > maxWait * 3_600_000) finish(`session ${nn} kept failing for ${maxWait} h (${result.errorText})`);
      if (result.mainModels.length > 0 && result.sessionId) {
        // It worked before the error: the same conversation goes on, so nothing is done twice.
        fs.writeFileSync(resumeFile, JSON.stringify({ nn, sessionId: result.sessionId, why: "error", model: plan.model, effort: plan.effort }));
        deadResumes = 0;
      } else if (resume) {
        // A resume that dies without a turn gets one more try; then the conversation is given up
        // and the piece goes on from the recovery note below.
        if (++deadResumes >= 2) { fs.rmSync(resumeFile, { force: true }); retryHandover = true; }
      } else if (plan.family === "fable" && result.mainModels.length === 0) writeFable({ sessions: Math.max(0, (readFable().sessions || 0) - 1) }); // it never had a turn: the retry is not a second Fable session
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
      failures++;
      if (failures >= 2) finish("two sessions in a row ended without writing next-prompt.md");
      // The retry does the same piece, so its MODEL and EFFORT lines stay the first lines.
      const d = promptDirectives(prompt);
      fs.writeFileSync(next, `${directiveLines(d)}Önceki gece oturumu (${nn}) devam promptu yazmadan bitti (${result.summary}). ` +
        `Durumu git log, projenin günlükleri ve gece raporundan çıkar; bitmiş işi yeniden yapma.\n\n${d.model || d.effort ? d.body : prompt}`);
      log(`session ${nn} left no continuation prompt; retrying with a recovery note`);
    } else {
      failures = 0;
      const size = Buffer.byteLength(after);
      if (size > PROMPT_WARN_BYTES) log(`session ${nn} wrote a next-prompt.md of ${Math.round(size / 1000)} KB (over ${PROMPT_WARN_BYTES / 1000} KB): the next session reads all of it on every call`);
    }
    session++;
  }
  finish(`reached ${run.maxSessions} sessions`);
  } catch (e) { die(e); }
}

// plan: sessionPlan's { model, family, effort, body }, with downgrade when Fable was refused.
function runSession(run, session, plan, nn, resume) {
  const resumeId = resume?.sessionId;
  const { effort, body } = plan;
  const header = resumeId ? [
    ...(resume.why === "stopped" ? [
      `Oturum yarıda kesildi: runner durdu (bilgisayar kapanmış ya da yeniden başlamış olabilir); gece vardiyası, ${now()}.`,
      `Çalışan alt ajanlar ve araçlar öldü; yarım kalan dosyaları git status ve git diff ile incele, gerekirse o adımı baştan al.`,
    ] : [resume.why === "error" ? `Bağlantı ya da API hatası geçti (gece vardiyası, ${now()}).` : `Kullanım limiti sıfırlandı (gece vardiyası, ${now()}).`]),
    `Kaldığın yerden devam et: yarım kalan adımı git status ile kontrol et, bitmiş işi yeniden yapma. Oturumu night-shift skill'inin üç adımıyla bitir`,
    `(commit, gece raporu, ${path.join(run.state, "next-prompt.md")}).`,
  ].join("\n") : [
    `Gece vardiyası (night-shift), oturum ${session}${run.maxSessions ? `/${run.maxSessions}` : ""}, ${now()}.`,
    `Kullanıcı ${run.until ? `${run.until}'e kadar` : "zincir bitene kadar"} yok ve hiçbir soruya yanıt veremez.`,
    `Önce night-shift skill'ini çağır ve "Inside a night session" bölümüne uy.`,
    `Devam dosyası: ${path.join(run.state, "next-prompt.md")}. Gece raporu: ${run.report}.`,
    ...(plan.family === "fable" ? [FABLE_NOTE] : []),
    ...(plan.downgrade ? ["İstem MODEL: fable istedi, ama Fable'ın haftalık payı bu gece ona yetmiyor; bu parça Opus max'te çalışıyor."] : []),
    ...(effort === "max" ? [MAX_NOTE] : []),
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
      env: { ...withoutEffortEnv(process.env), PATH: run.path, NIGHT_SHIFT: "1", NIGHT_SHIFT_STATE: run.state, NIGHT_SHIFT_REPO: run.repo,
        NIGHT_SHIFT_SESSION: String(session), NIGHT_SHIFT_UNTIL: run.until || "", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
        // A Fable session whose allowance runs out would go on, on another model, on its own; this
        // ends it instead (model_substitution_disabled), so the runner hands the piece to Opus at max.
        // Only for Fable: it also turns off the overload fallback and compaction's model choice.
        ...(plan.family === "fable" ? { CLAUDE_CODE_NO_MODEL_FALLBACK: "1" } : {}),
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
const statusHead = (ptr, running) => [running ? `running (pid ${ptr.pid}) since ${ptr.startedAt}`
  : ptr.finished ? `finished ${ptr.finishedAt}: ${ptr.reason}` : `scheduled ${ptr.scheduledAt}, not running`, `state: ${ptr.state}`];

function status(opt) {
  const repo = repoRoot(opt.repo || process.cwd());
  const ptr = readPointer(repo);
  if (!ptr) return console.log("no night-shift run recorded for this repository");
  const running = !ptr.finished && ptr.pid && alive(ptr.pid);
  console.log(`${statusHead(ptr, running).join("\n")}\n`);
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
  const report = (head) => [...head, "", ...buildReport(state, { pid: 0 }).plain.split("\n\n").slice(0, 2).flatMap((b) => [b, ""])];
  const over = () => {
    const waits = userWaits(state);
    console.log([...report(statusHead(pointerOr(repo) || first, false)),
      waits.length ? `Kullanıcıyı bekleyenler:\n${waits.join("\n")}` : "Kullanıcıyı bekleyenler: listede madde yok", "",
      `Rapor: ${path.resolve(repo, run.report || "NIGHT_RUNS.md")} · tam durum: node "${SELF}" status --repo "${repo}"`].join("\n"));
  };
  const crashed = (why) => {
    const tail = read(path.join(state, "chain.log")).trim().split("\n").slice(-3).map((l) => `  ${l}`);
    console.log([...report([`zincir çöktü: ${why}`, `state: ${state}`]), "chain.log'un sonu:", ...tail, "",
      `Kullanıcı isterse devam (promptsuz; yarım kalan oturum kendi konuşmasında sürer): node "${SELF}" start --repo "${repo}" --state "${state}"`].join("\n"));
    process.exitCode = 2;
  };

  let pid = first.pid;
  if (!pid && !first.finished) {
    console.log("runner henüz başlamadı; bekleniyor");
    const p = await pointerChange(repo, (x) => x.finished || runner(0)(x), HANDOVER_MS);
    if (!p) return crashed(`${HANDOVER_MS / 60_000} dakikada runner başlamadı (Task Scheduler görevi çalışmadı)`);
    pid = p.pid;
  }
  if (pid && alive(pid)) console.log(`bekliyor: runner pid ${pid} (${state})`);
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
        return crashed(handover ? `runner ${pid} devretti ama ${HANDOVER_MS / 60_000} dakikada yeni runner başlamadı`
          : `runner (pid ${pid}) bitiş satırı yazmadan kapandı`);
      }
    }
    console.log(`runner devretti: pid ${pid} → ${next.pid}`);
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
if (!process.argv[1] || path.resolve(process.argv[1]).toLowerCase() !== SELF.toLowerCase()) { /* imported */ }
else if (commands[opt.cmd]) await commands[opt.cmd](opt);
else {
  const lines = read(SELF).split("\n");
  console.log(lines.slice(1, lines.findIndex((l, i) => i > 0 && /^\/\/ start schedules/.test(l))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}
