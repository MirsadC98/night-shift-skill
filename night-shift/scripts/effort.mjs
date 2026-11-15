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
// Subagents by family (the user's rule, 2026-11-10): Sonnet at medium for ordinary work, raised per
// call with effort "high" for an important one; Haiku at high for the lightest lookups.
export const SUB_EFFORT = { sonnet: "medium", haiku: "high" };
export const subEffortText = () => Object.entries(SUB_EFFORT).map(([m, e]) => `${m} ${e}`).join(", ");

// A continuation prompt may open with "EFFORT: max" (or xhigh): that session's Opus level. A reason
// written on the same line ("EFFORT: max — the bug resisted two fixes", one in three Sonnet tries)
// stays in the prompt.
const LINE = /^EFFORT:\s*(max|xhigh)\b[\s—–:;,.-]*(.*)$/i;
export function promptEffort(text, fallback = "xhigh") {
  const [first, ...rest] = String(text ?? "").split("\n");
  const m = LINE.exec(first.trim());
  if (!m) return { effort: fallback, body: String(text ?? "") };
  const tail = rest.join("\n").replace(/^\s*\n/, "");
  return { effort: m[1].toLowerCase(), body: m[2].trim() ? `${m[2].trim()}\n${tail}` : tail };
}

// modelSettings for the --settings layer: every Opus key at the run's level (xhigh for max, which
// settings refuse), every Sonnet and Haiku key at its family's SUB_EFFORT. The keys the lower files hold
// ("claude-opus-5-5" from a picker) are written too, so none of them keeps a level of its own.
const FAMILY = /opus|sonnet|haiku/i;
export function nightModelSettings(prev = {}, lower = [], main = "xhigh") {
  const keys = new Set(["opus", "sonnet", "haiku", ...lower.flatMap((s) => Object.keys(s?.modelSettings || {})).filter((k) => FAMILY.test(k))]);
  const out = { ...prev };
  for (const k of keys) out[k] = { ...prev[k], effortLevel: /opus/i.test(k) ? (main === "max" ? "xhigh" : main) : SUB_EFFORT[/haiku/i.test(k) ? "haiku" : "sonnet"] };
  return out;
}

// The header lines a max session gets. Max is for the one hard piece its prompt names (the user's
// rule, 2026-11-11), and --effort max would run its subagents at max too.
export const MAX_NOTE = [
  "Bu oturum max eforda, yalnız bu parça için: istemin adını verdiği zor parça. O parça bitince ya da engellenince (masaüstü yok, bir girdi eksik) max'ta başka işe geçme: durumu kaydet, sonraki istemi yaz (başka iş EFFORT satırı olmadan; engellenen parça sürecekse yine EFFORT: max ile) ve bitir.",
  `Alt ajanlar da max'a çıkmasın diye her Agent çağrısına effort ver (Sonnet "medium", önemli iş "high"; Haiku "high"; Opus inceleyici "xhigh") ve workflow başlatma.`,
].join("\n");
