// node --test scripts/session-outcome.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { sessionOutcome } from "./session-outcome.mjs";

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
