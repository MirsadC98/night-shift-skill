// node --test effort.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptEffort, promptDirectives, sessionPlan, directiveLines, fableGate, nightModelSettings, familyOf, resolveMode, mainGate, fallbackNote } from "./effort.mjs";

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
  assert.deepEqual(sessionPlan("Go on.", run), { model: "opus", family: "opus", effort: "xhigh", body: "Go on.", asked: null, askedEffort: null, note: null });
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

const pick = (p) => ({ model: p.model, family: p.family, effort: p.effort, askedEffort: p.askedEffort });
test("resolveMode: the mode, the main model and the Opus that stands in", () => {
  assert.deepEqual(resolveMode({}), { mode: "opus", model: "opus", opusModel: "opus" });
  assert.deepEqual(resolveMode({ model: "claude-opus-5-5" }), { mode: "opus", model: "claude-opus-5-5", opusModel: "claude-opus-5-5" });
  assert.deepEqual(resolveMode({ model: "sonnet" }), { mode: "opus", model: "sonnet", opusModel: "opus" });
  assert.deepEqual(resolveMode({ model: "fable" }), { mode: "fable", model: "fable", opusModel: "opus" });
  assert.deepEqual(resolveMode({ mode: "fable" }), { mode: "fable", model: "fable", opusModel: "opus" });
  assert.deepEqual(resolveMode({ mode: "fable", model: "claude-fable-5-2" }), { mode: "fable", model: "claude-fable-5-2", opusModel: "opus" });
  assert.deepEqual(resolveMode({ mode: "fable", model: "claude-opus-5-5" }), { mode: "fable", model: "fable", opusModel: "claude-opus-5-5" });
  assert.match(resolveMode({ mode: "opus", model: "fable" }).error, /mode "opus".*"fable"/);
  assert.match(resolveMode({ mode: "fable", model: "sonnet" }).error, /"sonnet"/);
});
test("sessionPlan in fable mode: Fable at the run's level, MODEL: opus on the stand-in at xhigh, a prompt's EFFORT wins", () => {
  const run = { mode: "fable", model: "fable", opusModel: "claude-opus-5-5", effort: "high" };
  assert.deepEqual(pick(sessionPlan("piece", run)), { model: "fable", family: "fable", effort: "high", askedEffort: null });
  assert.deepEqual(pick(sessionPlan("MODEL: fable\npiece", run)), { model: "fable", family: "fable", effort: "high", askedEffort: null });
  assert.deepEqual(pick(sessionPlan("MODEL: opus\npiece", run)), { model: "claude-opus-5-5", family: "opus", effort: "xhigh", askedEffort: null });
  assert.deepEqual(pick(sessionPlan("EFFORT: max\npiece", run)), { model: "fable", family: "fable", effort: "max", askedEffort: "max" });
});
test("sessionPlan in fable mode: a MODEL the runner does not run stays on Fable and says so", () => {
  const p = sessionPlan("MODEL: sonnet\nX", { mode: "fable", model: "fable", opusModel: "opus", effort: "high" });
  assert.equal(p.model, "fable");
  assert.match(p.note, /MODEL: sonnet is not a model the runner runs.*it runs on fable/);
});
test("sessionPlan without a mode (a run.json from before modes) is today's", () => {
  assert.deepEqual(pick(sessionPlan("piece", { model: "fable", effort: "xhigh" })), { model: "fable", family: "fable", effort: "high", askedEffort: null });
  assert.deepEqual(pick(sessionPlan("MODEL: fable\npiece", { model: "opus", effort: "xhigh" })), { model: "fable", family: "fable", effort: "high", askedEffort: null });
});
test("mainGate: out until the reset, the ceiling, and never the count", () => {
  const now = 1_000_000;
  assert.deepEqual(mainGate({ outUntil: now + 1 }, { now }), { ok: false, why: "out", until: now + 1 });
  assert.equal(mainGate({ outUntil: now - 1 }, { now }).ok, true);
  assert.deepEqual(mainGate({ ratio: 0.6 }, { ceiling: 0.6, now }), { ok: false, why: "ceiling", ratio: 0.6, ceiling: 0.6 });
  assert.equal(mainGate({ ratio: 0.9, ratioResetsAt: (now - 1) / 1000 }, { now }).ok, true);   // the share is stale after its reset
  assert.equal(mainGate({ sessions: 99 }, { now }).ok, true);
});
test("fallbackNote says why and never names max", () => {
  const n = fallbackNote("its allowance is at 65%, at or over the 60% ceiling");
  assert.match(n, /main model is Fable/); assert.match(n, /65%/); assert.doesNotMatch(n, /\bmax\b/);
});
