// What differs by system, in one place (C5): how the guard compares paths and which temp folders it lets a night
// session write, and how the runner starts itself detached, finds the CLI, watches, waits for and stops processes
// and keeps the machine awake. Imports only node, since the guard loads it on every call. platformFor(name, deps)
// builds the object for a system, and `platform` is this system's.
// Every method is Windows' code under every name, apart from where that code itself asked for Windows (norm's Git Bash
// /tmp, fsHome); macOS and Linux come behind it next. No environment variable picks the system: a project's settings
// could hand one to the guard's hook and change its path rules. deps stand in for Node's calls in a unit test
// (platform.test.mjs), which then sees what a method would do without doing it. The methods are closures, so a
// caller may take one out (const { norm } = platform).
//   tempRoot()                         the temp folder in long form
//   norm(p)                            a path the way Windows resolves it, for comparing two spellings of one file
//   foldsCase, samePath(a, b)          two paths, resolved, compared as the system compares them
//   fsHome(home), home(env)            the home as the file system resolves it; the home the guard's env names
//   oddPath(p)                         why a normalized path names a file the guard cannot tell, else null
//   tempRoots(home), sharedTemps       the guard's writable temp folders; the shared ones a state folder may not hold
//   systemDirProblem(dir, { home, temp })  null, or why a normalized dir is where the system runs things from
//   alive(pid, { denied })             whether a process lives; denied: what a process it may not signal counts as
//   commandLine(pid)                   a process's command line: "" when it is gone, null when it could not be asked
//   killTree(pid)                      ends a process and every process it started, errors swallowed
//   keepAwake(pid)                     keeps the machine awake while pid lives; returns the helper, for its kill()
//   waitExit(pid, { signal, unless })  0 once pid is gone, 3 when its command line does not match unless, "woken" on abort
//   cliCandidates(nodeDir), cliName    where Claude Code's CLI is looked for, after NIGHT_SHIFT_CLAUDE, and its file's name
//   psQuote(s)                         a PowerShell single-quoted string
//   schedule({ task, node, script, args, window, state, title })  starts node script args detached, outside the
//                                      editor and the shell that ran it, and returns what started it (the task's name)

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const under = (p, root) => root && (p === root || p.startsWith(root + "/"));

// A PowerShell single-quoted string. PowerShell ends one at ' and at the typographic quotes
// ‘ ’ ‚ ‛ alike, so each is doubled: a state folder or a repository named with one must stay text.
export const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;

export function platformFor(name = process.platform, deps = {}) {
  const tmpdir = deps.tmpdir || os.tmpdir;
  const homedir = deps.homedir || os.homedir;
  const realpath = deps.realpath || fs.realpathSync.native;
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal));
  const run = deps.execFileSync || execFileSync;
  const start = deps.spawn || spawn;
  const writeFile = deps.writeFileSync || fs.writeFileSync;
  const env = () => deps.env || process.env;

  // The temp folder in long form. %TEMP% is often written as an 8.3 short name (C:\Users\JOHNSM~1\…),
  // which the guard refuses in any path, so the tool's own temp paths all come from this one spelling.
  // A folder that cannot be resolved is kept as it is.
  const tempRoot = () => {
    const t = tmpdir();
    try { return realpath(t); } catch { return t; }
  };

  // A path the way Windows resolves it, so that two spellings of one file compare equal: one kind
  // of slash, lower case, an MSYS drive (/c/…) and \\?\C:\… as a drive path, Git Bash's /tmp as the
  // temp folder, . and .. resolved, and a segment's trailing dots and spaces dropped (Windows opens
  // "settings.json." as settings.json). The 2026-11-15 review wrote the guard itself through
  // C:/temp/../Users/….
  const norm = (p) => {
    let s = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").toLowerCase();
    s = s.replace(/^\/\/[?.]\/(?=[a-z]:)/, "");
    const msys = /^\/([a-z])\//.exec(s);
    if (msys) s = `${msys[1]}:/${s.slice(3)}`;
    else if (name === "win32" && /^\/tmp(\/|$)/.test(s)) s = `${tempRoot().replace(/\\/g, "/").toLowerCase()}${s.slice(4)}`;
    const lead = /^\/{0,2}/.exec(s)[0].slice(0, 2);
    const out = [];
    for (const raw of s.slice(lead.length).split("/")) {
      const seg = /^\.\.?$/.test(raw) ? raw : raw.replace(/[. ]+$/, "");
      if (!seg || seg === ".") continue;
      if (seg !== "..") out.push(seg);
      else if (out.length && out.at(-1) !== "..") { if (!/^[a-z]:$/.test(out.at(-1))) out.pop(); }
      else if (!lead) out.push(seg);
    }
    return lead + out.join("/");
  };

  // Case folded under every name for now, as norm folds; the second C5 session sets it per system, with norm.
  const foldsCase = true;
  const samePath = (a, b) => {
    const [x, y] = [path.resolve(a), path.resolve(b)];
    return foldsCase ? x.toLowerCase() === y.toLowerCase() : x === y;
  };

  // The home as the file system resolves it: on Windows an MSYS drive (Git Bash's HOME, /c/Users/u) is a drive path.
  // Not norm(): it lowercases, and a case-sensitive file system resolves a path only as typed.
  const fsHome = (home) => (name === "win32" ? String(home).replace(/^\/([a-zA-Z])(?=\/)/, "$1:") : String(home));
  // The home the guard protects ~/.claude under: the hook's environment first, then Node's answer.
  const home = (env = process.env) => env.USERPROFILE || env.HOME || homedir();

  // Windows opens a path through a stream name (a.ts:x, .git::$INDEX_ALLOCATION) or an 8.3 short
  // name (SETTIN~1.JSO) as a file the rules below never named, so these are refused outright
  // rather than resolved. p is already normalized.
  const oddPath = (p) => {
    if (p.replace(/^[a-z]:(?=\/|$)/, "").includes(":")) return "an NTFS stream name";
    if (p.split("/").some((s) => /~\d/.test(s))) return "a short (8.3) name";
    return null;
  };

  // The temp folders a night session may write besides the repository and the state folder; home is normalized.
  const tempRoots = (home) => ["c:/temp", norm(tempRoot()), `${home}/appdata/local/temp`];
  // Temp folders other programs share, as [name, normalized path]: a state folder may be inside one, never one itself.
  const sharedTemps = [["C:/temp", "c:/temp"]];
  // The guard lets a night session write into the state folder, so not where Windows runs things from:
  // the Startup folder lives in AppData\Roaming, and the system's own folders hold programs. dir is normalized.
  const systemDirProblem = (dir, { home = "", temp = tempRoot() } = {}) => {
    if (home && under(dir, `${norm(home)}/appdata`) && !under(dir, norm(temp))) return "is inside AppData, outside the temp folder";
    if (/^c:\/(windows|program files[^/]*|programdata)(\/|$)/.test(dir)) return "is inside a system or program folder";
    return null;
  };

  // Signal 0 only asks. No pid is no process (on Windows, process.kill(0, 0) asks about this process).
  const alive = (pid, { denied = false } = {}) => {
    if (!pid) return false;
    try { kill(pid, 0); return true; } catch (e) { return denied && e.code === "EPERM"; }
  };

  const commandLine = (pid) => {
    try {
      return run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true });
    } catch { return null; }
  };

  // taskkill /T ends the tree by parent process id, so a detached child (the watcher) goes with the runner's tree.
  const killTree = (pid) => {
    try { run("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); } catch {}
  };

  // A hidden PowerShell that holds the system awake (ES_CONTINUOUS | ES_SYSTEM_REQUIRED) and exits once pid is gone.
  const keepAwake = (pid) => start("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `$k=Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace NightShift -PassThru; ` +
    `[void]$k::SetThreadExecutionState([uint32]2147483649); while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60 }`],
  { stdio: "ignore", windowsHide: true });

  // No polling: a hidden PowerShell waits on the process handle. unless (required) is a PowerShell regex: a live pid whose command
  // line does not match it belongs to another program now (Windows reuses numbers), so what was waited for is gone.
  // Aborting signal kills the PowerShell and resolves "woken"; any other error rejects.
  const waitExit = (pid, { signal, unless } = {}) => new Promise((resolve, reject) => {
    const ps = start("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 0 }; ` +
      `$c = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine; ` +
      `if ($c -and $c -notmatch ${psQuote(unless)}) { exit 3 }; $p.WaitForExit(); exit 0`],
    { stdio: "ignore", windowsHide: true, signal });
    ps.on("error", (e) => (e.name === "AbortError" ? resolve("woken") : reject(e)));
    ps.on("exit", resolve);
  });

  // Beside node (an npm install next to it), npm's global folder, and the native installer's.
  const cliName = "claude.exe";
  const cliCandidates = (nodeDir) => [
    path.join(nodeDir, "node_modules", "@anthropic-ai", "claude-code", "bin", cliName),
    path.join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", cliName),
    path.join(homedir(), ".local", "bin", cliName),
  ];

  // Through Task Scheduler's task `task`, written over each time. No trigger, so only start (or a runner handing over)
  // runs it and a finished chain never comes back on its own; no time limit (schtasks' default stops a task after
  // 72 h) and no battery stop, because the chain has no end time. Parallel, so a runner handing over can start the
  // next one. A visible console (window) runs <state>/launch.cmd, titled night-shift <title>; a hidden one is conhost
  // --headless, which no default terminal (Windows Terminal) takes over, so every child shares that hidden console
  // too. A failure throws, with PowerShell's error in its stderr.
  const schedule = ({ task, node, script, args, window = false, state, title = "" }) => {
    const launcher = path.join(state, "launch.cmd");
    // The title goes into a cmd line: only what cmd reads as plain text.
    writeFile(launcher, `@echo off\r\ntitle night-shift ${String(title).replace(/[^\w .-]/g, "_")}\r\n"${node}" "${script}" %*\r\n`);
    const argLine = args.map((a) => `"${a}"`).join(" ");
    const [exe, argv] = window ? [launcher, argLine]
      : [path.join(env().SystemRoot || "C:\\Windows", "System32", "conhost.exe"), `--headless "${node}" "${script}" ${argLine}`];
    const q = psQuote;
    run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; " +
      `$a = New-ScheduledTaskAction -Execute ${q(exe)} -Argument ${q(argv)}; ` +
      "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances Parallel; " +
      `Register-ScheduledTask -TaskName ${q(task)} -Action $a -Settings $s -Force | Out-Null; Start-ScheduledTask -TaskName ${q(task)}`],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    return task;
  };

  return { name, tempRoot, norm, foldsCase, samePath, fsHome, home, oddPath, tempRoots, sharedTemps, systemDirProblem, alive,
    commandLine, killTree, keepAwake, waitExit, cliName, cliCandidates, psQuote, schedule };
}

export const platform = platformFor();
