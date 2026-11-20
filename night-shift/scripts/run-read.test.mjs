// What a state folder's files say, read by night-report.mjs and dashboard.mjs alike. node --test scripts/run-read.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempRoot } from "./config.mjs";
import { parseSession, pointerOf, stopWaits, stopItems } from "./run-read.mjs";
import { strings } from "./lang/index.mjs";
import { reached } from "./fixtures/imports.mjs";
// A CLAUDE_CONFIG_DIR of the user's own would move every file these tests read or write (claudeHome in config.mjs).
delete process.env.CLAUDE_CONFIG_DIR;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const line = (j) => JSON.stringify(j);
const SID = "00000000-0000-4000-8000-000000000101";
const tmp = (name) => fs.mkdtempSync(path.join(tempRoot(), `run-read-${name}-`));

test("run-read.mjs reaches neither entry module", () => {
  const names = [...reached(path.join(HERE, "run-read.mjs"))].map((f) => path.basename(f));
  assert.ok(names.includes("config.mjs"), names.join(", "));
  assert.ok(!names.includes("night-report.mjs") && !names.includes("night-chain.mjs"), names.join(", "));
});

test("parseSession hands its parsed lines over only when asked", () => {
  const state = tmp("lines");
  fs.writeFileSync(path.join(state, "run.json"), line({ claudeConfigDir: path.join(state, "claude"), lang: "en" }));
  fs.writeFileSync(path.join(state, "session-01.jsonl"), [
    line({ type: "system", subtype: "init", session_id: SID }),
    line({ type: "assistant", session_id: SID, message: { id: "msg_1", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 5 } } }),
    line({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: SID, total_cost_usd: 0.5, modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5 } } }),
    "",
  ].join("\n"));
  const withLines = parseSession(state, "01", { lines: true });
  const without = parseSession(state, "01");
  assert.equal(withLines.entries.length, 3);
  assert.equal(withLines.sid, SID);
  assert.ok(Array.isArray(withLines.mainEntries));
  assert.ok("base" in withLines);
  assert.equal("entries" in without, false);
  assert.deepEqual(withLines.rows, without.rows);
  assert.deepEqual(withLines.result, without.result);
});

test("pointerOf finds a state folder's pointer in the run's own Claude folder", () => {
  const base = tmp("pointer");
  const claude = path.join(base, "claude"), runs = path.join(claude, "night-shift", "runs");
  const state = path.join(base, "state"), other = path.join(base, "other"), none = path.join(base, "none");
  for (const d of [runs, state, other, none]) fs.mkdirSync(d, { recursive: true });
  for (const d of [state, other, none]) fs.writeFileSync(path.join(d, "run.json"), line({ claudeConfigDir: claude }));
  fs.writeFileSync(path.join(runs, "a-1.json"), "{ not json");
  fs.writeFileSync(path.join(runs, "b-2.json"), line({ state: other, pid: 7 }));
  fs.writeFileSync(path.join(runs, "c-3.json"), line({ state, pid: 42, finished: false }));
  const p = pointerOf(state);
  assert.equal(p.pid, 42);
  assert.equal(p.file, path.join(runs, "c-3.json"));
  assert.equal(pointerOf(other).pid, 7);
  assert.equal(pointerOf(none), null);
});

test("stopWaits reads a STOP prompt's body without its heading", () => {
  const T = strings("en");
  assert.deepEqual(stopWaits("STOP: done\n**Waits for you**\n- a\n- b", T), ["- a", "- b"]);
  assert.deepEqual(stopWaits("STOP: done", T), []);
  assert.equal(stopWaits("go on", T), null);
});

test("stopItems counts what a STOP prompt lists, never its prose", () => {
  const T = strings("en");
  // 2026-11-20, a real chain's last prompt (in the run's language there): one closing sentence that says nothing waits was shown as the one thing waiting
  assert.deepEqual(stopItems("STOP: the plan is done\n\nBoth pieces of the plan are done: `23b37d4` notes: piece one, the night report `090d978`. Nothing waits for you.", T), []);
  assert.deepEqual(stopItems("STOP: done\n\nAll three pieces are committed.\nNothing waits for you.\n\n**Remaining:** 0", T), []);
  assert.deepEqual(stopItems("STOP: done", T), []);
  assert.equal(stopItems("go on", T), null);
  // a list is its items, each with the indented lines under it; the prose around it is none
  assert.deepEqual(stopItems("STOP: done\n\nThe last piece is in.\n\nWaiting on you:\n- push the branch,\n  12 commits\n* approve the notes\n2) the key\n\n**Remaining:** 0", T),
    ["push the branch, 12 commits", "approve the notes", "the key"]);
  assert.deepEqual(stopItems("STOP: done\r\n**Waits for you**\r\n- a\r\n- b\r\n", T), ["a", "b"]);
  // the night report's own word for nothing ("- New: none.", SKILL.md) is no item in a STOP prompt either; an item that only starts with it is
  assert.deepEqual(stopItems("STOP: done\n**Waits for you**\n- New: none.\n\n**Remaining:** 0", T), []);
  assert.deepEqual(stopItems("STOP: done\n- **None**\n", T), []);
  assert.deepEqual(stopItems("STOP: done\n- none of the keys work: send a new one\n- New: none yet, but read `a.md`", T), ["none of the keys work: send a new one", "New: none yet, but read `a.md`"]);
  // without a list, the lines under the list's heading are the items: a session that wrote the heading says something waits
  assert.deepEqual(stopItems("STOP: done\n**Waits for you**\nCheck the logs.", T), ["Check the logs."]);
  assert.deepEqual(stopItems("STOP: done\n\nThe deploy key is in place.\n\nWaiting for the user:\n\nCheck the logs.\nApprove the push.\n\n**Remaining:** 0\n", T), ["Check the logs.", "Approve the push."]);
});
