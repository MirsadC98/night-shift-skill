// The user's rule files: free text in ~/.claude/night-shift/rules.md (global) and
// <repo>/.claude/night-shift-rules.md (project), which the runner puts into every session's header
// where they win over the skill's defaults. Imports only node.
//   ruleFiles(repo, home)  -> { global, project }   the two paths
//   readRuleFile(file)     -> { text } | { error }  never throws; text is "" for a missing or blank file
//   rulesBlock({ global, project }) -> the header's block, "" when both are empty

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeHome } from "./config.mjs";

// Every session reads the header on every call; a file over this is a mistake (a pasted log), not rules.
export const RULES_MAX_BYTES = 8192;

export const ruleFiles = (repo, home = os.homedir()) => ({
  global: path.join(claudeHome(home), "night-shift", "rules.md"),
  project: path.join(repo, ".claude", "night-shift-rules.md"),
});

// What an editor may have saved: UTF-8 with or without a BOM, or Notepad's "Unicode" (UTF-16). Anything
// else (an ANSI file with letters outside ASCII) would reach the header as replacement characters, so it is refused.
function decode(bytes) {
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function readRuleFile(file) {
  let bytes;
  try {
    // The size is checked before reading: the limit is the file's bytes on disk, a BOM and CRLF included.
    const size = fs.statSync(file).size;
    if (size > RULES_MAX_BYTES) return { error: `is ${size} bytes, over the ${RULES_MAX_BYTES} limit` };
    bytes = fs.readFileSync(file);
  } catch (e) {
    return e.code === "ENOENT" || e.code === "ENOTDIR" ? { text: "" } : { error: `cannot be read: ${e.message}` };
  }
  // The file may have grown between the stat and the read.
  if (bytes.length > RULES_MAX_BYTES) return { error: `is ${bytes.length} bytes, over the ${RULES_MAX_BYTES} limit` };
  let text;
  try { text = decode(bytes); } catch { return { error: "cannot be read: it is not UTF-8 text (save it as UTF-8)" }; }
  return { text: text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim() };
}

export function rulesBlock({ global = "", project = "" }) {
  if (!global && !project) return "";
  return ["The user's rules. They win over this skill's defaults where the two differ; the project's win over the global ones. What the guard refuses stays refused.",
    ...(global ? ["Global:", global] : []), ...(project ? ["This project:", project] : [])].join("\n");
}
