// node --test effort.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptEffort, nightModelSettings } from "./effort.mjs";

test("promptEffort reads a first-line EFFORT: max and keeps the rest of the prompt", () => {
  assert.deepEqual(promptEffort("EFFORT: max\n\nFix the drift."), { effort: "max", body: "Fix the drift." });
  assert.deepEqual(promptEffort("effort: XHIGH\nGo on.", "high"), { effort: "xhigh", body: "Go on." });
  // A reason on the same line stays in the prompt.
  assert.deepEqual(promptEffort("EFFORT: max — two fixes failed\nFix it."), { effort: "max", body: "two fixes failed\nFix it." });
  // Anywhere else, or another level, it is just text.
  assert.deepEqual(promptEffort("Go on.\nEFFORT: max"), { effort: "xhigh", body: "Go on.\nEFFORT: max" });
  assert.deepEqual(promptEffort("EFFORT: high\nGo on."), { effort: "xhigh", body: "EFFORT: high\nGo on." });
  assert.deepEqual(promptEffort("EFFORT: maximal\nGo on."), { effort: "xhigh", body: "EFFORT: maximal\nGo on." });
});

test("nightModelSettings levels every Opus, Sonnet and Haiku key, the lower files' too, and leaves the rest", () => {
  const lower = [{ modelSettings: { "claude-opus-5-5": { effortLevel: "high" }, "claude-fable-5-2": { effortLevel: "medium" } } },
    { modelSettings: { "claude-haiku-5-5": { effortLevel: "low" } } }];
  assert.deepEqual(nightModelSettings({ sonnet: { effortLevel: "medium", extra: 1 } }, lower, "xhigh"), {
    opus: { effortLevel: "xhigh" }, "claude-opus-5-5": { effortLevel: "xhigh" },
    sonnet: { effortLevel: "medium", extra: 1 }, haiku: { effortLevel: "high" }, "claude-haiku-5-5": { effortLevel: "high" } });
  // Settings refuse max: the layer keeps xhigh and the session gets --effort max.
  assert.equal(nightModelSettings({}, [], "max").opus.effortLevel, "xhigh");
});
