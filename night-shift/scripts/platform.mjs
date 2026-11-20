// What differs by system, in one place (C5): how the guard compares paths and which temp folders it lets a night
// session write, and how the runner starts itself detached, finds the CLI, watches, waits for and stops processes
// and keeps the machine awake. Imports only node, since the guard loads it on every call. platformFor(name, deps)
// builds the object for a system, and `platform` is this system's.
// Under win32 every method is the Windows code the tool always had; under darwin and linux (and any other name) the
// POSIX one. No environment variable picks the system: a project's settings could hand one to the guard's hook and
// change its path rules. deps stand in for Node's calls in a unit test (platform.test.mjs), which then sees what a
// method would do without doing it, and builds a Linux object on Windows. The methods are closures, so a caller may
// take one out (const { norm } = platform).
//   path, realpath                     Node's path functions for this system's paths; the file system's real path of one
//   tempRoot()                         the temp folder in long form
//   norm(p)                            a path the way the system resolves it, for comparing two spellings of one file
//   fold(p), samePath(a, b)            a path in the case the file system compares it in; two paths, resolved, compared so
//   isAbsolute(word)                   whether a word a session typed names a path from the root
//   fsHome(home), home(env)            the home as the file system resolves it; the home the guard's env names
//   oddPath(p)                         why a normalized path names a file the guard cannot tell, else null
//   tempRoots(home), sharedTemps       the guard's writable temp folders; the shared ones a state folder may not be
//   systemDirProblem(dir, { home, temp })  null, or why a normalized dir is where the system runs things from
//   alive(pid, { denied })             whether a process lives; denied: what a process it may not signal counts as
//   commandLine(pid)                   a process's command line: "" when it is gone, null when it could not be asked
//   killTree(pid)                      ends a process and every process it started, errors swallowed
//   keepAwake(pid)                     keeps the machine awake while pid lives; returns the helper, for its kill()
//   waitExit(pid, { signal, unless })  0 once pid is gone, 3 when its command line does not match unless, "woken" on abort
//   cliCandidates(nodeDir), cliName    where Claude Code's CLI is looked for, after NIGHT_SHIFT_CLAUDE, and its file's name
//   psQuote(s)                         a PowerShell single-quoted string
//   openFile(file, { waitMs })         opens a file in the program the system gives its kind (a page: the browser);
//                                      resolves false when no opener could start or Windows' opener failed
//   schedule({ task, node, script, args, window, state, title })  starts node script args detached, outside the
//                                      editor and the shell that ran it, and returns what started it (the task's name,
//                                      or "detached" off Windows)

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const under = (p, root) => root && (p === root || p.startsWith(root + "/"));

// A PowerShell single-quoted string. PowerShell ends one at ' and at the typographic quotes
// ‘ ’ ‚ ‛ alike, so each is doubled: a state folder or a repository named with one must stay text.
export const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, "$&$&")}'`;

// The variables Claude Code sets in its own session and the processes it starts.
const SESSION_MARKS = /^(AI_AGENT|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|CHILD_NOTES_DIR|SESSION_ATTENDED|MESSAGING_SOCKET|MESSAGING_TOKEN|EXECPATH|SSE_PORT|EFFORT_LEVEL))$/;

export function platformFor(name = process.platform, deps = {}) {
  const win = name === "win32";
  const pp = win ? path.win32 : path.posix;
  const tmpdir = deps.tmpdir || os.tmpdir;
  const homedir = deps.homedir || os.homedir;
  const realpath = deps.realpath || fs.realpathSync.native;
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal));
  const run = deps.execFileSync || execFileSync;
  const start = deps.spawn || spawn;
  const writeFile = deps.writeFileSync || fs.writeFileSync;
  const readFile = deps.readFileSync || fs.readFileSync;
  const readDir = deps.readdirSync || fs.readdirSync;
  const openFd = deps.openSync || fs.openSync;
  const closeFile = deps.closeSync || fs.closeSync;
  const env = () => deps.env || process.env;
  const self = deps.pid ?? process.pid;
  const pollMs = deps.pollMs ?? 1000;

  // The temp folder in long form. %TEMP% is often written as an 8.3 short name (C:\Users\JOHNSM~1\…),
  // which the guard refuses in any path, so the tool's own temp paths all come from this one spelling.
  // A folder that cannot be resolved is kept as it is.
  const tempRoot = () => {
    const t = tmpdir();
    try { return realpath(t); } catch { return t; }
  };

  // A path in the case its file system compares it in: lower case on Windows; on macOS lower case and in Unicode's
  // composed form (APFS and HFS+ ignore case and the form unless formatted otherwise); on Linux as it is, apart from a
  // Windows drive that WSL mounts at /mnt/<letter>, which ignores case as Windows does.
  const fold = (p) => {
    const s = String(p);
    if (name === "darwin") return s.normalize("NFC").toLowerCase();
    return win || /^\/mnt\/[a-z](\/|$)/.test(s) ? s.toLowerCase() : s;
  };

  // A path the way Windows resolves it, so that two spellings of one file compare equal: one kind
  // of slash, lower case, an MSYS drive (/c/…) and \\?\C:\… as a drive path, Git Bash's /tmp as the
  // temp folder, . and .. resolved, and a segment's trailing dots and spaces dropped (Windows opens
  // "settings.json." as settings.json). The 2026-11-15 review wrote the guard itself through
  // C:/temp/../Users/….
  const winNorm = (p) => {
    let s = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").toLowerCase();
    s = s.replace(/^\/\/[?.]\/(?=[a-z]:)/, "");
    const msys = /^\/([a-z])\//.exec(s);
    if (msys) s = `${msys[1]}:/${s.slice(3)}`;
    else if (/^\/tmp(\/|$)/.test(s)) s = `${tempRoot().replace(/\\/g, "/").toLowerCase()}${s.slice(4)}`;
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
  // A path the way macOS and Linux resolve it: . and .. resolved, and every run of slashes one slash (both open //home
  // as /home). A backslash, a colon and a trailing dot or space are ordinary characters of a name there, so they stay:
  // read as a slash, /work/repo\x, a file beside the repository, would count as inside it. Then fold, and on macOS the
  // short form of what the system itself links: /private/tmp, /private/var and /private/etc are /tmp, /var and /etc
  // (Node's temp folder resolves into /private/var while a session's TMPDIR says /var), and /System/Volumes/Data/x is /x.
  const posixNorm = (p) => {
    const s = String(p || "").replace(/^["']|["']$/g, "");
    const lead = s.startsWith("/") ? "/" : "";
    const out = [];
    for (const seg of s.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg !== "..") out.push(seg);
      else if (out.length && out.at(-1) !== "..") out.pop();
      else if (!lead) out.push(seg);
    }
    const f = fold(lead + out.join("/"));
    // The data volume first: /System/Volumes/Data/private/tmp is /private/tmp, which is /tmp.
    return name === "darwin" ? f.replace(/^\/system\/volumes\/data(?=\/)/, "").replace(/^\/private(?=\/(tmp|var|etc)(\/|$))/, "") : f;
  };
  const norm = win ? winNorm : posixNorm;

  const samePath = (a, b) => fold(pp.resolve(a)) === fold(pp.resolve(b));
  // Whether a word a session typed names a path from the root: on Windows a drive (C:\, C:/) or a slash of either kind;
  // elsewhere only /, since C:/x and \x are names in the folder the command stands in.
  const isAbsolute = (t) => (win ? /^[a-z]:[\\/]/i.test(t) || /^[\\/]/.test(t) : String(t).startsWith("/"));

  // The home as the file system resolves it: on Windows an MSYS drive (Git Bash's HOME, /c/Users/u) is a drive path.
  // Not norm(): it lowercases, and a case-sensitive file system resolves a path only as typed.
  const fsHome = (home) => (win ? String(home).replace(/^\/([a-zA-Z])(?=\/)/, "$1:") : String(home));
  // The home the guard protects ~/.claude under: the hook's environment first, then Node's answer. USERPROFILE names
  // no home off Windows.
  const home = (env = process.env) => (win ? env.USERPROFILE || env.HOME : env.HOME) || homedir();

  // Windows opens a path through a stream name (a.ts:x, .git::$INDEX_ALLOCATION) or an 8.3 short
  // name (SETTIN~1.JSO) as a file the rules below never named, so these are refused outright
  // rather than resolved; macOS opens a file's resource fork as f/..namedfork/rsrc, and Linux any file
  // through /proc (/proc/self/cwd/.git is the current folder's .git), so those are refused too. A colon and ~1
  // are ordinary characters of a name off Windows. p is already normalized.
  const oddPath = (p) => {
    if (name === "darwin" && p.split("/").includes("..namedfork")) return "a resource fork (..namedfork)";
    if (name === "linux" && /^\/proc(\/|$)/.test(p)) return "a /proc path (a link to another file)";
    // A Windows drive that WSL mounts at /mnt/<letter> resolves short names as Windows does (its colons are not streams).
    const short = p.split("/").some((s) => /~\d/.test(s));
    if (!win) return name === "linux" && /^\/mnt\/[a-z]\//.test(p) && short ? "a short (8.3) name" : null;
    if (p.replace(/^[a-z]:(?=\/|$)/, "").includes(":")) return "an NTFS stream name";
    if (short) return "a short (8.3) name";
    return null;
  };

  // The temp folders a night session may write besides the repository and the state folder; home is normalized.
  // Off Windows: /tmp and the temp folder as given and as resolved.
  const tempRoots = (home) => (win ? ["c:/temp", norm(tempRoot()), `${home}/appdata/local/temp`] : [...new Set(["/tmp", norm(tmpdir()), norm(tempRoot())])]);
  // Temp folders other programs share, as [name, normalized path]: a state folder may be inside one, never one itself.
  const sharedTemps = win ? [["C:/temp", "c:/temp"]]
    : [["/tmp", "/tmp"], ["/var/tmp", "/var/tmp"]];
  // The guard lets a night session write into the state folder, so not where the system runs things from. On Windows the
  // Startup folder lives in AppData\Roaming, and the system's own folders hold programs. On macOS and Linux, outside the
  // temp folders: the system's own folders, and the home's folders a login runs things from (autostart and systemd user
  // units in ~/.config and ~/.local/share, ~/bin and ~/.local/bin on the PATH, ~/.ssh, LaunchAgents in ~/Library). dir is normalized.
  // In the case norm gives: macOS's /System, /Library and /Applications are folded by then, Linux has none of them.
  const POSIX_SYSTEM = /^\/(etc|usr|bin|sbin|lib[^/]*|boot|dev|proc|sys|run|var|opt|private|system|library|applications)(\/|$)/;
  const LOGIN_DIRS = [".config", ".local/bin", ".local/share", "bin", ".ssh", "Library"];
  const systemDirProblem = (dir, { home = "", temp = tempRoot() } = {}) => {
    if (win) {
      if (home && under(dir, `${norm(home)}/appdata`) && !under(dir, norm(temp))) return "is inside AppData, outside the temp folder";
      if (/^c:\/(windows|program files[^/]*|programdata)(\/|$)/.test(dir)) return "is inside a system or program folder";
      return null;
    }
    const h = home ? norm(home) : "";
    if ([norm(temp), ...tempRoots(h), ...sharedTemps.map(([, t]) => t)].some((t) => under(dir, t))) return null;
    // The home first: a service account's home may sit in /var or /opt (/var/lib/jenkins), and is the user's own.
    const login = h && LOGIN_DIRS.find((d) => under(dir, norm(`${h}/${d}`)));
    if (login) return `is inside ~/${login}, where the login reads programs and settings from`;
    if (h && under(dir, h)) return null;
    return POSIX_SYSTEM.test(dir) ? "is inside a system or program folder" : null;
  };

  // /proc/<pid>/stat's fields after the command's name, which sits in parentheses and may hold spaces and ")":
  // [state, parent pid, ...]; null when it cannot be read.
  const procStat = (pid) => {
    try { const s = String(readFile(`/proc/${pid}/stat`, "utf8")); return s.slice(s.lastIndexOf(")") + 2).split(" "); } catch { return null; }
  };

  // Signal 0 only asks. No pid is no process (on Windows, process.kill(0, 0) asks about this process). On Linux a zombie,
  // ended but not yet collected by its parent, still answers signal 0: its state Z says it is gone.
  const alive = (pid, { denied = false } = {}) => {
    if (!pid) return false;
    try { kill(pid, 0); } catch (e) { return denied && e.code === "EPERM"; }
    return name !== "linux" || procStat(pid)?.[0] !== "Z";
  };

  // Linux reads the kernel's copy (NULs between the words); macOS asks ps, which exits 1 for no such process; Windows
  // asks PowerShell's CIM.
  const commandLine = (pid) => {
    const n = Number(pid);
    if (name === "linux") {
      try { return String(readFile(`/proc/${n}/cmdline`, "utf8")).replace(/\0+$/, "").replace(/\0/g, " "); }
      catch (e) { return e.code === "ENOENT" || e.code === "ESRCH" ? "" : null; }
    }
    if (!win) {
      try { return String(run("ps", ["-ww", "-o", "args=", "-p", String(n)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).replace(/\s+$/, ""); }
      catch (e) { return e.status === 1 ? "" : null; }
    }
    try {
      return run("powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true });
    } catch { return null; }
  };

  // Every process's parent: Linux's /proc/<pid>/stat, macOS's ps.
  const parents = () => (name === "linux"
    ? readDir("/proc").filter((d) => /^\d+$/.test(d)).map((d) => [Number(d), Number(procStat(d)?.[1])])
    : String(run("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).split("\n")
      .map((l) => /^\s*(\d+)\s+(\d+)/.exec(l)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]));

  // taskkill /T ends the tree by parent process id, so a detached child (the watcher) goes with the runner's tree.
  // Elsewhere the tree comes from the process table, all of it read before any kill (a killed parent's children move
  // to init); then each pid with SIGKILL, the process group pid leads (a detached runner leads one, and what it started
  // stays in it unless it left), and this process last: the watcher that answers /stop now is in the runner's tree.
  // Every failure is swallowed, as taskkill's is; no pid, 1 or less, ends nothing.
  const killTree = (pid) => {
    if (win) { try { run("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); } catch {} return; }
    const root = Number(pid);
    if (!(root > 1)) return;
    let table = [];
    try { table = parents(); } catch { /* no table: the pid and its group */ }
    const tree = new Set([root]);
    for (const p of tree) for (const [child, parent] of table) if (parent === p) tree.add(child);
    const hit = (target) => { try { kill(target, "SIGKILL"); } catch {} };
    for (const p of tree) if (p !== self) hit(p);
    hit(-root);
    if (tree.has(self)) hit(self);
  };

  // A helper that holds the system awake while pid lives and then exits; its kill() ends it sooner. Windows: a hidden
  // PowerShell (ES_CONTINUOUS | ES_SYSTEM_REQUIRED); macOS: caffeinate -w; Linux: systemd-inhibit around a loop that
  // ends with pid. A helper that cannot start emits an error, swallowed here: no keep-awake, never a crash.
  const keepAwake = (pid) => {
    const helper = win ? start("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `$k=Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name K -Namespace NightShift -PassThru; ` +
      `[void]$k::SetThreadExecutionState([uint32]2147483649); while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60 }`],
    { stdio: "ignore", windowsHide: true })
      : name === "darwin" ? start("caffeinate", ["-i", "-w", String(Number(pid))], { stdio: "ignore", windowsHide: true })
      : start("systemd-inhibit", ["--what=idle:sleep", "--who=night-shift", "--why=a night-shift chain is running", "--mode=block",
        "sh", "-c", `while kill -0 ${Number(pid)} 2>/dev/null; do sleep 60; done`], { stdio: "ignore", windowsHide: true });
    helper.on("error", () => {});
    return helper;
  };

  // Off Windows nothing waits on a process that is not one's child: one look at its command line (a live pid whose
  // command line does not match unless, case-blind as PowerShell's -notmatch, runs another program now: 3), then alive
  // (a process it may not signal counts as alive) every pollMs until the pid is gone (0). Aborting signal resolves "woken".
  const pollExit = (pid, { signal, unless }) => new Promise((resolve) => {
    if (signal?.aborted) return resolve("woken");
    const gone = () => !alive(pid, { denied: true });
    if (gone()) return resolve(0);
    const c = commandLine(pid);
    if (c && unless && !new RegExp(unless, "i").test(c)) return resolve(3);
    const end = (v) => { clearInterval(timer); signal?.removeEventListener("abort", woken); resolve(v); };
    const woken = () => end("woken");
    const timer = setInterval(() => { if (gone()) end(0); }, pollMs);
    signal?.addEventListener("abort", woken, { once: true });
  });

  // No polling on Windows: a hidden PowerShell waits on the process handle. unless (required) is a regex read alike by PowerShell
  // and JavaScript (off Windows it is a JavaScript one; the runner passes night-chain\.mjs): a live pid
  // whose command line does not match it belongs to another program now (Windows reuses numbers), so what was waited for is gone.
  // Aborting signal kills the PowerShell and resolves "woken"; any other error rejects.
  const waitExit = (pid, { signal, unless } = {}) => (!win ? pollExit(pid, { signal, unless }) : new Promise((resolve, reject) => {
    const ps = start("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { exit 0 }; ` +
      `$c = (Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine; ` +
      `if ($c -and $c -notmatch ${psQuote(unless)}) { exit 3 }; $p.WaitForExit(); exit 0`],
    { stdio: "ignore", windowsHide: true, signal });
    ps.on("error", (e) => (e.name === "AbortError" ? resolve("woken") : reject(e)));
    ps.on("exit", resolve);
  }));

  // Windows: beside node (an npm install next to it), npm's global folder, and the native installer's. Elsewhere: beside
  // node (npm's global bin is node's own folder there), the native installer's ~/.local/bin, and Homebrew's two folders.
  const cliName = win ? "claude.exe" : "claude";
  const cliCandidates = (nodeDir) => (win ? [
    path.join(nodeDir, "node_modules", "@anthropic-ai", "claude-code", "bin", cliName),
    path.join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", cliName),
    path.join(homedir(), ".local", "bin", cliName),
  ] : [...new Set([pp.join(nodeDir, cliName), pp.join(homedir(), ".local", "bin", cliName), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"])]);

  // Through Task Scheduler's task `task`, written over each time. No trigger, so only start (or a runner handing over)
  // runs it and a finished chain never comes back on its own; no time limit (schtasks' default stops a task after
  // 72 h) and no battery stop, because the chain has no end time. Parallel, so a runner handing over can start the
  // next one. A visible console (window) runs <state>/launch.cmd, titled night-shift <title>; a hidden one is conhost
  // --headless, which no default terminal (Windows Terminal) takes over, so every child shares that hidden console
  // too. A failure throws, with PowerShell's error in its stderr.
  // Off Windows a detached process: the leader of a new session and process group, so closing the terminal or the
  // editor does not end it, with no terminal of its own (window is Windows' only). What Node prints before the runner's
  // own log is up (a broken reload, a missing run.json) is appended to <state>/runner.err. Its environment is this
  // one without the marks of the Claude Code session that may have run start, which a task Task Scheduler starts
  // never had. A process that could not start throws.
  const schedule = ({ task, node, script, args, window = false, state, title = "" }) => {
    if (!win) {
      const e = Object.fromEntries(Object.entries(env()).filter(([k]) => !SESSION_MARKS.test(k)));
      const err = openFd(pp.join(state, "runner.err"), "a");
      try {
        const child = start(node, [script, ...args], { detached: true, stdio: ["ignore", "ignore", err], env: e });
        child.on("error", () => {});
        if (!child.pid) throw new Error(`could not start ${node}`);
        child.unref();
      } finally { closeFile(err); }
      return "detached";
    }
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

  // The system's own opener, with its output ignored: Windows' Invoke-Item in a hidden PowerShell, with the path as a
  // quoted literal and no cmd line built from it; macOS' open; elsewhere xdg-open, the path as their one argument.
  // On Windows the PowerShell is not detached and is waited for, up to waitMs: started detached it ran Invoke-Item,
  // exited 0 and opened nothing (measured on Windows 11), and Node ends a child that is not detached when Node exits.
  // Resolves false when starting the opener threw, or when the PowerShell failed; true otherwise. One the system lacks
  // (xdg-open on a server) emits an error later, swallowed here.
  const openFile = (file, { waitMs = 15000 } = {}) => {
    let child;
    try {
      child = win ? start("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Invoke-Item -LiteralPath ${psQuote(file)}`],
        { stdio: "ignore", windowsHide: true })
        : start(name === "darwin" ? "open" : "xdg-open", [String(file)], { detached: true, stdio: "ignore", windowsHide: true });
    } catch { return Promise.resolve(false); }
    if (!win) {
      child.on("error", () => {});
      child.unref?.();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => { child.unref?.(); resolve(true); }, waitMs);
      const end = (ok) => { clearTimeout(timer); resolve(ok); };
      child.on("error", () => end(false));
      child.on("exit", (code) => end(code === 0));
    });
  };

  return { name, path: pp, realpath, tempRoot, norm, fold, samePath, isAbsolute, fsHome, home, oddPath, tempRoots, sharedTemps, systemDirProblem, alive,
    commandLine, killTree, keepAwake, waitExit, cliName, cliCandidates, psQuote, schedule, openFile };
}

export const platform = platformFor();
