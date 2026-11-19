// node --test scripts/session-outcome.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sessionOutcome, windowSpan, fieldsGone } from "./session-outcome.mjs";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const result = (fields) => JSON.stringify({ type: "result", subtype: "success", num_turns: 3, total_cost_usd: 1, session_id: "s-1", ...fields });

// Session 07 of 2026-10-30: the CLI now says "You've hit your session limit · resets 8:20pm",
// which the old text match missed, so the chain retried and then gave up instead of waiting.
test("a session stopped by the five-hour limit (CLI of 2026-10-30) waits for its reset", () => {
  const o = sessionOutcome(fixture("session-limit-2026-10-30.jsonl"));
  assert.equal(o.limited, true);
  assert.equal(o.resetAt, 1793380800 * 1000 + 60_000);
  assert.equal(o.sessionId, "00000000-0000-4000-8000-000000000001");
});

test("the older 'usage limit reached|<epoch>' message still counts", () => {
  const o = sessionOutcome(result({ is_error: true, result: "Claude AI usage limit reached|1793380800" }));
  assert.equal(o.limited, true);
  assert.equal(o.resetAt, 1793380800 * 1000 + 60_000);
});

test("a limit seen only in stderr, with no result line, counts", () => {
  const o = sessionOutcome("", "Error: You've hit your weekly limit · resets Nov 5, 2pm");
  assert.equal(o.limited, true);
  assert.equal(o.resetAt, null);
});

test("a finished session is not limited, even after a rejected limit event it got past", () => {
  const event = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1793380800 } });
  const o = sessionOutcome(`${event}\n${result({ is_error: false, result: "done" })}`);
  assert.equal(o.limited, false);
});

// A resumed session appends to the same stream, so the first part's rejected event stays in it.
test("a resumed session judged by its own part, not by the limit the first part hit", () => {
  const resumed = `${fixture("session-limit-2026-10-30.jsonl").trim()}\n` +
    result({ is_error: true, subtype: "error_max_turns", result: "Reached max turns", session_id: "00000000-0000-4000-8000-000000000001" });
  const o = sessionOutcome(resumed);
  assert.equal(o.limited, false);
  assert.equal(o.resetAt, null);
});

test("an error that is not a limit is not treated as one", () => {
  const o = sessionOutcome(result({ is_error: true, subtype: "error_max_turns", result: "Reached max turns" }));
  assert.equal(o.limited, false);
  assert.equal(o.summary, "error_max_turns (error), 3 turns, $1.00");
});

// Fable's allowance (claude 2.1.325's code, 2026-11-15; no real sample yet, so these are built from
// its shapes): the refusal and the window it names, the CLI's own switch, and the windows' span.
const limitEvent = (w, extra = {}) => JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed", unifiedWindows: w, ...extra } });
const turn = (model, parent = null) => JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { model, content: [] } });

test("a Fable session refused for usage credits is Fable-out, with the window's reset", () => {
  const w = { five_hour: { utilization: 0.4, resetsAt: 1795000000 }, seven_day: { utilization: 0.3 }, seven_day_overage_included: { utilization: 0.98, resetsAt: 1795300000 } };
  const o = sessionOutcome([
    JSON.stringify({ type: "system", subtype: "init", model: "claude-fable-5-2", session_id: "s-1" }),
    limitEvent(w), turn("claude-fable-5-2"),
    result({ is_error: true, api_error: "model_requires_usage_credits", result: "Fable requires usage credits" }),
  ].join("\n"));
  assert.equal(o.fableOut, true);
  assert.equal(o.fableResetAt, 1795300000 * 1000 + 60_000);
  assert.equal(o.apiError, "model_requires_usage_credits");
  assert.equal(o.model, "claude-fable-5-2");
  assert.deepEqual(o.mainModels, ["claude-fable-5-2"]);
  assert.equal(windowSpan(o.windows), "5h 40%→40% · 7d 30%→30% · fable 98%→98%");
});

test("a limit named as Fable's is Fable-out too, and model_substitution_disabled with no event", () => {
  const named = sessionOutcome(result({ is_error: true, api_error: "rate_limit_error", api_error_status: 429,
    api_error_params: { rate_limit_info: { rateLimitType: "seven_day_overage_included", resetsAt: 1795300000 } }, result: "limit" }));
  assert.equal(named.fableOut, true);
  assert.equal(named.limitType, "seven_day_overage_included");
  assert.equal(named.fableResetAt, 1795300000 * 1000 + 60_000);
  const bare = sessionOutcome(result({ is_error: true, api_error: "model_substitution_disabled", result: "x" }));
  assert.equal(bare.fableOut, true);
  assert.equal(bare.fableResetAt, null);
  assert.equal(windowSpan(bare.windows), "no limit event");
});

test("the five-hour limit of a Fable session is no Fable-out; a finished session never is", () => {
  const five = sessionOutcome(result({ is_error: true, api_error: "usage_limit_reached",
    api_error_params: { rate_limit_info: { rateLimitType: "five_hour", resetsAt: 1795000000 } }, result: "limit" }));
  assert.equal(five.limited, true);
  assert.equal(five.fableOut, false);
  assert.equal(five.limitType, "five_hour");
  assert.equal(sessionOutcome(result({ is_error: false, api_error: "model_requires_usage_credits" })).fableOut, false);
});

test("the CLI's own switch away from Fable and the models of the main turns are kept", () => {
  const o = sessionOutcome([
    JSON.stringify({ type: "system", subtype: "init", model: "claude-fable-5-2" }),
    JSON.stringify({ type: "system", subtype: "informational", content: "Switched to Opus for this session · Fable requires usage credits" }),
    turn("claude-opus-5-5"), turn("claude-sonnet-5-5", "toolu_1"), turn("<synthetic>"),
    result({ is_error: false, result: "done" }),
  ].join("\n"));
  assert.equal(o.switchedTo, "Opus");
  assert.deepEqual(o.mainModels, ["claude-opus-5-5"]);
  assert.equal(o.fableOut, false);
});

test("windowSpan spans the first and the last event, each window that either has", () => {
  const a = { five_hour: { utilization: 0.39 }, seven_day: { utilization: 0.32 } };
  const b = { five_hour: { utilization: 0.41 }, seven_day: { utilization: 0.33 }, seven_day_overage_included: { utilization: 0.17 } };
  assert.equal(windowSpan({ first: a, last: b }), "5h 39%→41% · 7d 32%→33% · fable ?→17%");
});

test("a limit result followed by the CLI's empty result is still a limit, with the earlier event's reset", () => {
  const o = sessionOutcome(fixture("session-limit-then-empty-2026-11-11.jsonl"), "", 1);
  assert.equal(o.limited, true);
  assert.equal(o.resetAt, 1794421800 * 1000 + 60_000);
  assert.equal(o.limitType, "five_hour");
  assert.equal(o.summary, "success (error), 5 turns, $12.84");
  assert.equal(o.transient, false);
});

test("empty results never decide when a real one exists; alone, one is a session that did nothing", () => {
  const empty = result({ is_error: false, num_turns: 0, result: "" });
  const limit = result({ is_error: true, api_error: "usage_limit_reached", num_turns: 5 });
  assert.equal(sessionOutcome([limit, empty, empty].join("\n")).limited, true);
  assert.equal(sessionOutcome([result({ num_turns: 9 }), empty, result({ num_turns: 4 })].join("\n")).summary, "success, 4 turns, $1.00");
  const alone = sessionOutcome(empty);
  assert.equal(alone.limited, false);
  assert.equal(alone.summary, "success, 0 turns, $1.00");
});

test("an errored session whose last words mention a rate limiter is not a usage limit", () => {
  const o = sessionOutcome(result({ subtype: "error_max_turns", is_error: true, num_turns: 200, result: "I finished the rate limiter module and its tests." }), "", 1);
  assert.equal(o.limited, false);
  assert.equal(o.transient, false);
  assert.equal(o.fatal, false);
});

test("an API or network failure is transient; a refused login is fatal", () => {
  const api = sessionOutcome(result({ subtype: "error_during_execution", is_error: true, num_turns: 0, result: "API Error: 500 Internal server error" }), "", 1);
  assert.deepEqual([api.transient, api.fatal, api.errorText], [true, false, "API Error: 500 Internal server error"]);
  const status = sessionOutcome(result({ is_error: true, api_error: "overloaded_error", api_error_status: 529, result: "Overloaded" }), "", 1);
  assert.equal(status.transient, true);
  const net = sessionOutcome("", "Error: getaddrinfo ENOTFOUND api.anthropic.com\n", 1);
  assert.deepEqual([net.transient, net.errorText], [true, "Error: getaddrinfo ENOTFOUND api.anthropic.com"]);
  const login = sessionOutcome(result({ is_error: true, api_error_status: 401, result: "Invalid API key · Please run /login" }), "", 1);
  assert.deepEqual([login.transient, login.fatal], [false, true]);
  assert.equal(sessionOutcome(result({})).transient, false);
});

test("a session the timer killed says so and is not retried as a transient error", () => {
  const o = sessionOutcome("", "", 1, { timedOut: true, hours: 4 });
  assert.deepEqual([o.timedOut, o.transient, o.summary], [true, false, "killed after 4 h (--session-hours)"]);
  const late = sessionOutcome(result({ num_turns: 30 }), "", 1, { timedOut: true, hours: 4 });
  assert.equal(late.summary, "success, 30 turns, $1.00; killed after 4 h (--session-hours)");
});

test("the status of an API error is exposed even when the CLI named no api_error", () => {
  const o = sessionOutcome(result({ is_error: true, api_error_status: 529, num_turns: 0, result: "Overloaded" }), "", 1);
  assert.deepEqual([o.transient, o.apiError, o.apiErrorStatus], [true, null, 529]);
  assert.equal(sessionOutcome(result({ is_error: true, api_error: "overloaded_error", api_error_status: 529 })).apiErrorStatus, 529);
  assert.equal(sessionOutcome(result({})).apiErrorStatus, null);
});

test("a timeout with no known hours says so without a number", () => {
  assert.equal(sessionOutcome("", "", 1, { timedOut: true }).summary, "killed (--session-hours)");
});

test("a cut session whose result text is empty still says why", () => {
  const status = sessionOutcome(result({ is_error: true, api_error_status: 529, num_turns: 0, result: "" }), "", 1);
  assert.equal(status.errorText, "API status 529");
  const named = sessionOutcome(result({ is_error: true, api_error: "overloaded_error", api_error_status: 529, num_turns: 0, result: "  " }), "", 1);
  assert.equal(named.errorText, "overloaded_error");
  const bare = sessionOutcome(result({ is_error: true, subtype: "error_during_execution", num_turns: 0, result: "" }), "", 1);
  assert.equal(bare.errorText, "no error text");
  assert.equal(sessionOutcome(result({ result: "" })).errorText, "");
});

// Test only (D): the paths below were believed right. Each would fail if its line in session-outcome.mjs went.
test("an empty trailing result never lowers the cost of the real one", () => {
  // Breaks if the empty-result branch assigns cost instead of taking the larger.
  const o = sessionOutcome([result({ num_turns: 4, total_cost_usd: 5 }), result({ num_turns: 0, result: "", total_cost_usd: 2 })].join("\n"));
  assert.equal(o.summary, "success, 4 turns, $5.00");
  assert.equal(sessionOutcome([result({ num_turns: 4, total_cost_usd: 5 }), result({ num_turns: 0, result: "", total_cost_usd: 7 })].join("\n")).summary, "success, 4 turns, $7.00");
});

test("a rate-limit event that is not rejected clears the rejected one a later limit result would borrow", () => {
  // Breaks if the `else if (j.rate_limit_info) lastRejected = null` line goes.
  const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1795000000 } });
  const allowed = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
  const hit = result({ is_error: true, api_error: "usage_limit_reached", num_turns: 5 });
  const stale = sessionOutcome([rejected, result({ is_error: true, subtype: "error_max_turns", result: "Reached max turns" }), hit].join("\n"));
  assert.equal(stale.resetAt, 1795000000 * 1000 + 60_000); // the control: with no event between, the earlier one is borrowed
  const cleared = sessionOutcome([rejected, result({ is_error: true, subtype: "error_max_turns", result: "Reached max turns" }), allowed, hit].join("\n"));
  assert.deepEqual([cleared.limited, cleared.limitInfo, cleared.resetAt], [true, null, null]);
});

// Session 32's final review: resulted and cost, read directly.
test("resulted and cost: a result line's dollars, none without one, and an empty trailing result that never lowers them", () => {
  const out = (stream, ...rest) => { const o = sessionOutcome(stream, ...rest); return [o.resulted, o.cost]; };
  assert.deepEqual(out(result({ total_cost_usd: 2.5 })), [true, 2.5]);
  // No result line: a crash, a kill or the timer's; no dollars.
  assert.deepEqual(out("", "boom", 1), [false, 0]);
  assert.deepEqual(out(turn("claude-opus-5-5"), "", null, { timedOut: true, hours: 4 }), [false, 0]);
  // An empty trailing result keeps the real one, at the larger of the two totals.
  assert.deepEqual(out([result({ num_turns: 4, total_cost_usd: 5 }), result({ num_turns: 0, result: "", total_cost_usd: 2 })].join("\n")), [true, 5]);
  assert.deepEqual(out([result({ num_turns: 4, total_cost_usd: 5 }), result({ num_turns: 0, result: "", total_cost_usd: 7 })].join("\n")), [true, 7]);
  // Alone, an empty result is still a result: a session that did nothing, at its own cost.
  assert.deepEqual(out(result({ num_turns: 0, result: "", total_cost_usd: 0.1 })), [true, 0.1]);
  // A later real result (a resumed part) carries the conversation's whole total: it replaces the earlier one, never adds.
  assert.deepEqual(out([result({ total_cost_usd: 1 }), result({ num_turns: 2, total_cost_usd: 3 })].join("\n")), [true, 3]);
  // A total that is missing or not a number costs nothing.
  assert.deepEqual(out(result({ total_cost_usd: undefined })), [true, 0]);
  assert.deepEqual(out(result({ total_cost_usd: "x" })), [true, 0]);
});

test("a rate_limit_event without unifiedWindows or without rate_limit_info is the event, with no window, and one without rate_limit_info clears no rejection", () => {
  const bare = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }), noInfo = JSON.stringify({ type: "rate_limit_event" });
  for (const ev of [bare, noInfo]) {
    const o = sessionOutcome([ev, turn("claude-opus-5-5"), result({})].join("\n"));
    assert.deepEqual(o.fields, ["rate_limit_event"]);
    assert.deepEqual([o.windows.first, o.windows.last, o.windows.latest, o.limited], [null, null, {}, false]);
    // An earlier event's windows stay the last ones read.
    const after = sessionOutcome([limitEvent({ five_hour: { utilization: 0.4 } }), ev, turn("claude-opus-5-5"), result({})].join("\n"));
    assert.deepEqual([after.windows.last, after.windows.latest], [{ five_hour: { utilization: 0.4 } }, { five_hour: { utilization: 0.4 } }]);
  }
  // Without rate_limit_info an event says nothing of a rejection: a limit result still borrows the earlier rejected one.
  const rejected = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: 1795000000 } });
  const hit = result({ is_error: true, api_error: "usage_limit_reached", num_turns: 5 });
  const o = sessionOutcome([rejected, result({ is_error: true, subtype: "error_max_turns", result: "Reached max turns" }), noInfo, hit].join("\n"));
  assert.deepEqual([o.limited, o.resetAt], [true, 1795000000 * 1000 + 60_000]);
});

// Mythos, measured 2026-11-18 with claude 2.1.327 (the two probe streams, cut to what is read here).
test("a session the CLI refused its model (--model mythos: a 404, no turn on any model) is modelUnavailable and fatal", () => {
  const o = sessionOutcome(fixture("session-mythos-word-2026-11-18.jsonl"), "", 1);
  assert.deepEqual([o.modelUnavailable, o.fatal, o.transient, o.limited, o.fableOut], [true, true, false, false, false]);
  assert.deepEqual([o.model, o.mainModels, o.apiErrorStatus], ["mythos", [], 404]);
  assert.match(o.errorText, /^There's an issue with the selected model \(mythos\)/);
  assert.equal(o.sessionId, "00000000-0000-4000-8000-000000000007");
});
test("a Mythos session by its id runs on Mythos and reports Fable's window", () => {
  const o = sessionOutcome(fixture("session-mythos-id-2026-11-18.jsonl"), "", 0);
  assert.deepEqual([o.modelUnavailable, o.fatal, o.transient, o.limited, o.fableOut], [false, false, false, false, false]);
  assert.deepEqual([o.model, o.mainModels], ["claude-mythos-5-2", ["claude-mythos-5-2"]]);
  assert.equal(o.windows.last.seven_day_overage_included.utilization, 0.59);
  assert.equal(windowSpan(o.windows), "5h 13%→13% · 7d 73%→73% · fable 59%→59%");
  assert.equal(o.summary, "success, 1 turns, $1.24");
});
test("a 404 after a turn on a model, a subagent's too, is no unavailable model", () => {
  const notFound = result({ is_error: true, api_error_status: 404, num_turns: 2, result: "API Error: 404 not found" });
  const main = sessionOutcome([turn("claude-opus-5-5"), notFound].join("\n"));
  assert.deepEqual([main.modelUnavailable, main.fatal], [false, true]);
  assert.equal(sessionOutcome([turn("claude-sonnet-5-5", "toolu_1"), notFound].join("\n")).modelUnavailable, false);
  assert.equal(sessionOutcome([turn("<synthetic>"), notFound].join("\n")).modelUnavailable, true);
  // Other statuses, and a session that finished, are not it.
  assert.equal(sessionOutcome(result({ is_error: true, api_error_status: 403, num_turns: 1 })).modelUnavailable, false);
  assert.equal(sessionOutcome(result({ is_error: false, api_error_status: 404 })).modelUnavailable, false);
});

test("with several rejected windows and no reset of its own, the smallest window's reset is used", () => {
  // Breaks if the fallback takes the largest, or the first, of the rejected windows' resets.
  const event = JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", unifiedWindows: {
    seven_day: { status: "rejected", resetsAt: 1795900000 }, five_hour: { status: "rejected", resetsAt: 1795000000 }, seven_day_overage_included: { status: "allowed", resetsAt: 1790000000 } } } });
  const o = sessionOutcome([event, result({ is_error: true, api_error: "usage_limit_reached", num_turns: 5 })].join("\n"));
  assert.equal(o.limited, true);
  assert.equal(o.resetAt, 1795000000 * 1000 + 60_000);
});

// U14: the stream fields the runner decides on are the CLI's undocumented ones; a rename must not blind the checks in silence.
test("a session's outcome names the known stream fields its stream carried", () => {
  const o = sessionOutcome([limitEvent({ five_hour: { utilization: 0.4 } }), limitEvent({ seven_day: { utilization: 0.8 }, other: {} }), turn("claude-opus-5-5"), result({})].join("\n"));
  assert.deepEqual(o.fields, ["rate_limit_event", "unifiedWindows.five_hour", "unifiedWindows.seven_day"]);
  assert.deepEqual(sessionOutcome([turn("claude-opus-5-5"), result({})].join("\n")).fields, []);
  // A window whose share is gone (a renamed utilization) is no reading: it counts as missing.
  assert.deepEqual(sessionOutcome([limitEvent({ five_hour: { utilization: 0.4 }, seven_day: { used: 0.8 } }), turn("claude-opus-5-5"), result({})].join("\n")).fields,
    ["rate_limit_event", "unifiedWindows.five_hour"]);
});

test("each window's latest reading is kept, also when the session's last event lacks it", () => {
  const o = sessionOutcome([limitEvent({ five_hour: { utilization: 0.4 }, seven_day: { utilization: 0.81, resetsAt: 1795000000 } }),
    limitEvent({ five_hour: { utilization: 0.5 } }), turn("claude-opus-5-5"), result({})].join("\n"));
  assert.equal(o.windows.last.seven_day, undefined);
  assert.deepEqual(o.windows.latest, { five_hour: { utilization: 0.5 }, seven_day: { utilization: 0.81, resetsAt: 1795000000 } });
  assert.deepEqual(sessionOutcome(result({})).windows.latest, {});
});

test("a field earlier sessions had and a session with turns lacks is gone, once per chain", () => {
  const all = ["rate_limit_event", "unifiedWindows.five_hour", "unifiedWindows.seven_day"];
  let r = fieldsGone({ fields: all, turns: true });
  assert.deepEqual(r.gone, []);
  assert.deepEqual(r.memo, { seen: all, told: [] });
  // A session with no turn made no call: its stream says nothing about the fields.
  assert.deepEqual(fieldsGone({ fields: [], turns: false }, r.memo).gone, []);
  r = fieldsGone({ fields: ["rate_limit_event", "unifiedWindows.five_hour"], turns: true }, r.memo);
  assert.deepEqual(r.gone, ["unifiedWindows.seven_day"]);
  assert.deepEqual(fieldsGone({ fields: ["rate_limit_event"], turns: true }, r.memo).gone, ["unifiedWindows.five_hour"], "seven_day was told already");
  // The whole event gone is one line, not one per window.
  assert.deepEqual(fieldsGone({ fields: [], turns: true }, { seen: all, told: [] }).gone, ["rate_limit_event"]);
});

test("Fable's window is expected only of a session that ran on Fable or Mythos", () => {
  const fable = ["rate_limit_event", "unifiedWindows.seven_day", "unifiedWindows.seven_day_overage_included"];
  const memo = fieldsGone({ fields: fable, turns: true, premium: true }).memo;
  assert.deepEqual(fieldsGone({ fields: ["rate_limit_event", "unifiedWindows.seven_day"], turns: true }, memo).gone, []);
  assert.deepEqual(fieldsGone({ fields: ["rate_limit_event", "unifiedWindows.seven_day"], turns: true, premium: true }, memo).gone, ["unifiedWindows.seven_day_overage_included"]);
});

test("with a weekly ceiling, a seven-day window that never came is told once", () => {
  let r = fieldsGone({ fields: [], turns: true }, undefined, { ceiling: 0.8 });
  assert.equal(r.ceilingBlind, true);
  assert.equal(fieldsGone({ fields: [], turns: true }, r.memo, { ceiling: 0.8 }).ceilingBlind, false);
  assert.equal(fieldsGone({ fields: [], turns: true }).ceilingBlind, false, "no ceiling, nothing to tell");
  assert.equal(fieldsGone({ fields: ["rate_limit_event", "unifiedWindows.seven_day"], turns: true }, undefined, { ceiling: 0.8 }).ceilingBlind, false);
  // An old memo file that lacks a list reads as empty.
  assert.deepEqual(fieldsGone({ fields: ["rate_limit_event"], turns: true }, {}).memo, { seen: ["rate_limit_event"], told: [] });
});
