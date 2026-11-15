// node --test scripts/session-outcome.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sessionOutcome, windowSpan } from "./session-outcome.mjs";

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
