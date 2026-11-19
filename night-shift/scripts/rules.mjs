// The user's rule files: free text in ~/.claude/night-shift/rules.md (global) and
// <repo>/.claude/night-shift-rules.md (project), which the runner puts into every session's header
// where they win over the skill's defaults. Imports node and config.mjs (claudeHome, the Claude folder).
//   ruleFiles(repo, home)  -> { global, project }   the two paths
//   readRuleFile(file)     -> { text } | { error }  never throws; text is "" for a missing or blank file, and a
//                                                    comment (a line that starts with <!--, up to -->) reaches no session
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
  return { text: dropComments(text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")).trim() };
}

// C4: a comment is the user's note to themselves, and init's skeleton is one: an untouched file adds nothing to a header.
// A comment starts at a line that begins with <!-- and ends at the first --> after it; the text after that --> stays,
// and is read again: one more comment right after it goes too. A <!-- inside a line or inside a ``` or ~~~ code block is
// text (a rule may be about HTML), and so is one never closed. A code block ends at a bare fence of its character at
// least as long as the one that opened it (CommonMark): a fence with an info string, or a shorter one, is its text.
function dropComments(text) {
  const lines = text.split("\n"), out = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], mark = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (mark) {
      if (fence === null) fence = mark[1];
      else if (mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null;
      out.push(line);
      continue;
    }
    if (fence === null && /^\s*<!--/.test(line)) {
      let end = i, at = line.indexOf("-->", line.indexOf("<!--") + 4);
      while (at < 0 && ++end < lines.length) at = lines[end].indexOf("-->");
      if (at >= 0) {
        const rest = lines[end].slice(at + 3);
        // Another comment on the same line: read the rest again, as a line of its own.
        if (/^\s*<!--/.test(rest)) { lines[end] = rest; i = end - 1; continue; }
        if (rest.trim()) out.push(rest);
        i = end;
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

export function rulesBlock({ global = "", project = "" }) {
  if (!global && !project) return "";
  return ["The user's rules. They win over this skill's defaults where the two differ; the project's win over the global ones. What the guard refuses stays refused.",
    ...(global ? ["Global:", global] : []), ...(project ? ["This project:", project] : [])].join("\n");
}
