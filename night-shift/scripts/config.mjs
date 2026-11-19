// The one reader of a project's .claude/night-shift.json, for the runner and the guard, so that a
// typo is named at start instead of ending a run at 3 a.m. (or silently switching a rule off), and
// so that a state folder too wide to be a state folder is refused by both. Imports only node, platform.mjs
// and effort.mjs (the model table, which imports nothing).
//   readProjectConfig(repo) -> { config, errors }   never throws; config holds only the valid keys
//   readGlobalConfig(home)  -> { config, errors }   the same for ~/.claude/night-shift/config.json (run-wide keys only)
//   mergedConfig(repo, home, flags) -> { config, from, errors }  the global file overlaid key by key with the project's (from: key -> file);
//                                                     a project's file may lower the four allowance caps, never raise them,
//                                                     unless flags (start's, by name) sets that cap itself
//   stateDirProblem(dir, { home, repo, temp, env, platform })  null, or why dir may not be the state folder
//   claudeHome(home, env) -> CLAUDE_CONFIG_DIR's folder when set, else <home>/.claude
//   isMain(import.meta)                              whether node was started with this script (night-chain, night-report, guard)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { platform as live } from "./platform.mjs";
import { MODELS, LEVELS } from "./effort.mjs";

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

// The temp folder in long form, and a path the way the system resolves it (platform.mjs, which says how): the
// runner, the guard and the tests take both from here.
export const tempRoot = live.tempRoot;
export const norm = live.norm;
const under = (p, root) => root && (p === root || p.startsWith(root + "/"));

const isStr = (v) => typeof v === "string";
// A server's part of its tools' names (mcp__<it>__<tool>): the CLI puts _ for what is not a letter, a digit, _ or -,
// so "plugin:context7:context7" names tools mcp__plugin_context7_context7__… (the guard and mcp.mjs compare in this form).
export const mcpToolName = (name) => String(name).replace(/[^A-Za-z0-9_-]/g, "_");
// The run's main model: Opus, or Fable or Mythos, which are one model under two names (effort.mjs, resolveMode).
export const MODES = MODELS;
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
  effort: (v) => (LEVELS.includes(v) ? null : `must be one of ${LEVELS.join(", ")}`),
  fableCeiling: (v) => (typeof v === "number" && v > 0 && v <= 100 ? null : "must be a number above 0 and at most 100"),
  fableSessions: (v) => (Number.isInteger(v) && v >= 0 ? null : "must be a whole number, 0 or more"),
  maxWaitHours: (v) => (typeof v === "number" && v > 0 ? null : "must be a number above 0"),
  weeklyCeiling: (v) => (typeof v === "number" && v > 0 && v <= 100 ? null : "must be a number above 0 and at most 100"),
  maxUsd: (v) => (typeof v === "number" && v > 0 && Number.isFinite(v) ? null : "must be a number of dollars above 0"),
  attended: (v) => (typeof v === "boolean" ? null : "must be true or false"),
  worktree: (v) => (typeof v === "boolean" ? null : "must be true or false"),
  telegramInbox: (v) => (typeof v === "boolean" ? null : "must be true or false"),
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
// `refused` names keys only the user's own global file may hold (GLOBAL_ONLY).
function readConfigFile(file, allowed, refused = []) {
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
    if (refused.includes(k)) { errors.push(`"${k}" belongs in the user's own ${globalConfigFile()}, not in a project's file`); continue; }
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
export const readProjectConfig = (repo) => readConfigFile(projectConfigFile(repo), null, GLOBAL_ONLY);

// Only what is about the run as a whole; anything that names a path or a rule of one repository stays per project.
export const GLOBAL_KEYS = ["mode", "lang", "effort", "fableCeiling", "fableSessions", "maxWaitHours", "weeklyCeiling", "maxUsd", "attended", "worktree", "telegramInbox"];
// Who may steer the user's chains is the user's own choice, and a repository's file may come from someone else:
// these keys count only in the global file, and a project's file that holds one is refused.
export const GLOBAL_ONLY = ["telegramInbox"];
export const globalConfigFile = (home = os.homedir()) => path.join(claudeHome(home), "night-shift", "config.json");
export const readGlobalConfig = (home = os.homedir()) => readConfigFile(globalConfigFile(home), GLOBAL_KEYS);

// A repository's file may come from someone else, while a cap in the user's own file is their word: for these keys a
// project's file may lower what applies without it (the global file's value, else the runner's default), never raise
// it. A raise is that file's error, so start refuses and names the flag, which stays the user's own word and wins: with
// the flag given (flags["max-usd"] …), the file's value is not used and not refused.
const CAPS = { fableCeiling: ["fable-ceiling", 0.6], fableSessions: ["fable-sessions", 2], weeklyCeiling: ["weekly-ceiling", Infinity], maxUsd: ["max-usd", Infinity] };
// A share as a ratio (0.6) or a percentage (60), compared as the runner reads it.
const capShare = (k, v) => ((k === "fableCeiling" || k === "weeklyCeiling") && v > 1 ? v / 100 : v);

export function mergedConfig(repo, home = os.homedir(), flags = {}) {
  const global = readGlobalConfig(home), project = readProjectConfig(repo);
  for (const [k, [flag, fallback]] of Object.entries(CAPS)) {
    if (!Object.hasOwn(project.config, k) || flags[flag] !== undefined) continue;
    const own = Object.hasOwn(global.config, k), base = own ? global.config[k] : fallback, v = project.config[k];
    if (capShare(k, v) <= capShare(k, base)) continue;
    delete project.config[k];
    project.errors.push(`"${k}" ${v} is above the ${base} that applies without this file (${own ? "the user's own file" : "the default"}); a project's file may lower it, not raise it: pass --${flag} ${v} to start instead`);
  }
  const files = [[globalConfigFile(home), global], [projectConfigFile(repo), project]];
  // from: the file that gave each key, for a message about two keys that may come from different layers.
  return {
    config: Object.assign({}, ...files.map(([, r]) => r.config)),
    from: Object.assign({}, ...files.map(([file, r]) => Object.fromEntries(Object.keys(r.config).map((k) => [k, file])))),
    errors: files.flatMap(([file, r]) => r.errors.map((e) => `${file}: ${e}`)),
  };
}

// The runner writes into the state folder, trusts inbox.md and next-prompt.md there as
// instructions, and the guard lets a night session write into it: so never a folder that holds
// anything else the user owns. platform: the system whose paths these are (platform.mjs), a test's or the guard's.
export function stateDirProblem(dir, { home = os.homedir(), repo = "", temp = tempRoot(), env = process.env, platform = live } = {}) {
  const { norm } = platform;
  const d = norm(dir);
  if (!d) return "is empty";
  if (d.replace(/^\/\/|^[a-z]:/, "").split("/").filter(Boolean).length < 2) return "is a drive root or sits directly below one";
  // CLAUDE_CONFIG_DIR's folder, wherever it is (claudeHome, resolved by the system's own rules); null when it is
  // ~/.claude, which the lines below cover.
  const claude = home && env.CLAUDE_CONFIG_DIR ? platform.path.resolve(env.CLAUDE_CONFIG_DIR) : null;
  for (const [name, p] of [["the home folder", home], ["the repository", repo], ["the temp folder", temp], ...platform.sharedTemps, ["the Claude folder", claude]]) {
    if (p && under(norm(p), d)) return `is, or holds, ${name}`;
  }
  if (repo && under(d, `${norm(repo)}/.git`)) return "is inside .git";
  if (home && under(d, `${norm(home)}/.claude`)) return "is inside ~/.claude";
  if (claude && under(d, norm(claude))) return "is inside the Claude folder (CLAUDE_CONFIG_DIR)";
  // The guard lets a night session write into the state folder, so not where the system runs things from.
  return platform.systemDirProblem(d, { home, temp });
}
