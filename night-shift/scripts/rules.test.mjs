// The user's rule files. node --test rules.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RULES_MAX_BYTES, ruleFiles, readRuleFile, rulesBlock } from "./rules.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "night-rules-test-"));
let n = 0;
// A rules file with exactly these bytes on disk (a string is written as UTF-8).
const fileOf = (content) => { const f = path.join(dir, `rules-${n++}.md`); fs.writeFileSync(f, content); return f; };

test("the two files sit where the user is told to put them", () => {
  const home = path.join(dir, "home"), repo = path.join(dir, "repo");
  assert.equal(RULES_MAX_BYTES, 8192);
  assert.deepEqual(ruleFiles(repo, home), {
    global: path.join(home, ".claude", "night-shift", "rules.md"),
    project: path.join(repo, ".claude", "night-shift-rules.md"),
  });
});

test("the limit counts bytes, and exactly 8192 passes", () => {
  assert.equal(readRuleFile(fileOf("a".repeat(8192))).text.length, 8192);
  assert.equal(readRuleFile(fileOf("a".repeat(8193))).error, "is 8193 bytes, over the 8192 limit");
  assert.equal(readRuleFile(fileOf("ş".repeat(4097))).error, "is 8194 bytes, over the 8192 limit");
  assert.equal(readRuleFile(fileOf("ş".repeat(4096))).text.length, 4096);
});

test("the limit is the file's bytes on disk: a BOM and CRLF count, even though they are stripped", () => {
  assert.equal(readRuleFile(fileOf(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from("a".repeat(8190))]))).error, "is 8193 bytes, over the 8192 limit");
  assert.equal(readRuleFile(fileOf("a\r\n".repeat(2731))).error, "is 8193 bytes, over the 8192 limit");
});

test("a BOM and CRLF do not reach the header", () => assert.equal(readRuleFile(fileOf("\uFEFFa\r\nb\r\n")).text, "a\nb"));

test("a missing or blank file is no rules, not an error", () => {
  assert.deepEqual(readRuleFile(path.join(dir, "none.md")), { text: "" });
  assert.deepEqual(readRuleFile(fileOf(" \r\n\t")), { text: "" });
  assert.deepEqual(readRuleFile(fileOf("")), { text: "" });
});

test("a file that cannot be read is an error that says why", () => {
  const folder = path.join(dir, "a-folder.md");
  fs.mkdirSync(folder);
  assert.match(readRuleFile(folder).error, /^cannot be read: .+/);
});

test("rulesBlock: both parts, one part, none", () => {
  assert.equal(rulesBlock({ global: "g", project: "p" }),
    "The user's rules. They win over this skill's defaults where the two differ; the project's win over the global ones. What the guard refuses stays refused.\nGlobal:\ng\nThis project:\np");
  assert.doesNotMatch(rulesBlock({ project: "p" }), /Global:/);
  assert.doesNotMatch(rulesBlock({ global: "g" }), /This project:/);
  assert.equal(rulesBlock({}), "");
  assert.equal(rulesBlock({ global: "", project: "" }), "");
});

test("a file saved as UTF-16 (Notepad's \"Unicode\") reads as its text; one that is no Unicode text is refused", () => {
  assert.equal(readRuleFile(fileOf(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from("ş\r\nb", "utf16le")]))).text, "ş\nb");
  assert.equal(readRuleFile(fileOf(Buffer.concat([Buffer.from([0xFE, 0xFF]), Buffer.from("ş\r\nb", "utf16le").swap16()]))).text, "ş\nb");
  assert.match(readRuleFile(fileOf(Buffer.from([0x61, 0xFE, 0x62]))).error, /^cannot be read: it is not UTF-8 text/);
});
