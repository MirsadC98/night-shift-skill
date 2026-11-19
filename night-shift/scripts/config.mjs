// The one reader of a project's .claude/night-shift.json, for the runner and the guard, so that a
// typo is named at start instead of ending a run at 3 a.m. (or silently switching a rule off), and
// so that a state folder too wide to be a state folder is refused by both. Imports only node.
//   readProjectConfig(repo) -> { config, errors }   never throws; config holds only the valid keys
//   readGlobalConfig(home)  -> { config, errors }   the same for ~/.claude/night-shift/config.json (run-wide keys only)
//   mergedConfig(repo, home) -> { config, from, errors }  the global file overlaid key by key with the project's (from: key -> file)
//   stateDirProblem(dir, { home, repo, temp, env }) null, or why dir may not be the state folder
//   claudeHome(home, env) -> CLAUDE_CONFIG_DIR's folder when set, else <home>/.claude
//   isMain(import.meta)                              whether node was started with this script (night-chain, night-report, guard)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// Whether node was started with the module whose import.meta this is, or imported it. import.meta.main
// where Node has it (22.18, 24.2 on); else the real paths of process.argv[1] and the module compared,
// since Node gives import.meta.url the real path and keeps argv[1] as typed: through a linked
// ~/.claude the text compare took each script for imported, and the guard let every call pass. When
// the paths differ as typed and one cannot be resolved, unknown is the answer (the guard's is true).
export function isMain(meta, argv1 = process.argv[1], { unknown = false } = {}) {
  if (typeof meta.main === "boolean") return meta.main;
  if (!argv1) return false;
  const self = fileURLToPath(meta.url), started = path.resolve(argv1);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (same(started, self)) return true;
  try { return same(fs.realpathSync.native(started), fs.realpathSync.native(self)); } catch { return unknown; }
}

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
// A server's part of its tools' names (mcp__<it>__<tool>): the CLI puts _ for what is not a letter, a digit, _ or -,
// so "plugin:context7:context7" names tools mcp__plugin_context7_context7__… (the guard and mcp.mjs compare in this form).
export const mcpToolName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, "_");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// The run's main model: Opus, or Fable or Mythos, which are one model under two names (effort.mjs, resolveMode).
export const MODES = ["opus", "fable", "mythos"];
// A language code names a table (lang/index.mjs): en, or the user's own ~/.claude/night-shift/lang/<code>.mjs.
// Only its shape is checked here, which also keeps a path out of it: this module runs inside the guard too,
// where a missing table must not turn every command into a refusal. `start` checks that the table loads.
export const isLangCode = (v) => typeof v === "string" && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(v);
// Each check returns null when the value is fine, else the text that follows the key's name.
// `deny` is checked rule by rule in denyErrors.
export const CONFIG_KEYS = {
  stateDir: (v) => (isStr(v) ? null : "must be a string"),
  report: (v) => (isStr(v) ? null : "must be a string"),
  lessons: (v) => (isStr(v) ? null : "must be a string"),
  model: (v) => (isStr(v) ? null : "must be a string"),
  mode: (v) => (MODES.includes(v) ? null : `must be one of ${MODES.join(", ")}`),
  lang: (v) => (isLangCode(v) ? null : "must be a language code in lowercase, such as en or pt-br (a table at ~/.claude/night-shift/lang/<code>.mjs)"),
  effort: (v) => (EFFORTS.includes(v) ? null : `must be one of ${EFFORTS.join(", ")}`),
  fableCeiling: (v) => (typeof v === "number" && v > 0 && v <= 100 ? null : "must be a number above 0 and at most 100"),
  fableSessions: (v) => (Number.isInteger(v) && v >= 0 ? null : "must be a whole number, 0 or more"),
  maxWaitHours: (v) => (typeof v === "number" && v > 0 ? null : "must be a number above 0"),
  weeklyCeiling: (v) => (typeof v === "number" && v > 0 && v <= 100 ? null : "must be a number above 0 and at most 100"),
  maxUsd: (v) => (typeof v === "number" && v > 0 && Number.isFinite(v) ? null : "must be a number of dollars above 0"),
  attended: (v) => (typeof v === "boolean" ? null : "must be true or false"),
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

// Both files go through one reader. `allowed` limits the keys a file may hold: a known key outside it is
// named as belonging elsewhere, so a project-only setting in the global file is not silently applied to every repo.
function readConfigFile(file, allowed) {
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
    if (allowed && !allowed.includes(k)) { errors.push(`"${k}" belongs in a project's .claude/night-shift.json`); continue; }
    // A scalar check returns text for after the key's name; deny returns whole messages.
    const bad = k === "deny" ? denyErrors(v) : [CONFIG_KEYS[k](v)].filter(Boolean).map((m) => `"${k}" ${m}`);
    if (bad.length) errors.push(...bad); else config[k] = v;
  }
  return { config, errors };
}

// The folder Claude Code keeps its settings, skills and transcripts in: CLAUDE_CONFIG_DIR when the user set it,
// else ~/.claude. The user's night-shift folder (config, rules, language tables, Telegram, the runs) lives in it.
export const claudeHome = (home = os.homedir(), env = process.env) =>
  (env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(String(home), ".claude"));

export const projectConfigFile = (repo) => path.join(String(repo), ".claude", "night-shift.json");
export const readProjectConfig = (repo) => readConfigFile(projectConfigFile(repo));

// Only what is about the run as a whole; anything that names a path or a rule of one repository stays per project.
export const GLOBAL_KEYS = ["mode", "lang", "effort", "fableCeiling", "fableSessions", "maxWaitHours", "weeklyCeiling", "maxUsd", "attended"];
export const globalConfigFile = (home = os.homedir()) => path.join(claudeHome(home), "night-shift", "config.json");
export const readGlobalConfig = (home = os.homedir()) => readConfigFile(globalConfigFile(home), GLOBAL_KEYS);

export function mergedConfig(repo, home = os.homedir()) {
  const files = [[globalConfigFile(home), readGlobalConfig(home)], [projectConfigFile(repo), readProjectConfig(repo)]];
  // from: the file that gave each key, for a message about two keys that may come from different layers.
  return {
    config: Object.assign({}, ...files.map(([, r]) => r.config)),
    from: Object.assign({}, ...files.map(([file, r]) => Object.fromEntries(Object.keys(r.config).map((k) => [k, file])))),
    errors: files.flatMap(([file, r]) => r.errors.map((e) => `${file}: ${e}`)),
  };
}

// The runner writes into the state folder, trusts inbox.md and next-prompt.md there as
// instructions, and the guard lets a night session write into it: so never a folder that holds
// anything else the user owns.
export function stateDirProblem(dir, { home = os.homedir(), repo = "", temp = tempRoot(), env = process.env } = {}) {
  const d = norm(dir);
  if (!d) return "is empty";
  if (d.replace(/^\/\/|^[a-z]:/, "").split("/").filter(Boolean).length < 2) return "is a drive root or sits directly below one";
  // CLAUDE_CONFIG_DIR's folder, wherever it is (claudeHome); null when it is ~/.claude, which the lines below cover.
  const claude = home && env.CLAUDE_CONFIG_DIR ? claudeHome(home, env) : null;
  for (const [name, p] of [["the home folder", home], ["the repository", repo], ["the temp folder", temp], ["C:/temp", "c:/temp"], ["the Claude folder", claude]]) {
    if (p && under(norm(p), d)) return `is, or holds, ${name}`;
  }
  if (repo && under(d, `${norm(repo)}/.git`)) return "is inside .git";
  if (home && under(d, `${norm(home)}/.claude`)) return "is inside ~/.claude";
  if (claude && under(d, norm(claude))) return "is inside the Claude folder (CLAUDE_CONFIG_DIR)";
  // The guard lets a night session write into the state folder, so not where Windows runs things from:
  // the Startup folder lives in AppData\Roaming, and the system's own folders hold programs.
  if (home && under(d, `${norm(home)}/appdata`) && !under(d, norm(temp))) return "is inside AppData, outside the temp folder";
  if (/^c:\/(windows|program files[^/]*|programdata)(\/|$)/.test(d)) return "is inside a system or program folder";
  return null;
}
