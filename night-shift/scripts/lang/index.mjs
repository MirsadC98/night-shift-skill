// The language tables for everything the user reads, and the choice between them.
//   strings(lang)           the table for lang; a language it has none for reads English
//   langOf(run, home)       run.lang, else the config files' lang for run.repo, else "en"
import os from "node:os";
import { LANGS, mergedConfig, readGlobalConfig } from "../config.mjs";
import en from "./en.mjs";
import tr from "./tr.mjs";

const TABLES = { en, tr };
export const LANG_NAMES = { en: "English", tr: "Turkish" };

export const strings = (lang = "en") => TABLES[lang] || en;

// A run.json from before the language was a setting has no lang: the files are read as they are now.
// A bad config file is `start`'s to report; here its valid keys count and the rest is ignored.
export function langOf(run = {}, home = os.homedir()) {
  if (LANGS.includes(run.lang)) return run.lang;
  const { config } = run.repo ? mergedConfig(run.repo, home) : readGlobalConfig(home);
  return LANGS.includes(config.lang) ? config.lang : "en";
}
