// node --test effort.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptEffort, promptDirectives, sessionPlan, directiveLines, fableGate, nightModelSettings, familyOf, resolveMode, mainGate, fallbackNote,
  MODELS, MAIN_EFFORT, cliModel, isPremium, modelName, runModelIds, premiumNote, deniedNote, FABLE_NOTE, runsOn,
  MODEL_TABLE, MAIN_MODEL, SUB_MODEL, PREMIUM, SUB_EFFORT, LEVELS } from "./effort.mjs";
import { MODES } from "./config.mjs";

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
  // A count of 0 (fableSessions: 0) refuses the first ask, before any session wrote a count: none ran.
  assert.deepEqual(fableGate({}, { now, maxSessions: 0 }), { ok: false, why: "count", sessions: 0, maxSessions: 0 });
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
test("fallbackNote for a prompt with its own level names no level and leaves the EFFORT line to that level's note", () => {
  const n = fallbackNote("its allowance is used up", { asked: "max" });
  assert.match(n, /Opus at the level its prompt asked for/); assert.match(n, /without a MODEL line/);
  assert.doesNotMatch(n, /xhigh|EFFORT|\bmax\b/);
  assert.equal(fallbackNote("x", { asked: null }), fallbackNote("x"));
});

// ---------------------------------------------------------------- Mythos (2026-11-18)
// Measured with claude 2.1.327: `--model mythos` is refused before any model call (there is no
// such alias), `--model claude-mythos-5-2` runs and draws on Fable's weekly allowance, and only
// modelSettings keyed by that id set its level. Mythos takes Fable's seat under another name.
const MYTHOS = "claude-mythos-5-2";
test("Mythos is a family of its own, a model the runner runs, and reaches the CLI by its id", () => {
  assert.equal(familyOf(MYTHOS), "mythos");
  assert.equal(familyOf("Mythos"), "mythos");
  assert.ok(MODELS.includes("mythos"));
  assert.deepEqual([cliModel("opus"), cliModel("fable"), cliModel("mythos")], ["opus", "fable", MYTHOS]);
  assert.deepEqual([isPremium("fable"), isPremium("mythos"), isPremium("opus"), isPremium("sonnet")], [true, true, false, false]);
  assert.deepEqual([modelName("mythos"), modelName("fable"), modelName("opus")], ["Mythos", "Fable", "Opus"]);
  assert.equal(MAIN_EFFORT.mythos, "high");
});
test("the Mythos id is written in one place: effort.mjs's table of what --model gets", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const hits = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .flatMap((f) => (fs.readFileSync(path.join(dir, f), "utf8").match(/claude-mythos-[\w-]+/g) || []).map(() => f));
  assert.deepEqual(hits, ["effort.mjs"]);
});
test("sessionPlan in opus mode: MODEL: mythos is MODEL: fable on the other name", () => {
  const run = { mode: "opus", model: "opus", opusModel: "opus", effort: "xhigh" };
  assert.deepEqual(pick(sessionPlan("MODEL: mythos\npiece", run)), { model: MYTHOS, family: "mythos", effort: "high", askedEffort: null });
  assert.equal(sessionPlan("MODEL: Mythos\npiece", run).asked, "mythos");
  assert.equal(sessionPlan("MODEL: mythos\nEFFORT: max\npiece", run).effort, "max");
  assert.equal(sessionPlan("MODEL: mythos\npiece", run).note, null);
  assert.match(sessionPlan("MODEL: sonnet\npiece", run).note, /\(opus, fable, mythos\)/);
});
test("sessionPlan in mythos mode: Mythos at the run's level, MODEL: opus on the stand-in, MODEL: fable stays on Mythos", () => {
  const run = { mode: "mythos", model: MYTHOS, opusModel: "claude-opus-5-5", effort: "high" };
  assert.deepEqual(pick(sessionPlan("piece", run)), { model: MYTHOS, family: "mythos", effort: "high", askedEffort: null });
  assert.deepEqual(pick(sessionPlan("MODEL: mythos\npiece", run)), { model: MYTHOS, family: "mythos", effort: "high", askedEffort: null });
  assert.deepEqual(pick(sessionPlan("MODEL: opus\npiece", run)), { model: "claude-opus-5-5", family: "opus", effort: "xhigh", askedEffort: null });
  assert.deepEqual(pick(sessionPlan("EFFORT: max\npiece", run)), { model: MYTHOS, family: "mythos", effort: "max", askedEffort: "max" });
  assert.equal(sessionPlan("piece", { ...run, effort: "xhigh" }).effort, "xhigh");
  const fable = sessionPlan("MODEL: fable\npiece", run);
  assert.deepEqual(pick(fable), { model: MYTHOS, family: "mythos", effort: "high", askedEffort: null });
  assert.match(fable.note, /MODEL: fable.*same model as Mythos.*runs on claude-mythos-5-2/);
  assert.match(sessionPlan("MODEL: sonnet\npiece", run).note, /MODEL: sonnet is not a model the runner runs.*it runs on claude-mythos-5-2/);
  // A run.json that holds no main model gets the CLI's id, never the bare word.
  assert.equal(sessionPlan("piece", { mode: "mythos" }).model, MYTHOS);
});
test("sessionPlan in fable mode: MODEL: mythos stays on Fable and says why", () => {
  const p = sessionPlan("MODEL: mythos\npiece", { mode: "fable", model: "fable", opusModel: "opus", effort: "high" });
  assert.deepEqual(pick(p), { model: "fable", family: "fable", effort: "high", askedEffort: null });
  assert.match(p.note, /MODEL: mythos.*same model as Fable.*runs on fable/);
});
test("runsOn: a note's tail names the model the session runs on after the gate", () => {
  const run = { mode: "mythos", model: MYTHOS, opusModel: "claude-opus-5-5", effort: "high" };
  assert.equal(runsOn(sessionPlan("MODEL: fable\npiece", run).note, "claude-opus-5-5"),
    "MODEL: fable is the same model as Mythos, this run's main model; it runs on claude-opus-5-5");
  assert.equal(runsOn(sessionPlan("MODEL: sonnet\npiece", run).note, "opus"),
    "MODEL: sonnet is not a model the runner runs (opus, fable, mythos); it runs on opus");
  assert.equal(runsOn(sessionPlan("MODEL: fable\npiece", run).note, MYTHOS), sessionPlan("MODEL: fable\npiece", run).note);
  assert.equal(runsOn(null, "opus"), null);
});
test("resolveMode: a Mythos model means mode mythos; each premium mode refuses the other's model by name", () => {
  assert.deepEqual(resolveMode({ model: MYTHOS }), { mode: "mythos", model: MYTHOS, opusModel: "opus" });
  assert.deepEqual(resolveMode({ mode: "mythos" }), { mode: "mythos", model: MYTHOS, opusModel: "opus" });
  // The bare word is no model the CLI knows: it becomes the id.
  assert.deepEqual(resolveMode({ model: "mythos" }), { mode: "mythos", model: MYTHOS, opusModel: "opus" });
  assert.deepEqual(resolveMode({ mode: "mythos", model: "Mythos" }), { mode: "mythos", model: MYTHOS, opusModel: "opus" });
  assert.deepEqual(resolveMode({ mode: "mythos", model: "claude-opus-5-5" }), { mode: "mythos", model: MYTHOS, opusModel: "claude-opus-5-5" });
  assert.match(resolveMode({ mode: "opus", model: MYTHOS }).error, /mode "opus" cannot run on the Mythos model "claude-mythos-5-2"; use mode "mythos"/);
  assert.match(resolveMode({ mode: "fable", model: MYTHOS }).error, /mode "fable" cannot use the Mythos model "claude-mythos-5-2"; use mode "mythos"/);
  assert.match(resolveMode({ mode: "mythos", model: "claude-fable-5-2" }).error, /mode "mythos" cannot use the Fable model "claude-fable-5-2"; use mode "fable"/);
  assert.match(resolveMode({ mode: "mythos", model: "sonnet" }).error, /mode "mythos" cannot use the model "sonnet"; it takes a Mythos model \(the main\) or an Opus model \(the stand-in\)/);
  // What was there before stays.
  assert.match(resolveMode({ mode: "opus", model: "fable" }).error, /use mode "fable"/);
  // A mode the runner does not know is refused, never made into a model.
  assert.deepEqual(resolveMode({ mode: "bogus" }), { error: 'mode "bogus" is not one of opus, fable, mythos' });
  assert.deepEqual(resolveMode({ mode: "Mythos", model: MYTHOS }), { error: 'mode "Mythos" is not one of opus, fable, mythos' });
});
test("nightModelSettings levels Mythos keys and the exact ids the run starts sessions with", () => {
  const lower = [{ modelSettings: { [MYTHOS]: { effortLevel: "low" } } }];
  const out = nightModelSettings({}, lower, { opus: "xhigh", fable: "high", mythos: "high" }, ["claude-opus-5-5", "claude-opus-5-5"]);
  assert.equal(out[MYTHOS].effortLevel, "high");
  assert.equal(out["claude-opus-5-5"].effortLevel, "xhigh");
  assert.equal(nightModelSettings({}, [], { mythos: "max" }, [MYTHOS])[MYTHOS].effortLevel, "xhigh");
  assert.equal(nightModelSettings({}, [], {}, [MYTHOS])[MYTHOS].effortLevel, "high");
  // An id of no family the night levels is left alone.
  assert.equal(nightModelSettings({}, [], {}, ["other-model"])["other-model"], undefined);
});
test("runModelIds: the main model and the stand-in, and in opus mode what a MODEL line starts", () => {
  assert.deepEqual(runModelIds({ mode: "opus", model: "claude-opus-5-5", opusModel: "claude-opus-5-5" }), ["claude-opus-5-5", "fable", MYTHOS]);
  assert.deepEqual(runModelIds({ mode: "mythos", model: MYTHOS, opusModel: "opus" }), [MYTHOS, "opus"]);
  assert.deepEqual(runModelIds({ mode: "fable", model: "fable", opusModel: "claude-opus-5-5" }), ["fable", "claude-opus-5-5"]);
  // A run.json from before modes is an opus run.
  assert.deepEqual(runModelIds({ model: "opus" }), ["opus", "fable", MYTHOS]);
});
test("fableGate refuses a family this chain found unavailable, before anything else, and only that family", () => {
  const now = Date.parse("2026-11-18T22:00:00Z");
  assert.deepEqual(fableGate({ unavailable: ["mythos"], ratio: 0.1 }, { now, family: "mythos" }), { ok: false, why: "unavailable", family: "mythos" });
  assert.deepEqual(fableGate({ unavailable: ["mythos"] }, { now, family: "fable" }), { ok: true, ratio: null });
  assert.deepEqual(fableGate({ unavailable: ["mythos"] }, { now }), { ok: true, ratio: null });
  // One allowance: the count and the share serve both names.
  assert.equal(fableGate({ sessions: 2 }, { now, family: "mythos" }).why, "count");
  assert.equal(fableGate({ ratio: 0.7 }, { now, family: "mythos" }).why, "ceiling");
});
test("the header notes name the model in play", () => {
  assert.equal(premiumNote("fable"), FABLE_NOTE);
  assert.match(FABLE_NOTE, /^This session runs on Fable, only for this piece/);
  const m = premiumNote("mythos");
  assert.match(m, /^This session runs on Mythos, only for this piece/);
  assert.match(m, /Mythos's weekly allowance/);
  assert.match(m, /keeps MODEL: mythos/);
  assert.doesNotMatch(m, /Fable|MODEL: fable/);
  const f = fallbackNote("its allowance is at 65%, at or over the 60% ceiling", { family: "mythos" });
  assert.match(f, /^This run's main model is Mythos, but/); assert.match(f, /goes back to Mythos when it can/);
  assert.doesNotMatch(f, /Fable|\bmax\b/);
  assert.equal(fallbackNote("x", { family: "fable" }), fallbackNote("x"));
  assert.equal(deniedNote("fable"), "The prompt asked for MODEL: fable, but Fable's weekly allowance does not cover it tonight; this piece runs on Opus at max.");
  assert.equal(deniedNote("mythos", "ceiling"), "The prompt asked for MODEL: mythos, but Mythos's weekly allowance does not cover it tonight; this piece runs on Opus at max.");
  assert.match(deniedNote("mythos", "unavailable"), /^The prompt asked for MODEL: mythos, but this account cannot run Mythos .*; this piece runs on Opus at max\.$/);
});

// ---------------------------------------------------------------- the model table (U19, session 29)
// One row a family; every other model table derives from it, and no other script lists the families,
// so the next model id (or a new name for Fable's seat, or a new subagent family) is a row.
test("every model table derives from MODEL_TABLE, and today's values stay as they were", () => {
  const seat = (s) => MODEL_TABLE.filter((r) => r.seat === s);
  assert.equal(seat("main").length, 1);
  assert.ok(MODEL_TABLE.every((r) => ["main", "premium", "sub"].includes(r.seat) && LEVELS.includes(r.effort) && r.cli && r.family === r.family.toLowerCase()));
  assert.equal(MAIN_MODEL, seat("main")[0].family);
  assert.equal(SUB_MODEL, seat("sub")[0].family);
  const sessions = MODEL_TABLE.filter((r) => r.seat !== "sub");
  assert.deepEqual(MODELS, sessions.map((r) => r.family));
  assert.deepEqual(PREMIUM, seat("premium").map((r) => r.family));
  assert.deepEqual(MAIN_EFFORT, Object.fromEntries(sessions.map((r) => [r.family, r.effort])));
  assert.deepEqual(SUB_EFFORT, Object.fromEntries(seat("sub").map((r) => [r.family, r.effort])));
  for (const r of MODEL_TABLE) {
    assert.equal(cliModel(r.family), r.cli);
    assert.equal(familyOf(r.cli), r.family);
    assert.equal(familyOf(`claude-${r.family}-9-9`), r.family);
    assert.equal(isPremium(r.family), r.seat === "premium");
  }
  // The bare settings key of each family the CLI knows by an alias; none for one it knows by its id.
  assert.deepEqual(Object.keys(nightModelSettings({}, [])).sort(), MODEL_TABLE.filter((r) => r.cli === r.family).map((r) => r.family).sort());
  assert.deepEqual([MAIN_MODEL, SUB_MODEL, MODELS, PREMIUM, MAIN_EFFORT, SUB_EFFORT],
    ["opus", "sonnet", ["opus", "fable", "mythos"], ["fable", "mythos"], { opus: "xhigh", fable: "high", mythos: "high" }, { sonnet: "medium", haiku: "high" }]);
  assert.equal(familyOf("something else"), "opus");
  // Two family words in one id: a premium word wins over the stand-in's, the longer word within a seat.
  assert.equal(familyOf("claude-opus-fable"), "fable");
  assert.equal(familyOf("fable-mythos"), "mythos");
  assert.equal(familyOf("opus-sonnet"), "opus");
  assert.equal(familyOf("sonnet-haiku"), "sonnet");
});
test("config.mjs's modes are effort.mjs's models, the same list", () => {
  assert.equal(MODES, MODELS);
});
test("no script but effort.mjs lists the model families or reads a level by a family's word: they read its table", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const f = MODEL_TABLE.map((r) => r.family).join("|");
  const list = new RegExp(`\\b(?:${f})\\b\\s*\\|\\s*(?:${f})\\b|["'](?:${f})["']\\s*,\\s*["'](?:${f})["']|\\b(?:${f})\\s*:[^,]*,\\s*(?:${f})\\s*:|MAIN_EFFORT\\.(?:${f})\\b`, "i");
  const files = [...fs.readdirSync(dir), ...fs.readdirSync(path.join(dir, "lang")).map((n) => `lang/${n}`)]
    .filter((n) => n.endsWith(".mjs") && !n.endsWith(".test.mjs") && n !== "effort.mjs");
  const hits = files.flatMap((n) => fs.readFileSync(path.join(dir, n), "utf8").split("\n")
    .filter((l) => !/^\s*\/\//.test(l) && list.test(l)).map((l) => `${n}: ${l.trim().slice(0, 80)}`));
  assert.deepEqual(hits, []);
});
