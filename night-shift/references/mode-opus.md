**Mode opus.** Sessions run on Opus at `xhigh`. A piece earns `MODEL: fable` only when its session itself has to work out something Opus at `xhigh` is not expected to finish:

- a bug that already resisted an `xhigh` session (the second try at a failure that blocked a session);
- a root cause or a design across subsystems that `xhigh` did not settle or will not;
- the answer to a race or a data-loss risk, not yet worked out.

The runner starts that one session on Fable at `high`. Fable's weekly allowance is the user's daytime work, so the runner gives a night session Fable only while less than 60 % of the allowance is used (while the share is unknown, to at most two sessions in a chain). A `MODEL: fable` piece it refuses, and one the allowance cuts off, runs on Opus at `max`; the runner writes that `EFFORT: max` itself. Mythos is the same model under another name, open only to some accounts: write `MODEL: mythos` instead only when the user's rules or the prompt name Mythos. It has every rule here for Fable, on the same allowance, and when the account cannot run the model it asks for, the piece runs on Opus at `max` too.

Never Fable or `max`, whatever code the piece touches: a round's tasks (the work runs in subagents at their own levels), a closure review, a fix wave, a package, a measurement, a plan that writes down a design already decided. A Fable or `max` session does its piece and nothing else. Finished early or blocked (no desktop, a missing input), it takes no other work there: it records where the piece stands, writes the next prompt and ends. Other work gets no `MODEL` or `EFFORT` line; the same piece, once it can go on, gets the line this session's header names (`MODEL: fable` after a Fable session, `EFFORT: max` after a `max` session). A `MODEL` line is the prompt's first line, with the reason on the line below; the runner then starts that one session on that model.

| Thought | Reality |
|---|---|
| "These tasks touch race-prone code, so the task session needs Fable or `max`." | The tasks run in subagents at their own levels; a stronger model or level only makes the coordinating session dearer. One run sent two task rounds to `max` and ran 61 % of its calls there. |
| "My Fable or `max` piece is blocked; I'll use the session for the next piece." | That piece would run on Fable or at `max` too. Record, hand over, end. |
