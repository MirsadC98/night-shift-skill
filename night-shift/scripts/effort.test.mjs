// node --test effort.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptEffort, promptDirectives, sessionPlan, directiveLines, fableGate, nightModelSettings, familyOf } from "./effort.mjs";

test("promptEffort reads a first-line EFFORT line and keeps the rest of the prompt", () => {
  assert.deepEqual(promptEffort("EFFORT: max\n\nFix the drift."), { effort: "max", body: "Fix the drift." });
  assert.deepEqual(promptEffort("effort: XHIGH\nGo on.", "high"), { effort: "xhigh", body: "Go on." });
  // A reason on the same line stays in the prompt.
  assert.deepEqual(promptEffort("EFFORT: max — two fixes failed\nFix it."), { effort: "max", body: "two fixes failed\nFix it." });
  // high is a level too since MODEL: fable (2026-11-15).
  assert.deepEqual(promptEffort("EFFORT: high\nGo on."), { effort: "high", body: "Go on." });
  // Anywhere else, or a word that is no level, it is just text.
  assert.deepEqual(promptEffort("Go on.\nEFFORT: max"), { effort: "xhigh", body: "Go on.\nEFFORT: max" });
  assert.deepEqual(promptEffort("EFFORT: maximal\nGo on."), { effort: "xhigh", body: "EFFORT: maximal\nGo on." });
  assert.deepEqual(promptEffort("EFFORT: low\nGo on."), { effort: "xhigh", body: "EFFORT: low\nGo on." });
});

test("promptDirectives takes MODEL and EFFORT in either order, on one line or two, with a reason", () => {
  assert.deepEqual(promptDirectives("MODEL: fable\nEFFORT: xhigh\nHard piece."), { model: "fable", effort: "xhigh", body: "Hard piece." });
  assert.deepEqual(promptDirectives("EFFORT: max\nMODEL: opus\n\nHard piece."), { model: "opus", effort: "max", body: "Hard piece." });
  assert.deepEqual(promptDirectives("MODEL: fable, EFFORT: high — a race across two subsystems\nFix it."),
    { model: "fable", effort: "high", body: "a race across two subsystems\nFix it." });
  assert.deepEqual(promptDirectives("MODEL: fable — the parser resisted Opus\nFix it."), { model: "fable", effort: null, body: "the parser resisted Opus\nFix it." });
  // Model names are read as written and lowered; "Model:" in a sentence is text.
  assert.deepEqual(promptDirectives("MODEL: Sonnet\nGo."), { model: "sonnet", effort: null, body: "Go." });
  assert.deepEqual(promptDirectives("Model: the parser\nGo."), { model: null, effort: null, body: "Model: the parser\nGo." });
  // A second MODEL line is text: only the first of each counts.
  assert.deepEqual(promptDirectives("MODEL: fable\nMODEL: opus\nGo."), { model: "fable", effort: null, body: "MODEL: opus\nGo." });
  assert.deepEqual(promptDirectives(""), { model: null, effort: null, body: "" });
});

test("sessionPlan: Opus at the run's level, Fable at high, any other model on Opus with a note", () => {
  const run = { model: "opus", effort: "xhigh" };
  assert.deepEqual(sessionPlan("Go on.", run), { model: "opus", family: "opus", effort: "xhigh", body: "Go on.", asked: null, note: null });
  const fable = sessionPlan("MODEL: fable\nHard piece.", run);
  assert.equal(fable.model, "fable");
  assert.equal(fable.effort, "high");
  assert.equal(sessionPlan("MODEL: fable\nEFFORT: max\nX", run).effort, "max");
  assert.equal(sessionPlan("EFFORT: max\nX", run).effort, "max");
  assert.equal(sessionPlan("X", { model: "claude-opus-5-5", effort: "high" }).family, "opus");
  assert.equal(sessionPlan("X", { model: "claude-opus-5-5", effort: "high" }).effort, "high");
  const other = sessionPlan("MODEL: sonnet\nX", run);
  assert.equal(other.model, "opus");
  assert.match(other.note, /MODEL: sonnet is not a model the runner runs/);
  assert.equal(other.body, "X");
  assert.equal(familyOf("claude-fable-5-2"), "fable");
  assert.equal(familyOf(null), "opus");
});

test("directiveLines gives a plan's lines back for a prompt the runner writes anew", () => {
  assert.equal(directiveLines({ model: "fable", effort: "xhigh" }), "MODEL: fable\nEFFORT: xhigh\n");
  assert.equal(directiveLines({ model: null, effort: "max" }), "EFFORT: max\n");
  assert.equal(directiveLines({ model: null, effort: null }), "");
});

test("fableGate: out until the reset, the ceiling while the share is known, the count while it is not", () => {
  const now = Date.parse("2026-11-15T22:00:00Z"), later = now / 1000 + 86_400;
  assert.deepEqual(fableGate({}, { now }), { ok: true, ratio: null });
  assert.deepEqual(fableGate({ sessions: 1 }, { now }), { ok: true, ratio: null });
  assert.equal(fableGate({ sessions: 2 }, { now }).why, "count");
  assert.equal(fableGate({ sessions: 2 }, { now, maxSessions: 3 }).ok, true);
  // A known share decides alone, however many sessions ran.
  assert.deepEqual(fableGate({ sessions: 5, ratio: 0.4, ratioResetsAt: later }, { now }), { ok: true, ratio: 0.4 });
  assert.equal(fableGate({ ratio: 0.6, ratioResetsAt: later }, { now }).why, "ceiling");
  assert.equal(fableGate({ ratio: 0.6, ratioResetsAt: later }, { now, ceiling: 0.7 }).ok, true);
  // Without a reset time the share still counts; after its reset it is unknown again.
  assert.equal(fableGate({ ratio: 0.9 }, { now }).why, "ceiling");
  assert.equal(fableGate({ sessions: 2, ratio: 0.9, ratioResetsAt: now / 1000 - 60 }, { now }).why, "count");
  assert.deepEqual(fableGate({ outUntil: now + 1000, ratio: 0.1 }, { now }), { ok: false, why: "out", until: now + 1000 });
  assert.equal(fableGate({ outUntil: now - 1000 }, { now }).ok, true);
});

test("nightModelSettings levels every Opus, Fable, Sonnet and Haiku key, the lower files' too, and leaves the rest", () => {
  const lower = [{ modelSettings: { "claude-opus-5-5": { effortLevel: "high" }, "claude-fable-5-2": { effortLevel: "medium" } } },
    { modelSettings: { "claude-haiku-5-5": { effortLevel: "low" }, other: { effortLevel: "low" } } }];
  assert.deepEqual(nightModelSettings({ sonnet: { effortLevel: "medium", extra: 1 } }, lower), {
    opus: { effortLevel: "xhigh" }, "claude-opus-5-5": { effortLevel: "xhigh" },
    fable: { effortLevel: "high" }, "claude-fable-5-2": { effortLevel: "high" },
    sonnet: { effortLevel: "medium", extra: 1 }, haiku: { effortLevel: "high" }, "claude-haiku-5-5": { effortLevel: "high" } });
  // A bare level is Opus's, as before; a session's own level goes to its family.
  assert.equal(nightModelSettings({}, [], "high").opus.effortLevel, "high");
  assert.equal(nightModelSettings({}, [], "high").fable.effortLevel, "high");
  assert.equal(nightModelSettings({}, lower, { opus: "xhigh", fable: "xhigh" })["claude-fable-5-2"].effortLevel, "xhigh");
  // Settings refuse max: the layer keeps xhigh and the session gets --effort max.
  assert.equal(nightModelSettings({}, [], "max").opus.effortLevel, "xhigh");
  assert.equal(nightModelSettings({}, [], { fable: "max" }).fable.effortLevel, "xhigh");
});
