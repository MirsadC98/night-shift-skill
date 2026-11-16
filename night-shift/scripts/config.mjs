// The one reader of a project's .claude/night-shift.json, for the runner and the guard, so that a
// typo is named at start instead of ending a run at 3 a.m. (or silently switching a rule off), and
// so that a state folder too wide to be a state folder is refused by both. Imports only node.
//   readProjectConfig(repo) -> { config, errors }   never throws; config holds only the valid keys
//   stateDirProblem(dir, { home, repo, temp })      null, or why dir may not be the state folder

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// The temp folder in long form. %TEMP% is often written as an 8.3 short name (C:\Users\JOHNSM~1\…),
// which the guard refuses in any path, so the tool's own temp paths all come from this one spelling.
// A folder that cannot be resolved is kept as it is.
export const tempRoot = () => {
  const t = os.tmpdir();
  try { return fs.realpathSync.native(t); } catch { return t; }
};

// A path the way Windows resolves it, so that two spellings of one file compare equal: one kind
// of slash, lower case, an MSYS drive (/c/…) and \\?\C:\… as a drive path, Git Bash's /tmp as the
// temp folder, . and .. resolved, and a segment's trailing dots and spaces dropped (Windows opens
// "settings.json." as settings.json). The 2026-11-15 review wrote the guard itself through
// C:/temp/../Users/….
export const norm = (p) => {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").toLowerCase();
  s = s.replace(/^\/\/[?.]\/(?=[a-z]:)/, "");
  const msys = /^\/([a-z])\//.exec(s);
  if (msys) s = `${msys[1]}:/${s.slice(3)}`;
  else if (process.platform === "win32" && /^\/tmp(\/|$)/.test(s)) s = `${tempRoot().replace(/\\/g, "/").toLowerCase()}${s.slice(4)}`;
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
const under = (p, root) => root && (p === root || p.startsWith(root + "/"));

const isStr = (v) => typeof v === "string";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Each check returns null when the value is fine, else the text that follows the key's name.
// `deny` is checked rule by rule in denyErrors.
export const CONFIG_KEYS = {
  stateDir: (v) => (isStr(v) ? null : "must be a string"),
  report: (v) => (isStr(v) ? null : "must be a string"),
  lessons: (v) => (isStr(v) ? null : "must be a string"),
  model: (v) => (isStr(v) ? null : "must be a string"),
  effort: (v) => (EFFORTS.includes(v) ? null : `must be one of ${EFFORTS.join(", ")}`),
  fableCeiling: (v) => (typeof v === "number" && v > 0 && v <= 100 ? null : "must be a number above 0 and at most 100"),
  fableSessions: (v) => (Number.isInteger(v) && v >= 0 ? null : "must be a whole number, 0 or more"),
  maxWaitHours: (v) => (typeof v === "number" && v > 0 ? null : "must be a number above 0"),
  mcp: (v) => (v === "none" || v === "inherit" || (Array.isArray(v) && v.every((s) => isStr(s) && s)) ? null : 'must be "none", "inherit" or a list of server names'),
  deny: (v) => denyErrors(v),
};

function denyErrors(list) {
  if (!Array.isArray(list)) return ['"deny" must be a list of { pattern, reason?, flags? }'];
  const errors = [];
  list.forEach((d, i) => {
    const at = `deny[${i}]`;
    if (!d || typeof d !== "object" || Array.isArray(d) || !isStr(d.pattern)) return errors.push(`${at} must be an object with a "pattern" string`);
    for (const k of ["reason", "flags"]) if (d[k] !== undefined && !isStr(d[k])) errors.push(`${at}.${k} must be a string`);
    try { new RegExp(d.pattern, isStr(d.flags) ? d.flags : "i"); }
    catch (e) { errors.push(`${at}.pattern does not compile: ${e.message}`); }
  });
  return errors;
}

export function readProjectConfig(repo) {
  const file = path.join(String(repo), ".claude", "night-shift.json");
  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { return e.code === "ENOENT" ? { config: {}, errors: [] } : { config: {}, errors: [`cannot be read: ${e.message}`] }; }
  let raw;
  try { raw = JSON.parse(text.replace(/^\uFEFF/, "")); }
  catch (e) { return { config: {}, errors: [`not valid JSON (${e.message})`] }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { config: {}, errors: ["must be a JSON object"] };
  const config = {}, errors = [];
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_") || k.startsWith("$")) continue; // a comment
    if (!Object.hasOwn(CONFIG_KEYS, k)) { errors.push(`unknown key "${k}"`); continue; }
    // A scalar check returns text for after the key's name; deny returns whole messages.
    const bad = k === "deny" ? denyErrors(v) : [CONFIG_KEYS[k](v)].filter(Boolean).map((m) => `"${k}" ${m}`);
    if (bad.length) errors.push(...bad); else config[k] = v;
  }
  return { config, errors };
}

// The runner writes into the state folder, trusts inbox.md and next-prompt.md there as
// instructions, and the guard lets a night session write into it: so never a folder that holds
// anything else the user owns.
export function stateDirProblem(dir, { home = os.homedir(), repo = "", temp = tempRoot() } = {}) {
  const d = norm(dir);
  if (!d) return "is empty";
  if (d.replace(/^\/\/|^[a-z]:/, "").split("/").filter(Boolean).length < 2) return "is a drive root or sits directly below one";
  for (const [name, p] of [["the home folder", home], ["the repository", repo], ["the temp folder", temp], ["C:/temp", "c:/temp"]]) {
    if (p && under(norm(p), d)) return `is, or holds, ${name}`;
  }
  if (repo && under(d, `${norm(repo)}/.git`)) return "is inside .git";
  if (home && under(d, `${norm(home)}/.claude`)) return "is inside ~/.claude";
  // The guard lets a night session write into the state folder, so not where Windows runs things from:
  // the Startup folder lives in AppData\Roaming, and the system's own folders hold programs.
  if (home && under(d, `${norm(home)}/appdata`) && !under(d, norm(temp))) return "is inside AppData, outside the temp folder";
  if (/^c:\/(windows|program files[^/]*|programdata)(\/|$)/.test(d)) return "is inside a system or program folder";
  return null;
}
