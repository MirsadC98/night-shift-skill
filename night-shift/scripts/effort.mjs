// The night shift's models and efforts belong to the runner, whatever the user picks in VS Code or
// Desktop (Fable, another level). Measured 2026-11-10 with claude 2.1.314 against a project whose
// settings said model sonnet, effort low and subagent model haiku (C:\temp\demo-app-effort-20261110):
// - `--model` wins over every settings file's "model";
// - the --settings layer's env wins over the project's, while the process env loses to it;
// - per-model levels in the --settings layer win over the user's and the project's files and reach
//   the subagents on that model; `--effort` lifts every subagent, Sonnet and Haiku too, to its level;
// - `max` exists only as `--effort max`, so a max session gives each subagent call its own level.
import { MODES } from "./config.mjs";

export const MAIN_MODEL = "opus";
export const SUB_MODEL = "sonnet";
// The models a prompt may ask for (MODEL: …) and each one's level when the prompt names none:
// the chain runs on Opus at xhigh; Fable, which costs the limit about twice what Opus does for the
// same work (A0, 2026-11-15), runs the one hard piece at high, which scores about Opus at max.
// Mythos is Fable under another name: Anthropic gives the two as one underlying model at one price,
// open only to organizations it has verified, and a Mythos call draws on Fable's weekly allowance
// (claude 2.1.327, measured 2026-11-18). It takes Fable's seat with every rule Fable has.
export const MODELS = ["opus", "fable", "mythos"];
export const MAIN_EFFORT = { opus: "xhigh", fable: "high", mythos: "high" };
// Fable's seat: the models that draw on its weekly allowance and share its gate, count and notes.
export const PREMIUM = ["fable", "mythos"];
export const isPremium = (family) => PREMIUM.includes(family);
// What --model gets for a family: the CLI's alias where it has one, else the model's id. The CLI has
// no "mythos" alias (claude 2.1.327 refuses `--model mythos` before any call), and this table is the
// one place the id is written.
const CLI_MODEL = { opus: "opus", fable: "fable", mythos: "claude-mythos-5-2" };
export const cliModel = (family) => CLI_MODEL[family] ?? family;
// A family's name in a line a user or a session reads.
export const modelName = (family) => { const f = String(family || MAIN_MODEL); return f[0].toUpperCase() + f.slice(1); };
// Subagents by family (the user's rule, 2026-11-10): Sonnet at medium for ordinary work, raised per
// call with effort "high" for an important one; Haiku at high for the lightest lookups.
export const SUB_EFFORT = { sonnet: "medium", haiku: "high" };
export const subEffortText = () => Object.entries(SUB_EFFORT).map(([m, e]) => `${m} ${e}`).join(", ");
const FAMILIES = ["mythos", "fable", "opus", "sonnet", "haiku"];
export const familyOf = (m) => FAMILIES.find((f) => String(m ?? "").toLowerCase().includes(f)) || "opus";
export const LEVELS = ["low", "medium", "high", "xhigh", "max"];

// A continuation prompt may open with directive lines, each optional, in either order:
// "MODEL: fable" (or opus, mythos) and "EFFORT: high|xhigh|max". A reason written on the same line
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

// What a prompt asks the runner for: its model (opus, fable or mythos, as --model gets it; any other
// name runs on Opus and says so in `note`), the level (the prompt's EFFORT, else the model's own: the
// run's --effort for Opus, MAIN_EFFORT for Fable and Mythos) and the text the session gets. In fable
// or mythos mode (run.mode) that model is the main one at the run's level, Opus is the stand-in at its
// own xhigh, and a MODEL the runner does not run stays on the main model, as does the other name of
// the main model (one model: the mode says which name this account runs it by). A run.json from
// before modes has no mode and gets the opus rules.
const notRun = (asked, model) => `MODEL: ${asked} is not a model the runner runs (${MODELS.join(", ")}); it runs on ${model}`;
export function sessionPlan(text, run = {}) {
  const d = promptDirectives(text);
  const premiumMode = isPremium(run.mode);
  let model = run.model || MAIN_MODEL, note = null;
  if (premiumMode) {
    model = d.model === "opus" ? run.opusModel || MAIN_MODEL : run.model || cliModel(run.mode);
    if (d.model && !MODELS.includes(d.model)) note = notRun(d.model, model);
    else if (isPremium(d.model) && d.model !== run.mode) note = `MODEL: ${d.model} is the same model as ${modelName(run.mode)}, this run's main model; it runs on ${model}`;
  } else if (d.model && MODELS.includes(d.model)) model = cliModel(d.model);
  else if (d.model) { model = MAIN_MODEL; note = notRun(d.model, MAIN_MODEL); }
  const family = familyOf(model);
  const own = isPremium(family) ? (premiumMode && run.effort) || MAIN_EFFORT[family] : premiumMode ? MAIN_EFFORT.opus : run.effort || MAIN_EFFORT.opus;
  return { model, family, effort: d.effort || own, body: d.body, asked: d.model, askedEffort: d.effort, note };
}
// A note ends with the model its session runs on. The runner's gate may move the session to the stand-in after
// sessionPlan wrote the note, so the runner logs it with the model it starts (night-chain.mjs).
export const runsOn = (note, model) => note && note.replace(/; it runs on \S+$/, `; it runs on ${model}`);

// The mode, the main model and the Opus that stands in for it, from the config's mode and model.
// An unset mode follows the model (a Fable model means fable mode, a Mythos model mythos mode); in
// opus mode any model but those runs the chain; in fable or mythos mode the model is that family's
// id, or an Opus id that becomes the stand-in, and the other premium name is refused by its mode's
// name. A bare family word becomes what --model gets for it ("mythos" is no model the CLI knows).
export function resolveMode({ mode, model } = {}) {
  const fam = model == null ? null : familyOf(model);
  if (fam && String(model).trim().toLowerCase() === fam) model = cliModel(fam);
  if (!mode) mode = isPremium(fam) ? fam : "opus";
  if (!MODES.includes(mode)) return { error: `mode "${mode}" is not one of ${MODES.join(", ")}` };
  if (mode === "opus") {
    if (isPremium(fam)) return { error: `mode "opus" cannot run on the ${modelName(fam)} model "${model}"; use mode "${fam}" or another model` };
    return { mode, model: model ?? MAIN_MODEL, opusModel: fam === "opus" ? model : MAIN_MODEL };
  }
  if (!model || fam === mode) return { mode, model: model || cliModel(mode), opusModel: MAIN_MODEL };
  if (fam === "opus") return { mode, model: cliModel(mode), opusModel: model };
  if (isPremium(fam)) return { error: `mode "${mode}" cannot use the ${modelName(fam)} model "${model}"; use mode "${fam}"` };
  return { error: `mode "${mode}" cannot use the model "${model}"; it takes a ${modelName(mode)} model (the main) or an Opus model (the stand-in)` };
}

// The model ids a run starts sessions with: the main model and the stand-in, and in opus mode what a
// MODEL line may start. nightModelSettings levels each by its id: a family word is not enough for
// Mythos (measured 2026-11-18: modelSettings.mythos was ignored, the id's key was read).
export const runModelIds = (run = {}) =>
  [...new Set([run.model, run.opusModel, ...(isPremium(run.mode) ? [] : PREMIUM.map(cliModel))].filter(Boolean))];

// The directive lines that give a plan back, for a prompt the runner writes anew (a retry).
export const directiveLines = (d) => `${d.model ? `MODEL: ${d.model}\n` : ""}${d.effort ? `EFFORT: ${d.effort}\n` : ""}`;

// Whether a session that asks for Fable (or Mythos: one allowance, one state, one count) gets it.
// Fable's weekly allowance is half the weekly limit,
// and the user's own sessions run on it in the day (A0: they alone would use 115–145 % of it), so the
// night takes Fable only while the allowance is under the ceiling. Its ratio arrives only on Fable
// calls (rate_limit_event, unifiedWindows.seven_day_overage_included): before the chain's first
// Fable session it is unknown, and then at most `maxSessions` Fable sessions run in a chain.
// f: the run's fable.json { sessions, outUntil (ms), ratio (0–1), ratioResetsAt (s), unavailable
// (families) }; start clears the ratio, so it is never older than the chain, and a reset since it was
// read makes it unknown. A family the chain found the account cannot run (a session on it was refused
// as not found: session-outcome.mjs, modelUnavailable) is refused before anything else.
const knownShare = (f, now) => f.ratio != null && (!f.ratioResetsAt || now < f.ratioResetsAt * 1000);
// Out until the reset, or the known share at the ceiling; null when neither stops a Fable session.
function shareStop(f, ceiling, now) {
  if (f.outUntil && now < f.outUntil) return { ok: false, why: "out", until: f.outUntil };
  if (knownShare(f, now) && f.ratio >= ceiling) return { ok: false, why: "ceiling", ratio: f.ratio, ceiling };
  return null;
}
// In fable or mythos mode that model is every session's main one, so no count rule applies: only out
// and the ceiling. No `unavailable` either: a main model the account cannot run ends the chain, since
// only the user can change the mode.
export function mainGate(f = {}, { ceiling = 0.6, now = Date.now() } = {}) {
  return shareStop(f, ceiling, now) || { ok: true, ratio: knownShare(f, now) ? f.ratio : null };
}
export function fableGate(f = {}, { ceiling = 0.6, maxSessions = 2, now = Date.now(), family = null } = {}) {
  if (family && Array.isArray(f.unavailable) && f.unavailable.includes(family)) return { ok: false, why: "unavailable", family };
  const stop = shareStop(f, ceiling, now);
  if (stop) return stop;
  const known = knownShare(f, now);
  if (!known && (f.sessions || 0) >= maxSessions) return { ok: false, why: "count", sessions: f.sessions || 0, maxSessions };
  return { ok: true, ratio: known ? f.ratio : null };
}

// modelSettings for the --settings layer: every Opus, Fable and Mythos key at this session's level for
// that family (xhigh for max, which settings refuse), every Sonnet and Haiku key at its family's
// SUB_EFFORT. The keys the lower files hold ("claude-opus-5-5" from a picker) are written too, so none
// of them keeps a level of its own, and so are `ids`, the models the run starts sessions with
// (runModelIds). `main` is { opus, fable, mythos } (a bare level, as before, means Opus).
const FAMILY = /opus|fable|mythos|sonnet|haiku/i;
export function nightModelSettings(prev = {}, lower = [], main = MAIN_EFFORT, ids = []) {
  const levels = { ...MAIN_EFFORT, ...(typeof main === "string" ? { opus: main } : main), ...SUB_EFFORT };
  const named = [...ids, ...lower.flatMap((s) => Object.keys(s?.modelSettings || {}))];
  const keys = new Set(["opus", "fable", "sonnet", "haiku", ...named.filter((k) => FAMILY.test(k))]);
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
// The same for a Fable or Mythos session in opus mode: that model is for the hard piece its prompt
// names, and its allowance is the user's for the day. The note names the model in play and the MODEL
// line that brings the piece back to it.
export const premiumNote = (family = "fable") => {
  const name = modelName(family);
  return `This session runs on ${name}, only for this piece: the hard piece the prompt names. ${name}'s weekly allowance is the user's for daytime work; when that piece is finished or blocked, take no other work on ${name}: save the state, write the next prompt (other work without a MODEL line; a blocked piece that will go on keeps MODEL: ${family}) and finish.`;
};
export const FABLE_NOTE = premiumNote("fable");
// The header of a session that runs on Opus in fable or mythos mode (`family`, the main model's)
// because that model is out or over the ceiling. It never names the max level: the runner does not run
// it in these modes.
// A prompt that asked for its own level (`asked`) keeps it: the note then names no level and leaves the next prompt's EFFORT line to that level's own note.
export const fallbackNote = (why, { asked = null, family = "fable" } = {}) => `This run's main model is ${modelName(family)}, but it cannot run this session: ${why}. This session runs on Opus at ${asked ? "the level its prompt asked for" : "xhigh"}. Do your piece as usual, and write the next prompt without a MODEL ${asked ? "line" : "or EFFORT line"}, so the next session goes back to ${modelName(family)} when it can.`;
// The header of a session in opus mode whose prompt asked for Fable or Mythos (`family`) and that runs
// on Opus at max instead: the gate refused it (`why`, the gate's), "unavailable" when this chain found
// the account cannot run that model.
export const deniedNote = (family = "fable", why = null) => `The prompt asked for MODEL: ${family}, but ${why === "unavailable"
  ? `this account cannot run ${modelName(family)} (a session on it was refused earlier in this chain)`
  : `${modelName(family)}'s weekly allowance does not cover it tonight`}; this piece runs on Opus at max.`;
