// What a finished `claude -p --output-format stream-json` session left behind:
// its result line, whether it stopped at a usage limit, and when that resets.
//
// The structured fields come first: the CLI's wording changes ("usage limit
// reached|<epoch>" became "You've hit your session limit · resets 8:20pm"),
// while the result's api_error and the rate_limit_event's resetsAt do not.
// The text match is anchored to the start of a result line ("You've hit your … limit"): a session
// that merely talks about a rate limiter, or a build that failed on one, must not be read as the
// account's limit and sleep the chain (R3). Only stderr without any result line is matched loosely.
// The CLI may also append an empty result line after a limit one; it never decides (R1).
//
// Fable's weekly allowance (claude 2.1.325, read from its code on 2026-11-15; no real sample yet,
// so chain.log keeps the raw record of every limit to confirm or correct this):
// - each Fable call's rate_limit_event carries unifiedWindows.seven_day_overage_included
//   ("Fable limit" in the CLI), its utilization 0–1 and resetsAt;
// - a used-up allowance is refused as api_error model_requires_usage_credits, whose
//   rate_limit_info.rateLimitType is seven_day_overage_included when the response named it;
// - a headless session then switches models on its own ("Switched to Opus for this session ·
//   Fable requires usage credits", an informational system line), unless
//   CLAUDE_CODE_NO_MODEL_FALLBACK is set, which ends the turn as model_substitution_disabled;
//   consent_unanswered and no_allowed_fallback are the same refusal by other paths.

const FABLE_REFUSALS = new Set(["model_requires_usage_credits", "model_substitution_disabled", "consent_unanswered", "no_allowed_fallback"]);
const FABLE_WINDOW = "seven_day_overage_included";

const LIMIT_TEXT = /^\s*(?:Claude AI usage limit reached|You(?:'|’)ve hit your [\w -]{1,30}limit)/i;
const LOOSE = /usage limit|limit reached|rate.?limit|hit your [\w-]+ limit/i;

// timedOut/hours: the runner's --session-hours timer killed the session (a kill is no API error, so no retry).
export function sessionOutcome(stream, errText = "", code = null, { timedOut = false, hours = null } = {}) {
  // A resumed session appends to the same stream: a rejected event belongs to
  // the result that follows it, not to a later part of the conversation.
  let res = null, cost = 0, pending = null, rejected = null, lastRejected = null, sessionId = null, model = null, switchedTo = null;
  let first = null, last = null;
  const mainModels = new Set();
  for (const line of String(stream).trim().split("\n")) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    sessionId = j.session_id || sessionId;
    if (j.type === "result") {
      const empty = j.is_error !== true && !j.num_turns && !String(j.result ?? "").trim();
      if (res && empty) cost = Math.max(cost, Number(j.total_cost_usd) || 0);
      else { res = j; cost = Number(j.total_cost_usd) || 0; rejected = pending; pending = null; }
    } else if (j.type === "rate_limit_event") {
      if (j.rate_limit_info?.status === "rejected") pending = lastRejected = j.rate_limit_info;
      else if (j.rate_limit_info) lastRejected = null;
      const w = j.rate_limit_info?.unifiedWindows;
      if (w) { first ||= w; last = w; }
    } else if (j.type === "system" && j.subtype === "init") model = j.model || model;
    else if (j.type === "system" && /^Switched to /.test(String(j.content ?? ""))) switchedTo = /^Switched to (.+?)(?:,| for this session| ·)/.exec(j.content)?.[1] || "another model";
    else if (j.type === "assistant" && !j.parent_tool_use_id && j.message?.model && j.message.model !== "<synthetic>") mainModels.add(j.message.model);
  }
  if (!res) rejected = pending;
  const errTail = String(errText).slice(-2000), resText = res?.result ?? "";
  const cut = !res || res.is_error === true;
  const structuredLimit = res?.api_error === "usage_limit_reached" || res?.api_error_status === 429;
  const info = res?.api_error_params?.rate_limit_info || rejected || (structuredLimit ? lastRejected : null);
  const limited = cut && (structuredLimit || Boolean(rejected) || LIMIT_TEXT.test(resText) || (!res && LOOSE.test(errTail)));
  const rejectedAt = Object.values(last || {}).filter((w) => w?.status === "rejected" && w.resetsAt).map((w) => w.resetsAt);
  const epoch = info?.resetsAt || Number(/\|(\d{10})\b/.exec(`${resText}\n${errTail}`)?.[1]) || (limited && rejectedAt.length ? Math.min(...rejectedAt) : null);
  // Cut off because Fable's allowance is used up: by the refusal, or by a limit named as Fable's.
  const fableOut = cut && (FABLE_REFUSALS.has(res?.api_error) || info?.rateLimitType === FABLE_WINDOW);
  const fableEpoch = (info?.rateLimitType === FABLE_WINDOW && info.resetsAt) || last?.[FABLE_WINDOW]?.resetsAt || null;
  const fatal = cut && !limited && !fableOut && ([400, 401, 403, 404].includes(res?.api_error_status) || /^\s*API Error: (?:400|401|403|404)\b|Please run \/login/.test(resText));
  const transient = !timedOut && cut && !limited && !fableOut && !fatal && (!res || res.api_error != null || res.api_error_status != null || /^\s*API Error\b/.test(resText));
  const lastErrLine = errTail.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  // A result with no text (is_error and nothing said) still names its error fields, else says there was none.
  const resWhy = String((typeof res?.api_error === "string" && res.api_error) || (res?.api_error_status != null ? `API status ${res.api_error_status}` : "no error text"));
  const errorText = !cut ? "" : (res ? resText.trim().split("\n")[0] || resWhy : lastErrLine || `exit ${code}, no output`).slice(0, 160);
  return {
    limited,
    transient,
    fatal,
    // Why a cut-off session ended, one line for chain.log and the card ("" when it was not cut).
    errorText,
    resetAt: limited && epoch ? epoch * 1000 + 60_000 : null,
    sessionId,
    // Which limit (five_hour, seven_day, seven_day_overage_included, …), as the CLI named it, and
    // the raw record and error for chain.log.
    limitType: info?.rateLimitType ?? null,
    limitInfo: info || null,
    apiError: res?.api_error ?? null,
    apiErrorStatus: res?.api_error_status ?? null,
    fableOut,
    fableResetAt: fableEpoch ? fableEpoch * 1000 + 60_000 : null,
    // The model the session started on, the ones its own turns ran on, and the one the CLI moved
    // it to when Fable's allowance ran out (null when it did not).
    model,
    mainModels: [...mainModels],
    switchedTo,
    // The limit windows of the session's first and last rate_limit_event (the whole account's).
    windows: { first, last },
    timedOut,
    summary: (res
      ? `${res.subtype}${res.is_error ? " (error)" : ""}, ${res.num_turns} turns, $${cost.toFixed(2)}`
      : timedOut ? "" : `exit ${code}, no result line`) + (timedOut ? `${res ? "; " : ""}killed${hours != null ? ` after ${hours} h` : ""} (--session-hours)` : ""),
  };
}

// "5h 39%→41% · 7d 32%→33% · fable 13%→17%": a session's limit ratios at its first and last event.
const pctOf = (u) => (u == null ? "?" : `${Math.round(u > 1 ? u : u * 100)}%`);
export function windowSpan({ first, last } = {}) {
  if (!first) return "no limit event";
  return [["5h", "five_hour"], ["7d", "seven_day"], ["fable", FABLE_WINDOW]]
    .filter(([, k]) => first[k] || last?.[k])
    .map(([n, k]) => `${n} ${pctOf(first[k]?.utilization)}→${pctOf(last?.[k]?.utilization)}`).join(" · ");
}
