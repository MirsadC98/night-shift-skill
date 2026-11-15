// Preloaded into every Node process of a night session (NODE_OPTIONS=--require, set by runChain
// in night-settings.json). A process without a console (a detached dev server, say) that starts
// a console program gives it a new console, and Windows 11 hands that to Windows Terminal as a
// window on the user's desktop. Here every child_process call hides it unless the caller passes
// windowsHide itself. NIGHT_SHIFT_HIDE_MARK names a file to touch, for night-chain.test.mjs.
"use strict";
const cp = require("node:child_process");
const util = require("node:util");
if (process.env.NIGHT_SHIFT_HIDE_MARK) try { require("node:fs").appendFileSync(process.env.NIGHT_SHIFT_HIDE_MARK, `${process.pid}\n`); } catch {}

// spawn(cmd, [args], [opts]), execFile(file, [args], [opts], [cb]), exec(cmd, [opts], [cb]), fork(mod, [args], [opts])
function withHide(args) {
  const a = [...args];
  const at = Array.isArray(a[1]) ? 2 : 1;
  const o = a[at];
  if (o && typeof o === "object") { if (o.windowsHide === undefined) a[at] = { ...o, windowsHide: true }; }
  else if (o === undefined || o === null) a[at] = { windowsHide: true };
  else if (typeof o === "function") a.splice(at, 0, { windowsHide: true });
  return a;
}

for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const orig = cp[name];
  if (typeof orig !== "function") continue;
  const wrapped = function (...args) { return orig.apply(this, withHide(args)); };
  const custom = orig[util.promisify.custom];
  if (custom) wrapped[util.promisify.custom] = (...args) => custom(...withHide(args));
  cp[name] = wrapped;
}
try { require("node:module").syncBuiltinESMExports(); } catch {}
