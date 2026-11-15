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
// for Opus, MAIN_EFFORT for Fable) and the text the session gets.
export function sessionPlan(text, run = {}) {
  const d = promptDirectives(text);
  let model = run.model || MAIN_MODEL, note = null;
  if (d.model && MODELS.includes(d.model)) model = d.model;
  else if (d.model) { model = MAIN_MODEL; note = `MODEL: ${d.model} is not a model the runner runs (${MODELS.join(", ")}); it runs on ${MAIN_MODEL}`; }
  const family = familyOf(model);
  const own = family === "fable" ? MAIN_EFFORT.fable : run.effort || MAIN_EFFORT.opus;
  return { model, family, effort: d.effort || own, body: d.body, asked: d.model, note };
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
export function fableGate(f = {}, { ceiling = 0.6, maxSessions = 2, now = Date.now() } = {}) {
  if (f.outUntil && now < f.outUntil) return { ok: false, why: "out", until: f.outUntil };
  const known = f.ratio != null && (!f.ratioResetsAt || now < f.ratioResetsAt * 1000);
  if (known && f.ratio >= ceiling) return { ok: false, why: "ceiling", ratio: f.ratio, ceiling };
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
  "Bu oturum max eforda, yalnız bu parça için: istemin adını verdiği zor parça. O parça bitince ya da engellenince (masaüstü yok, bir girdi eksik) max'ta başka işe geçme: durumu kaydet, sonraki istemi yaz (başka iş EFFORT satırı olmadan; engellenen parça sürecekse yine EFFORT: max ile) ve bitir.",
  `Alt ajanlar da max'a çıkmasın diye her Agent çağrısına effort ver (Sonnet "medium", önemli iş "high"; Haiku "high"; Opus inceleyici "xhigh") ve workflow başlatma.`,
].join("\n");
// The same for a Fable session: Fable is for the hard piece its prompt names, and its allowance is
// the user's for the day.
export const FABLE_NOTE = "Bu oturum Fable'da, yalnız bu parça için: istemin adını verdiği zor parça. Fable'ın haftalık payı kullanıcının gündüz işinin; o parça bitince ya da engellenince Fable'da başka işe geçme: durumu kaydet, sonraki istemi yaz (başka iş MODEL satırı olmadan; engellenen parça sürecekse yine MODEL: fable ile) ve bitir.";
