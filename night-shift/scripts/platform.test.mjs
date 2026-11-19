// node --test night-shift/scripts/platform.test.mjs
// The seam that holds what differs by system (C5). Each method under platformFor(name, fakes) does what the code it
// replaced did; the fakes stand in for Node's calls, so nothing here kills, spawns or reads a real process but its own.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventEmitter } from "node:events";
import { platform, platformFor } from "./platform.mjs";

const fail = (code) => () => { throw Object.assign(new Error(code), { code }); };

test("platform is this system's object, with every method platformFor builds", () => {
  assert.equal(platform.name, process.platform);
  assert.deepEqual(Object.keys(platform).sort(), Object.keys(platformFor("linux")).sort());
  assert.equal(platformFor().name, process.platform);
});

test("tempRoot is the temp folder as the file system resolves it, or as given when it cannot be resolved", () => {
  const p = platformFor("win32", { tmpdir: () => "C:\\Users\\JOHNSM~1\\AppData\\Local\\Temp", realpath: () => "C:\\Users\\johnsmith\\AppData\\Local\\Temp" });
  assert.equal(p.tempRoot(), "C:\\Users\\johnsmith\\AppData\\Local\\Temp");
  assert.equal(platformFor("win32", { tmpdir: () => "C:\\gone", realpath: fail("ENOENT") }).tempRoot(), "C:\\gone");
});

test("norm gives one spelling of a path, and reads Git Bash's /tmp as the temp folder only on Windows", () => {
  const deps = { tmpdir: () => "C:\\Users\\U\\AppData\\Local\\Temp", realpath: (t) => t };
  const win = platformFor("win32", deps), linux = platformFor("linux", deps);
  assert.equal(win.norm('"C:\\Users\\U\\.Claude\\settings.json. "'), "c:/users/u/.claude/settings.json");
  assert.equal(win.norm("/c/work/../Users/u"), "c:/users/u");
  assert.equal(win.norm("\\\\?\\C:\\x\\.\\y"), "c:/x/y");
  assert.equal(win.norm("C:/../../x"), "c:/x");
  assert.equal(win.norm("//server/share/a/../b"), "//server/share/b");
  assert.equal(win.norm("/tmp/x"), "c:/users/u/appdata/local/temp/x");
  assert.equal(win.norm("/tmpx/y"), "/tmpx/y");
  assert.equal(linux.norm("/tmp/x"), "/tmp/x");
});

// A POSIX object for a test on any system: /tmp as the temp folder, nothing resolves as a link.
const posix = (name, deps = {}) => platformFor(name, { tmpdir: () => "/tmp", realpath: fail("ENOENT"), homedir: () => "/home/node", ...deps });

test("norm off Windows keeps a name's case on Linux and folds it on macOS and on a WSL drive, and keeps what POSIX names may hold", () => {
  const linux = posix("linux"), mac = posix("darwin");
  assert.equal(linux.norm("/Work/Repo/./src/../A.ts"), "/Work/Repo/A.ts");
  assert.equal(mac.norm("/Work/Repo/./src/../A.ts"), "/work/repo/a.ts");
  assert.equal(linux.norm("/mnt/c/Work/Repo"), "/mnt/c/work/repo");
  assert.equal(linux.norm("/mnt/data/Work"), "/mnt/data/Work");
  // A backslash, a colon and trailing dots or spaces are part of a name there; leading slashes are one.
  assert.equal(linux.norm("/work/repo\\x"), "/work/repo\\x");
  assert.equal(linux.norm("/x/settings.json. "), "/x/settings.json. ");
  assert.equal(linux.norm("/x/a:b"), "/x/a:b");
  assert.equal(linux.norm("//home/u/.claude"), "/home/u/.claude");
  assert.equal(linux.norm("///x//y/"), "/x/y");
  assert.equal(linux.norm("/c/x"), "/c/x");
  assert.equal(linux.norm("C:/x"), "C:/x");
  assert.equal(linux.norm('"/x/a b"'), "/x/a b");
  assert.equal(linux.norm("/../x"), "/x");
  assert.equal(linux.norm("a/../../b"), "../b");
  assert.equal(linux.norm(""), "");
  // macOS: one spelling for what the system links (/private/var is /var, the data volume is /), and one Unicode form.
  assert.equal(mac.norm("/private/var/folders/X/T"), "/var/folders/x/t");
  assert.equal(mac.norm("/private/tmp"), "/tmp");
  assert.equal(mac.norm("/private/etc/hosts"), "/etc/hosts");
  assert.equal(mac.norm("/private/x"), "/private/x");
  assert.equal(mac.norm("/System/Volumes/Data/Users/U/.claude"), "/users/u/.claude");
  assert.equal(linux.norm("/private/var/x"), "/private/var/x");
  const acute = String.fromCharCode(0x301), eAcute = String.fromCharCode(0xe9);
  assert.equal(mac.norm(`/Users/Jose${acute}`), mac.norm(`/Users/Jos${eAcute}`));
  assert.notEqual(linux.norm(`/Users/Jose${acute}`), linux.norm(`/Users/Jos${eAcute}`));
});

test("fold and samePath compare as the file system does: case-blind on Windows and macOS, on Linux only on a WSL drive", () => {
  const base = path.resolve("ns-same");
  assert.equal(platformFor("win32").samePath(path.win32.join(base, "Ab"), path.win32.join(base, "x", "..", "aB")), true);
  assert.equal(platformFor("win32").samePath(path.win32.join(base, "a"), path.win32.join(base, "b")), false);
  assert.equal(platform.samePath(base, path.join(base, "x", "..")), true);
  const linux = posix("linux"), mac = posix("darwin");
  assert.equal(linux.samePath("/a/B", "/a/x/../B"), true);
  assert.equal(linux.samePath("/a/B", "/a/b"), false);
  assert.equal(linux.samePath("/mnt/c/A", "/mnt/c/a"), true);
  assert.equal(mac.samePath("/a/B", "/a/b"), true);
  assert.equal(platformFor("win32").fold("C:/A"), "c:/a");
  assert.equal(linux.fold("/A"), "/A");
  assert.equal(mac.fold("/A"), "/a");
  assert.equal(linux.path, path.posix);
  assert.equal(platformFor("win32").path, path.win32);
});

test("isAbsolute takes a drive or either slash on Windows, and only / elsewhere", () => {
  const win = platformFor("win32"), linux = posix("linux");
  for (const w of ["C:/x", "c:\\x", "\\x", "/x"]) assert.equal(win.isAbsolute(w), true, w);
  for (const w of ["x", "C:x", "./x", "~/x"]) assert.equal(win.isAbsolute(w), false, w);
  assert.equal(linux.isAbsolute("/x"), true);
  for (const w of ["C:/x", "\\x", "x", "~/x"]) assert.equal(linux.isAbsolute(w), false, w);
});

test("fsHome turns an MSYS drive into a drive path only on Windows, and home reads the guard's environment first", () => {
  assert.equal(platformFor("win32").fsHome("/c/Users/u"), "c:/Users/u");
  assert.equal(platformFor("win32").fsHome("C:\\Users\\u"), "C:\\Users\\u");
  assert.equal(platformFor("linux").fsHome("/c/Users/u"), "/c/Users/u");
  const p = platformFor("win32", { homedir: () => "C:\\Users\\node" });
  assert.equal(p.home({ USERPROFILE: "C:\\Users\\u", HOME: "/c/Users/h" }), "C:\\Users\\u");
  assert.equal(p.home({ HOME: "/c/Users/h" }), "/c/Users/h");
  assert.equal(p.home({}), "C:\\Users\\node");
  const linux = posix("linux");
  assert.equal(linux.home({ USERPROFILE: "C:\\Users\\u", HOME: "/home/h" }), "/home/h");
  assert.equal(linux.home({ USERPROFILE: "C:\\Users\\u" }), "/home/node");
});

test("oddPath refuses a stream name and a short name, and lets a drive's colon and a plain path pass", () => {
  assert.equal(platform.oddPath("c:/x/a.ts:x"), "an NTFS stream name");
  assert.equal(platform.oddPath("c:/x/.git::$index_allocation"), "an NTFS stream name");
  assert.equal(platform.oddPath("c:/users/settin~1.jso"), "a short (8.3) name");
  assert.equal(platform.oddPath("c:/users/u/x~y"), null);
  assert.equal(platform.oddPath("c:"), null);
  assert.equal(platform.oddPath("c:/work/repo/a.ts"), null);
});

test("oddPath off Windows: a colon and ~1 are ordinary, and macOS's resource fork is refused", () => {
  const p = (name) => platformFor(name).oddPath;
  assert.equal(platformFor("win32").oddPath("c:/x/a.ts:x"), "an NTFS stream name");
  for (const name of ["linux", "darwin"]) {
    assert.equal(p(name)("/x/a.ts:x"), null);
    assert.equal(p(name)("/x/settin~1.jso"), null);
  }
  assert.equal(p("darwin")("/users/u/.claude/settings.json/..namedfork/rsrc"), "a resource fork (..namedfork)");
  assert.equal(p("linux")("/x/..namedfork/rsrc"), null);
  // Linux opens any file through /proc (/proc/self/cwd is the current folder).
  assert.equal(p("linux")("/proc/self/cwd/.git/config"), "a /proc path (a link to another file)");
  assert.equal(p("linux")("/procs/x"), null);
  assert.equal(p("darwin")("/proc/x"), null);
});

test("tempRoots are C:/temp, the temp root and the home's AppData temp; C:/temp is the shared one", () => {
  const p = platformFor("win32", { tmpdir: () => "D:\\Tmp", realpath: (t) => t });
  assert.deepEqual(p.tempRoots("c:/users/u"), ["c:/temp", "d:/tmp", "c:/users/u/appdata/local/temp"]);
  assert.deepEqual(p.sharedTemps, [["C:/temp", "c:/temp"]]);
});

test("tempRoots off Windows are /tmp and the temp folder in both spellings, which macOS's norm makes one; /tmp and /var/tmp are shared", () => {
  assert.deepEqual(posix("linux").tempRoots("/home/u"), ["/tmp"]);
  assert.deepEqual(posix("linux", { tmpdir: () => "/run/user/1000/T", realpath: () => "/run/user/1000/T" }).tempRoots("/home/u"), ["/tmp", "/run/user/1000/T"]);
  assert.deepEqual(posix("linux", { tmpdir: () => "/home/u/tmp", realpath: () => "/data/u/tmp" }).tempRoots("/home/u"), ["/tmp", "/home/u/tmp", "/data/u/tmp"]);
  const mac = posix("darwin", { tmpdir: () => "/var/folders/ab/X/T", realpath: () => "/private/var/folders/ab/X/T" });
  assert.deepEqual(mac.tempRoots("/users/u"), ["/tmp", "/var/folders/ab/x/t"]);
  for (const name of ["linux", "darwin"]) assert.deepEqual(posix(name).sharedTemps, [["/tmp", "/tmp"], ["/var/tmp", "/var/tmp"]]);
});

test("systemDirProblem names AppData outside the temp folder and the system's own folders", () => {
  const p = platformFor("win32");
  const at = { home: "C:\\Users\\U", temp: "C:\\Users\\U\\AppData\\Local\\Temp" };
  assert.equal(p.systemDirProblem("c:/users/u/appdata/roaming/microsoft/windows/start menu", at), "is inside AppData, outside the temp folder");
  assert.equal(p.systemDirProblem("c:/users/u/appdata/local/temp/night", at), null);
  assert.equal(p.systemDirProblem("c:/users/u/appdata/x", { temp: at.temp }), null);
  for (const d of ["c:/windows/temp/x", "c:/program files (x86)/x", "c:/programdata/x"]) assert.equal(p.systemDirProblem(d, at), "is inside a system or program folder");
  assert.equal(p.systemDirProblem("c:/work/night", at), null);
});

test("systemDirProblem off Windows names the system's folders and the home's login folders, outside the temp folders", () => {
  const linux = posix("linux"), at = { home: "/home/u", temp: "/tmp" };
  for (const d of ["/etc/x", "/usr/local/x", "/var/lib/x", "/opt/homebrew/x", "/lib64/x", "/boot/x"]) assert.equal(linux.systemDirProblem(d, at), "is inside a system or program folder", d);
  for (const [d, x] of [["/home/u/.config/autostart", ".config"], ["/home/u/.local/bin", ".local/bin"], ["/home/u/.local/share/systemd/user", ".local/share"],
    ["/home/u/bin", "bin"], ["/home/u/.ssh", ".ssh"], ["/home/u/Library/LaunchAgents", "Library"]]) assert.equal(linux.systemDirProblem(d, at), `is inside ~/${x}, where the login reads programs and settings from`, d);
  for (const d of ["/tmp/night", "/var/tmp/night", "/home/u/.local/state/night", "/home/u/work/night", "/srv/night", "/home/u/.configs"]) assert.equal(linux.systemDirProblem(d, at), null, d);
  const mac = posix("darwin", { tmpdir: () => "/var/folders/ab/X/T", realpath: () => "/private/var/folders/ab/X/T" });
  const atMac = { home: "/Users/U", temp: "/private/var/folders/ab/X/T" };
  for (const d of ["/private/var/folders/ab/X/T/night", "/var/folders/ab/X/T/night", "/private/tmp/night"]) assert.equal(mac.systemDirProblem(mac.norm(d), atMac), null, d);
  for (const d of ["/System/x", "/Library/x", "/Applications/x", "/private/etc/x", "/var/db/x", "/private/x"]) assert.equal(mac.systemDirProblem(mac.norm(d), atMac), "is inside a system or program folder", d);
  assert.equal(mac.systemDirProblem(mac.norm("/Users/U/Library/LaunchAgents"), atMac), "is inside ~/Library, where the login reads programs and settings from");
});

test("alive asks with signal 0, counts no pid as no process, and EPERM as alive only when denied says so", () => {
  const asked = [];
  const p = (kill) => platformFor("win32", { kill: (pid, s) => { asked.push([pid, s]); return kill(); } });
  assert.equal(p(() => true).alive(0), false);
  assert.equal(p(() => true).alive(undefined), false);
  assert.deepEqual(asked, []);
  assert.equal(p(() => true).alive(42), true);
  assert.deepEqual(asked, [[42, 0]]);
  assert.equal(p(fail("ESRCH")).alive(42), false);
  assert.equal(p(fail("ESRCH")).alive(42, { denied: true }), false);
  assert.equal(p(fail("EPERM")).alive(42), false);
  assert.equal(p(fail("EPERM")).alive(42, { denied: true }), true);
  assert.equal(platform.alive(process.pid), true);
});

// What a method ran: [file, args, options] for each call, and a fake child for spawn.
const recorder = (answer = () => "") => {
  const calls = [];
  const child = new EventEmitter();
  const p = platformFor("win32", {
    execFileSync: (file, args, opts) => { calls.push([file, args, opts]); return answer(); },
    spawn: (file, args, opts) => { calls.push([file, args, opts]); return child; },
  });
  return { p, calls, child };
};

test("commandLine asks PowerShell's CIM for the pid as a number, and is null when it cannot ask", () => {
  const { p, calls } = recorder(() => "node night-chain.mjs run\r\n");
  assert.equal(p.commandLine("12"), "node night-chain.mjs run\r\n");
  assert.equal(p.commandLine("12; calc"), "node night-chain.mjs run\r\n");
  assert.deepEqual(calls.map((c) => c[1].at(-1)), ['(Get-CimInstance Win32_Process -Filter "ProcessId=12").CommandLine',
    '(Get-CimInstance Win32_Process -Filter "ProcessId=NaN").CommandLine']);
  assert.deepEqual(calls[0].slice(0, 1).concat([calls[0][1].slice(0, 3), calls[0][2]]),
    ["powershell", ["-NoProfile", "-NonInteractive", "-Command"], { encoding: "utf8", windowsHide: true }]);
  assert.equal(recorder(() => { throw new Error("no powershell"); }).p.commandLine(12), null);
});

test("killTree runs taskkill on the whole tree and swallows its failure", () => {
  const { p, calls } = recorder();
  assert.equal(p.killTree(42), undefined);
  assert.deepEqual(calls, [["taskkill", ["/T", "/F", "/PID", "42"], { stdio: "ignore", windowsHide: true }]]);
  assert.doesNotThrow(() => recorder(() => { throw new Error("not found"); }).p.killTree(42));
});

test("keepAwake starts a hidden PowerShell that holds the system awake until the pid is gone, and returns it", () => {
  const { p, calls, child } = recorder();
  assert.equal(p.keepAwake(42), child);
  const [file, args, opts] = calls[0];
  assert.equal(file, "powershell");
  assert.deepEqual(opts, { stdio: "ignore", windowsHide: true });
  assert.match(args.at(-1), /SetThreadExecutionState\(\[uint32\]2147483649\); while \(Get-Process -Id 42 -ErrorAction SilentlyContinue\) \{ Start-Sleep -Seconds 60 \}$/);
});

test("waitExit resolves the PowerShell's exit code, \"woken\" on an abort, and rejects any other error", async () => {
  const signal = new AbortController().signal;
  const one = recorder();
  const exit = one.p.waitExit(42, { signal, unless: "night-chain\\.mjs" });
  const [file, args, opts] = one.calls[0];
  assert.equal(file, "powershell");
  assert.deepEqual(opts, { stdio: "ignore", windowsHide: true, signal });
  assert.equal(args.at(-1), '$p = Get-Process -Id 42 -ErrorAction SilentlyContinue; if (-not $p) { exit 0 }; ' +
    '$c = (Get-CimInstance Win32_Process -Filter "ProcessId=42").CommandLine; ' +
    "if ($c -and $c -notmatch 'night-chain\\.mjs') { exit 3 }; $p.WaitForExit(); exit 0");
  one.child.emit("exit", 3);
  assert.equal(await exit, 3);
  const two = recorder();
  const woken = two.p.waitExit(42, { unless: "x" });
  two.child.emit("error", Object.assign(new Error("aborted"), { name: "AbortError" }));
  assert.equal(await woken, "woken");
  const three = recorder();
  const broken = three.p.waitExit(42, { unless: "x" });
  three.child.emit("error", Object.assign(new Error("spawn powershell ENOENT"), { code: "ENOENT" }));
  await assert.rejects(broken, /ENOENT/);
});

test("schedule writes launch.cmd and registers and starts the task, in a hidden console unless window", () => {
  const files = [];
  const ran = [];
  const p = platformFor("win32", { env: { SystemRoot: "D:\\Win" }, writeFileSync: (f, t) => files.push([f, t]),
    execFileSync: (file, args, opts) => ran.push([file, args, opts]) });
  const at = { task: "night-shift-demo-app-0000abcd", node: "C:\\node\\node.exe", script: "C:\\skill\\scripts\\night-chain.mjs",
    args: ["run", "--state", "C:\\st\\it's", "--headless"], state: "C:\\st\\it's", title: "demo&app" };
  assert.equal(p.schedule(at), "night-shift-demo-app-0000abcd");
  assert.deepEqual(files, [[path.join("C:\\st\\it's", "launch.cmd"),
    '@echo off\r\ntitle night-shift demo_app\r\n"C:\\node\\node.exe" "C:\\skill\\scripts\\night-chain.mjs" %*\r\n']]);
  const [file, args, opts] = ran[0];
  assert.equal(file, "powershell");
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.deepEqual(opts, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  const conhost = path.join("D:\\Win", "System32", "conhost.exe");
  assert.equal(args[3], "$ErrorActionPreference = 'Stop'; " +
    `$a = New-ScheduledTaskAction -Execute '${conhost}' -Argument '--headless "C:\\node\\node.exe" "C:\\skill\\scripts\\night-chain.mjs" "run" "--state" "C:\\st\\it''s" "--headless"'; ` +
    "$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances Parallel; " +
    "Register-ScheduledTask -TaskName 'night-shift-demo-app-0000abcd' -Action $a -Settings $s -Force | Out-Null; Start-ScheduledTask -TaskName 'night-shift-demo-app-0000abcd'");
  p.schedule({ ...at, window: true, args: ["run", "--state", "C:\\st"] });
  assert.ok(ran[1][1][3].includes(`-Execute ${p.psQuote(path.join("C:\\st\\it's", "launch.cmd"))} -Argument '"run" "--state" "C:\\st"'; `));
  const failing = platformFor("win32", { writeFileSync: () => {}, execFileSync: () => { throw Object.assign(new Error("failed"), { stderr: "Access is denied." }); } });
  assert.throws(() => failing.schedule(at), (e) => e.stderr === "Access is denied.");
});

test("cliCandidates are claude.exe beside node, in npm's global folder and the native installer's", () => {
  const p = platformFor("win32", { homedir: () => path.join(path.sep, "home", "u") });
  const home = path.join(path.sep, "home", "u"), bin = path.join("node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  assert.equal(p.cliName, "claude.exe");
  assert.deepEqual(p.cliCandidates(path.join(path.sep, "node")), [path.join(path.sep, "node", bin),
    path.join(home, "AppData", "Roaming", "npm", bin), path.join(home, ".local", "bin", "claude.exe")]);
});

test("off Windows the review's cases: the data volume over /private, 8.3 names on a WSL drive, a home in /var", () => {
  const mac = posix("darwin"), linux = posix("linux");
  assert.equal(mac.norm("/System/Volumes/Data/private/tmp/x"), "/tmp/x");
  assert.equal(mac.norm(mac.norm("/System/Volumes/Data/private/var/x")), mac.norm("/System/Volumes/Data/private/var/x"));
  assert.equal(linux.oddPath(linux.norm("/mnt/c/Work/Repo/GIT~1/config")), "a short (8.3) name");
  assert.equal(linux.oddPath("/mnt/c/work/a:b"), null);
  assert.equal(linux.oddPath("/home/u/a~1"), null);
  assert.equal(mac.oddPath("/users/u/a~1"), null);
  const at = { home: "/var/lib/jenkins", temp: "/tmp" };
  assert.equal(linux.systemDirProblem("/var/lib/jenkins/night/state", at), null);
  assert.equal(linux.systemDirProblem("/var/lib/jenkins/.config/x", at), "is inside ~/.config, where the login reads programs and settings from");
  assert.equal(linux.systemDirProblem("/var/lib/other/x", at), "is inside a system or program folder");
  assert.equal(linux.systemDirProblem("/Library/x", { home: "/home/u", temp: "/tmp" }), null);
});

// Off Windows: what a method read, ran, started and killed, under a linux or darwin object.
const posixRec = (name, { files = {}, dirs = {}, ps = () => "", kill = () => true, pid = 1 } = {}) => {
  const calls = [], killed = [], children = [];
  const p = platformFor(name, {
    tmpdir: () => "/tmp", realpath: fail("ENOENT"), homedir: () => "/home/u", pid, pollMs: 5,
    readFileSync: (f) => { if (!(f in files)) fail("ENOENT")(); if (files[f] instanceof Error) throw files[f]; return files[f]; },
    readdirSync: (d) => dirs[d] ?? [],
    execFileSync: (file, args, opts) => { calls.push([file, args, opts]); return ps(file, args); },
    spawn: (file, args, opts) => { calls.push([file, args, opts]); const c = new EventEmitter(); children.push(c); return c; },
    kill: (target, s) => { killed.push([target, s]); return kill(target, s); },
  });
  return { p, calls, killed, children };
};
const NUL = String.fromCharCode(0);
const stat = (pid, ppid, state = "S") => `${pid} (node (x)) ${state} ${ppid} ${pid} ${pid} 0`;

test("commandLine off Windows reads /proc on Linux and asks ps on macOS: \"\" once gone, null when it cannot ask", () => {
  const L = posixRec("linux", { files: { "/proc/12/cmdline": `node${NUL}/s/night-chain.mjs${NUL}run${NUL}`,
    "/proc/13/cmdline": Object.assign(new Error("EACCES"), { code: "EACCES" }) } });
  assert.equal(L.p.commandLine("12"), "node /s/night-chain.mjs run");
  assert.equal(L.p.commandLine(14), "");
  assert.equal(L.p.commandLine(13), null);
  assert.deepEqual(L.calls, []);
  const M = posixRec("darwin", { ps: (file, args) => (args.at(-1) === "12" ? "node /s/night-chain.mjs run\n" : fail("1")()) });
  assert.equal(M.p.commandLine("12"), "node /s/night-chain.mjs run");
  assert.deepEqual(M.calls[0], ["ps", ["-ww", "-o", "args=", "-p", "12"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }]);
  const gone = posixRec("darwin", { ps: () => { throw Object.assign(new Error("exit 1"), { status: 1 }); } });
  assert.equal(gone.p.commandLine(12), "");
  const broken = posixRec("darwin", { ps: () => { throw Object.assign(new Error("spawn ps ENOENT"), { code: "ENOENT" }); } });
  assert.equal(broken.p.commandLine(12), null);
});

test("alive on Linux counts a zombie as gone; elsewhere signal 0's answer stands", () => {
  const files = { "/proc/12/stat": stat(12, 1, "Z"), "/proc/13/stat": stat(13, 1) };
  const L = posixRec("linux", { files });
  assert.equal(L.p.alive(12), false);
  assert.equal(L.p.alive(13), true);
  assert.equal(L.p.alive(14), true);
  assert.equal(posixRec("linux", { files, kill: fail("EPERM") }).p.alive(12, { denied: true }), true);
  assert.equal(posixRec("darwin", { files }).p.alive(12), true);
  assert.equal(platformFor("win32", { kill: () => true, readFileSync: () => stat(12, 1, "Z") }).alive(12), true);
});

test("killTree off Windows ends the tree from the process table: each pid, then its group, the caller last, errors swallowed", () => {
  const files = { "/proc/10/stat": stat(10, 1), "/proc/11/stat": stat(11, 10), "/proc/12/stat": stat(12, 11), "/proc/13/stat": stat(13, 10),
    "/proc/20/stat": stat(20, 1), "/proc/30/stat": stat(30, 13) };
  const dirs = { "/proc": ["10", "11", "12", "13", "20", "30", "self", "net"] };
  const L = posixRec("linux", { files, dirs, pid: 13, kill: (t) => { if (t === 11) fail("ESRCH")(); return true; } });
  assert.equal(L.p.killTree(10), undefined);
  assert.deepEqual(L.killed, [[10, "SIGKILL"], [11, "SIGKILL"], [12, "SIGKILL"], [30, "SIGKILL"], [-10, "SIGKILL"], [13, "SIGKILL"]]);
  assert.deepEqual(L.calls, []);
  const M = posixRec("darwin", { ps: () => "   10     1\n   11    10\n   12    11\n   20     1\n" });
  M.p.killTree("10");
  assert.deepEqual(M.calls[0], ["ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }]);
  assert.deepEqual(M.killed, [[10, "SIGKILL"], [11, "SIGKILL"], [12, "SIGKILL"], [-10, "SIGKILL"]]);
  const blind = posixRec("darwin", { ps: () => { throw new Error("no ps"); } });
  blind.p.killTree(10);
  assert.deepEqual(blind.killed, [[10, "SIGKILL"], [-10, "SIGKILL"]]);
  for (const bad of [0, 1, -5, "x", undefined]) {
    const none = posixRec("linux", { files, dirs });
    none.p.killTree(bad);
    assert.deepEqual(none.killed, [], String(bad));
  }
});

test("keepAwake off Windows: caffeinate on macOS, systemd-inhibit around a kill -0 loop on Linux; a helper that fails to start throws nothing", () => {
  const M = posixRec("darwin");
  const helper = M.p.keepAwake(42);
  assert.equal(helper, M.children[0]);
  assert.deepEqual(M.calls[0], ["caffeinate", ["-i", "-w", "42"], { stdio: "ignore", windowsHide: true }]);
  assert.doesNotThrow(() => helper.emit("error", new Error("spawn caffeinate ENOENT")));
  const L = posixRec("linux");
  L.p.keepAwake("42; reboot");
  assert.deepEqual(L.calls[0], ["systemd-inhibit", ["--what=idle:sleep", "--who=night-shift", "--why=a night-shift chain is running", "--mode=block",
    "sh", "-c", "while kill -0 NaN 2>/dev/null; do sleep 60; done"], { stdio: "ignore", windowsHide: true }]);
  L.p.keepAwake(42);
  assert.equal(L.calls[1][1].at(-1), "while kill -0 42 2>/dev/null; do sleep 60; done");
  assert.doesNotThrow(() => L.children[1].emit("error", new Error("spawn systemd-inhibit ENOENT")));
  const { p, child } = recorder();
  p.keepAwake(42);
  assert.doesNotThrow(() => child.emit("error", new Error("spawn powershell ENOENT")));
});

test("waitExit off Windows polls alive: 0 once gone, 3 when the pid runs another program, \"woken\" on an abort", async () => {
  let up = true;
  const L = posixRec("linux", { files: { "/proc/42/cmdline": `node${NUL}/s/Night-Chain.mjs${NUL}run` },
    kill: () => (up ? true : fail("ESRCH")()) });
  const w = L.p.waitExit(42, { unless: "night-chain\\.mjs" });
  up = false;
  assert.equal(await w, 0);
  assert.equal(await L.p.waitExit(42, { unless: "x" }), 0);
  up = true;
  assert.equal(await L.p.waitExit(42, { unless: "other\\.mjs" }), 3);
  const ac = new AbortController();
  const woken = L.p.waitExit(42, { signal: ac.signal, unless: "night-chain\\.mjs" });
  ac.abort();
  assert.equal(await woken, "woken");
  const done = new AbortController();
  done.abort();
  assert.equal(await L.p.waitExit(42, { signal: done.signal, unless: "x" }), "woken");
  // A process it may not signal still lives; one whose command line cannot be read is waited for.
  let tries = 0;
  const E = posixRec("linux", { files: { "/proc/42/cmdline": Object.assign(new Error("EACCES"), { code: "EACCES" }) },
    kill: () => (++tries < 3 ? fail("EPERM")() : fail("ESRCH")()) });
  assert.equal(E.p.commandLine(42), null);
  assert.equal(await E.p.waitExit(42, { unless: "night-chain\\.mjs" }), 0);
  assert.equal(tries, 3);
  assert.deepEqual(L.calls, []);
});

test("cliCandidates off Windows are claude beside node, in the native installer's folder and Homebrew's", () => {
  const p = posixRec("linux").p;
  assert.equal(p.cliName, "claude");
  assert.deepEqual(p.cliCandidates("/home/u/.nvm/versions/node/v22/bin"), ["/home/u/.nvm/versions/node/v22/bin/claude", "/home/u/.local/bin/claude",
    "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]);
  assert.deepEqual(posixRec("darwin").p.cliCandidates("/usr/local/bin"), ["/usr/local/bin/claude", "/home/u/.local/bin/claude", "/opt/homebrew/bin/claude"]);
});
