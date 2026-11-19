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
  assert.equal(linux.norm("/c/x"), "c:/x");
});

test("samePath resolves both paths and folds case", () => {
  const base = path.resolve("ns-same");
  assert.equal(platform.foldsCase, true);
  assert.equal(platform.samePath(path.join(base, "Ab"), path.join(base, "x", "..", "aB")), true);
  assert.equal(platform.samePath(path.join(base, "a"), path.join(base, "b")), false);
});

test("fsHome turns an MSYS drive into a drive path only on Windows, and home reads the guard's environment first", () => {
  assert.equal(platformFor("win32").fsHome("/c/Users/u"), "c:/Users/u");
  assert.equal(platformFor("win32").fsHome("C:\\Users\\u"), "C:\\Users\\u");
  assert.equal(platformFor("linux").fsHome("/c/Users/u"), "/c/Users/u");
  const p = platformFor("win32", { homedir: () => "C:\\Users\\node" });
  assert.equal(p.home({ USERPROFILE: "C:\\Users\\u", HOME: "/c/Users/h" }), "C:\\Users\\u");
  assert.equal(p.home({ HOME: "/c/Users/h" }), "/c/Users/h");
  assert.equal(p.home({}), "C:\\Users\\node");
});

test("oddPath refuses a stream name and a short name, and lets a drive's colon and a plain path pass", () => {
  assert.equal(platform.oddPath("c:/x/a.ts:x"), "an NTFS stream name");
  assert.equal(platform.oddPath("c:/x/.git::$index_allocation"), "an NTFS stream name");
  assert.equal(platform.oddPath("c:/users/settin~1.jso"), "a short (8.3) name");
  assert.equal(platform.oddPath("c:/users/u/x~y"), null);
  assert.equal(platform.oddPath("c:"), null);
  assert.equal(platform.oddPath("c:/work/repo/a.ts"), null);
});

test("tempRoots are C:/temp, the temp root and the home's AppData temp; C:/temp is the shared one", () => {
  const p = platformFor("win32", { tmpdir: () => "D:\\Tmp", realpath: (t) => t });
  assert.deepEqual(p.tempRoots("c:/users/u"), ["c:/temp", "d:/tmp", "c:/users/u/appdata/local/temp"]);
  assert.deepEqual(p.sharedTemps, [["C:/temp", "c:/temp"]]);
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
