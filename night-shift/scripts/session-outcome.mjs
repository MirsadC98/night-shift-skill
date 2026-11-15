// What a finished `claude -p --output-format stream-json` session left behind:
// its result line, whether it stopped at a usage limit, and when that resets.
//
// The structured fields come first: the CLI's wording changes ("usage limit
// reached|<epoch>" became "You've hit your session limit · resets 8:20pm"),
// while the result's api_error and the rate_limit_event's resetsAt do not.
// The text match stays for a session that died without a result line.

export function sessionOutcome(stream, errText = "", code = null) {
  // A resumed session appends to the same stream: a rejected event belongs to
  // the result that follows it, not to a later part of the conversation.
  let res = null, pending = null, rejected = null, sessionId = null;
  for (const line of String(stream).trim().split("\n")) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    sessionId = j.session_id || sessionId;
    if (j.type === "result") { res = j; rejected = pending; pending = null; }
    else if (j.type === "rate_limit_event" && j.rate_limit_info?.status === "rejected") pending = j.rate_limit_info;
  }
  if (!res) rejected = pending;
  const text = `${res?.result ?? ""}\n${String(errText).slice(-2000)}`;
  const info = res?.api_error_params?.rate_limit_info || rejected;
  const limited = (!res || res.is_error === true) && (
    res?.api_error === "usage_limit_reached" || res?.api_error_status === 429 || Boolean(rejected) ||
    /usage limit|limit reached|rate.?limit|hit your [\w-]+ limit/i.test(text));
  const epoch = info?.resetsAt || Number(/\|(\d{10})\b/.exec(text)?.[1]) || null;
  return {
    limited,
    resetAt: limited && epoch ? epoch * 1000 + 60_000 : null,
    sessionId,
    summary: res
      ? `${res.subtype}${res.is_error ? " (error)" : ""}, ${res.num_turns} turns, $${Number(res.total_cost_usd || 0).toFixed(2)}`
      : `exit ${code}, no result line`,
  };
}
