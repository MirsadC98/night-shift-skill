// node --test night-shift/scripts/platform.test.mjs
// The seam that holds what differs by system (C5). Each method under platformFor(name, fakes) does what the code it
// replaced did; the fakes stand in for Node's calls, so nothing here kills, spawns or reads a real process but its own.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
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
