// The night shift's models and efforts belong to the runner, whatever the user picks in VS Code or
// Desktop (Fable, another level). Measured 2026-11-10 with claude 2.1.314 against a project whose
// settings said model sonnet, effort low and subagent model haiku (C:\temp\demo-app-effort-20261110):
// - `--model` wins over every settings file's "model";
// - the --settings layer's env wins over the project's, while the process env loses to it;
// - per-model levels in the --settings layer win over the user's and the project's files and reach
//   the subagents on that model; `--effort` lifts every subagent, Sonnet and Haiku too, to its level;
// - `max` exists only as `--effort max`, so a max session gives each subagent call its own level.
export const MAIN_MODEL = "opus";
export const SUB_MODEL = "sonnet";
// The models a prompt may ask for (MODEL: …) and each one's level when the prompt names none:
// the chain runs on Opus at xhigh; Fable, which costs the limit about twice what Opus does for the
// same work (A0, 2026-11-15), runs the one hard piece at high, which scores about Opus at max.
export const MODELS = ["opus", "fable"];
export const MAIN_EFFORT = { opus: "xhigh", fable: "high" };
// Subagents by family (the user's rule, 2026-11-10): Sonnet at medium for ordinary work, raised per
// call with effort "high" for an important one; Haiku at high for the lightest lookups.
export const SUB_EFFORT = { sonnet: "medium", haiku: "high" };
export const subEffortText = () => Object.entries(SUB_EFFORT).map(([m, e]) => `${m} ${e}`).join(", ");
const FAMILIES = ["fable", "opus", "sonnet", "haiku"];
export const familyOf = (m) => FAMILIES.find((f) => String(m ?? "").toLowerCase().includes(f)) || "opus";
export const LEVELS = ["low", "medium", "high", "xhigh", "max"];

// A continuation prompt may open with directive lines, each optional, in either order:
// "MODEL: fable" (or opus) and "EFFORT: high|xhigh|max". A reason written on the same line
// ("EFFORT: max — the bug resisted two fixes") stays in the prompt; the directives do not.
// Both on one line ("MODEL: fable, EFFORT: xhigh") count too. MODEL (in capitals, so a prompt that
// opens with "Model: …" stays text) takes any word, so "MODEL: sonnet" is not sent to the model as
// text either; sessionPlan decides what it runs on.
const DIRECTIVE = { model: /^MODEL:\s*([A-Za-z][\w-]*)/, effort: /^EFFORT:\s*(high|xhigh|max)\b/i };
const SEP = /^[\s—–:;,.|-]+/;
export function promptDirectives(text) {
  const lines = String(text ?? "").split("\n");
  const got = { model: null, effort: null }, reasons = [];
  let i = 0;
  for (; i < lines.length; i++) {
    let rest = lines[i].trim(), hit = false;
    for (let key; (key = Object.keys(DIRECTIVE).find((k) => !got[k] && DIRECTIVE[k].test(rest)));) {
      const m = DIRECTIVE[key].exec(rest);
      got[key] = m[1].toLowerCase();
      rest = rest.slice(m[0].length).replace(SEP, "");
      hit = true;
    }
    if (!hit) break;
    if (rest) reasons.push(rest);
  }
  if (!i) return { ...got, body: String(text ?? "") };
  const tail = lines.slice(i).join("\n").replace(/^\s*\n/, "");
  return { ...got, body: [...reasons, ...(tail ? [tail] : [])].join("\n") };
}

// The effort line alone, as before MODEL existed: kept for callers that only want the level.
export function promptEffort(text, fallback = "xhigh") {
  const d = promptDirectives(text);
  return { effort: d.effort || fallback, body: d.body };
}

// What a prompt asks the runner for: its model (only opus and fable; any other name runs on Opus
// and says so in `note`), the level (the prompt's EFFORT, else the model's own: the run's --effort
// for Opus, MAIN_EFFORT for Fable) and the text the session gets. In fable mode (run.mode) Fable is
// the main model at the run's level, Opus is the stand-in at its own xhigh, and a MODEL the runner
// does not run stays on Fable; a run.json from before modes has no mode and gets the rules above.
export function sessionPlan(text, run = {}) {
  const d = promptDirectives(text);
  const fableMode = run.mode === "fable";
  let model = run.model || MAIN_MODEL, note = null;
  if (fableMode) {
    const opus = run.opusModel || MAIN_MODEL;
    model = d.model === "opus" ? opus : run.model || "fable";
    if (d.model && !MODELS.includes(d.model)) note = `MODEL: ${d.model} is not a model the runner runs (${MODELS.join(", ")}); it runs on ${model}`;
  } else if (d.model && MODELS.includes(d.model)) model = d.model;
  else if (d.model) { model = MAIN_MODEL; note = `MODEL: ${d.model} is not a model the runner runs (${MODELS.join(", ")}); it runs on ${MAIN_MODEL}`; }
  const family = familyOf(model);
  const own = family === "fable" ? (fableMode && run.effort) || MAIN_EFFORT.fable : fableMode ? MAIN_EFFORT.opus : run.effort || MAIN_EFFORT.opus;
  return { model, family, effort: d.effort || own, body: d.body, asked: d.model, askedEffort: d.effort, note };
}

// The mode, the main model and the Opus that stands in for it, from the config's mode and model.
// An unset mode follows the model (a Fable model means fable mode); in opus mode any non-Fable model
// runs the chain; in fable mode the model is Fable's id, or an Opus id that becomes the stand-in.
export function resolveMode({ mode, model } = {}) {
  const fam = model == null ? null : familyOf(model);
  if (!mode) mode = fam === "fable" ? "fable" : "opus";
  if (mode === "opus") {
    if (fam === "fable") return { error: `mode "opus" cannot run on the Fable model "${model}"; use mode "fable" or another model` };
    return { mode, model: model ?? MAIN_MODEL, opusModel: fam === "opus" ? model : MAIN_MODEL };
  }
  if (!model || fam === "fable") return { mode, model: model || "fable", opusModel: MAIN_MODEL };
  if (fam === "opus") return { mode, model: "fable", opusModel: model };
  return { error: `mode "fable" cannot use the model "${model}"; it takes a Fable model (the main) or an Opus model (the stand-in)` };
}

// The directive lines that give a plan back, for a prompt the runner writes anew (a retry).
export const directiveLines = (d) => `${d.model ? `MODEL: ${d.model}\n` : ""}${d.effort ? `EFFORT: ${d.effort}\n` : ""}`;

// Whether a session that asks for Fable gets it. Fable's weekly allowance is half the weekly limit,
// and the user's own sessions run on it in the day (A0: they alone would use 115–145 % of it), so the
// night takes Fable only while the allowance is under the ceiling. Its ratio arrives only on Fable
// calls (rate_limit_event, unifiedWindows.seven_day_overage_included): before the chain's first
// Fable session it is unknown, and then at most `maxSessions` Fable sessions run in a chain.
// f: the run's fable.json { sessions, outUntil (ms), ratio (0–1), ratioResetsAt (s) }; start clears
// the ratio, so it is never older than the chain, and a reset since it was read makes it unknown.
const knownShare = (f, now) => f.ratio != null && (!f.ratioResetsAt || now < f.ratioResetsAt * 1000);
// Out until the reset, or the known share at the ceiling; null when neither stops a Fable session.
function shareStop(f, ceiling, now) {
  if (f.outUntil && now < f.outUntil) return { ok: false, why: "out", until: f.outUntil };
  if (knownShare(f, now) && f.ratio >= ceiling) return { ok: false, why: "ceiling", ratio: f.ratio, ceiling };
  return null;
}
// In fable mode Fable is every session's main model, so no count rule applies: only out and the ceiling.
export function mainGate(f = {}, { ceiling = 0.6, now = Date.now() } = {}) {
  return shareStop(f, ceiling, now) || { ok: true, ratio: knownShare(f, now) ? f.ratio : null };
}
export function fableGate(f = {}, { ceiling = 0.6, maxSessions = 2, now = Date.now() } = {}) {
  const stop = shareStop(f, ceiling, now);
  if (stop) return stop;
  const known = knownShare(f, now);
  if (!known && (f.sessions || 0) >= maxSessions) return { ok: false, why: "count", sessions: f.sessions, maxSessions };
  return { ok: true, ratio: known ? f.ratio : null };
}

// modelSettings for the --settings layer: every Opus and Fable key at this session's level for that
// family (xhigh for max, which settings refuse), every Sonnet and Haiku key at its family's SUB_EFFORT.
// The keys the lower files hold ("claude-opus-5-5" from a picker) are written too, so none of them
// keeps a level of its own. `main` is { opus, fable } (a bare level, as before, means Opus).
const FAMILY = /opus|fable|sonnet|haiku/i;
export function nightModelSettings(prev = {}, lower = [], main = MAIN_EFFORT) {
  const levels = { ...MAIN_EFFORT, ...(typeof main === "string" ? { opus: main } : main), ...SUB_EFFORT };
  const keys = new Set(["opus", "fable", "sonnet", "haiku", ...lower.flatMap((s) => Object.keys(s?.modelSettings || {})).filter((k) => FAMILY.test(k))]);
  const out = { ...prev };
  for (const k of keys) {
    const level = levels[familyOf(k)];
    out[k] = { ...prev[k], effortLevel: level === "max" ? "xhigh" : level };
  }
  return out;
}

// The header lines a max session gets. Max is for the one hard piece its prompt names (the user's
// rule, 2026-11-11), and --effort max would run its subagents at max too.
export const MAX_NOTE = [
  "This session runs at max effort, only for this piece: the hard piece the prompt names. When that piece is finished or blocked (no desktop, an input is missing), take no other work at max: save the state, write the next prompt (other work without an EFFORT line; a blocked piece that will go on keeps EFFORT: max) and finish.",
  `So that subagents do not run at max too, pass effort on every Agent call (Sonnet "medium", work that matters "high"; Haiku "high"; Opus reviewer "xhigh") and start no workflow.`,
].join("\n");
// The same for a Fable session: Fable is for the hard piece its prompt names, and its allowance is
// the user's for the day.
export const FABLE_NOTE = "This session runs on Fable, only for this piece: the hard piece the prompt names. Fable's weekly allowance is the user's for daytime work; when that piece is finished or blocked, take no other work on Fable: save the state, write the next prompt (other work without a MODEL line; a blocked piece that will go on keeps MODEL: fable) and finish.";
// The header of a session that runs on Opus in fable mode because Fable is out or over the ceiling.
// It never names the max level: the runner does not run it in this mode.
// A prompt that asked for its own level (`asked`) keeps it: the note then names no level and leaves the next prompt's EFFORT line to that level's own note.
export const fallbackNote = (why, { asked = null } = {}) => `This run's main model is Fable, but it cannot run this session: ${why}. This session runs on Opus at ${asked ? "the level its prompt asked for" : "xhigh"}. Do your piece as usual, and write the next prompt without a MODEL ${asked ? "line" : "or EFFORT line"}, so the next session goes back to Fable when it can.`;
