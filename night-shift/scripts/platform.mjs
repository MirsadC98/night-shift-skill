// What differs by system, in one place (C5): how the guard compares paths and which temp folders it lets a night
// session write, and how the runner tells whether a process lives. Imports only node, since the guard loads it on
// every call. platformFor(name, deps) builds the object for a system, and `platform` is this system's.
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const under = (p, root) => root && (p === root || p.startsWith(root + "/"));

export function platformFor(name = process.platform, deps = {}) {
  const tmpdir = deps.tmpdir || os.tmpdir;
  const homedir = deps.homedir || os.homedir;
  const realpath = deps.realpath || fs.realpathSync.native;
  const kill = deps.kill || ((pid, signal) => process.kill(pid, signal));

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

  return { name, tempRoot, norm, foldsCase, samePath, fsHome, home, oddPath, tempRoots, sharedTemps, systemDirProblem, alive };
}

export const platform = platformFor();
