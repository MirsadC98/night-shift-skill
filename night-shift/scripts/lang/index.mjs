// The language tables for everything the user reads, and the choice between them.
// en.mjs ships with the skill. Any other language is a table the user owns, ~/.claude/night-shift/lang/<code>.mjs:
// a module whose default export has en.mjs's keys. A key it lacks, or holds with the wrong kind of value,
// reads English, so a table written for an older version keeps working. The table is code the runner and
// the watcher run, like a hook; a night session cannot write it (guard.mjs protects ~/.claude/night-shift/).
//   langFile(code, home)    where the user's table for code lives
//   loadLang(code, home)    loads that table once, when a script starts: { table, file } or { error, file }
//   strings(code)           the table loadLang loaded for code; a code nothing loaded reads English
//   langOf(run, home)       run.lang, else the config files' lang for run.repo, else "en"
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isLangCode, mergedConfig, readGlobalConfig, claudeHome } from "../config.mjs";
import en from "./en.mjs";

const loaded = new Map([["en", en]]);

export const langFile = (code, home = os.homedir()) => path.join(claudeHome(home), "night-shift", "lang", `${code}.mjs`);

const isTable = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
// English's keys, each with the user's value where it has the same kind; a nested group (ev, note, cli) key by key.
const overEnglish = (user, base = en) => Object.fromEntries(Object.entries(base).map(([k, v]) => {
  const u = Object.hasOwn(user, k) ? user[k] : undefined;
  if (isTable(v)) return [k, overEnglish(isTable(u) ? u : {}, v)];
  return [k, u !== undefined && typeof u === typeof v ? u : v];
}));

export async function loadLang(code, home = os.homedir()) {
  if (code === "en") return { table: en };
  if (!isLangCode(code)) return { error: `"${code}" is not a language code` };
  const file = langFile(code, home);
  if (!fs.existsSync(file)) return { error: `no language table at ${file}`, file };
  let mod;
  try { mod = await import(pathToFileURL(file).href); }
  catch (e) { return { error: `${file} does not load: ${String(e?.message ?? e).split("\n")[0]}`, file }; }
  if (!isTable(mod.default)) return { error: `${file} exports no table (export default { … })`, file };
  const table = overEnglish(mod.default);
  // The session header names the language; without a name of its own the code says it better than "English".
  if (typeof mod.default.name !== "string" || !mod.default.name.trim()) table.name = code;
  // Telegram takes 1 to 32 lowercase letters, digits or _ for a command, and each name must answer one thing.
  const cmd = (c) => /^[a-z0-9_]{1,32}$/.test(c);
  const names = [table.cmdStatus, table.cmdReport];
  if (!names.every(cmd) || names[0] === names[1] || names[0] === en.cmdReport || names[1] === en.cmdStatus)
    Object.assign(table, { cmdStatus: en.cmdStatus, cmdReport: en.cmdReport });
  // A description takes 1 to 256 characters; one it refuses fails the whole menu, so it reads English, each on its own.
  for (const k of ["cmdStatusDesc", "cmdReportDesc"]) if (!table[k].trim() || table[k].length > 256) table[k] = en[k];
  loaded.set(code, table);
  return { table, file };
}

export const strings = (code = "en") => loaded.get(code) || en;

// A run.json from before the language was a setting has no lang: the files are read as they are now.
// A bad config file is `start`'s to report; here its valid keys count and the rest is ignored.
export function langOf(run = {}, home = os.homedir()) {
  if (isLangCode(run.lang)) return run.lang;
  const { config } = run.repo ? mergedConfig(run.repo, home) : readGlobalConfig(home);
  return isLangCode(config.lang) ? config.lang : "en";
}
