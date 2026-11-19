# Changelog

What each version brought, newest first. The code knows its version (`scripts/version.mjs`, printed by `night-chain.mjs --version` and kept in each run's `run.json`); a version with a pre-release part, such as `0.3.0-dev`, is the unreleased part below. Versions 0.1.0 and 0.2.0 were never tagged: each names the commit range of `main` it covers. Commit messages say the rest (`git log`).

## 0.3.0 (unreleased)

Not on `main` yet: the commits after `2c14b8b`.

### Added

- `--mode mythos` and `MODEL: mythos`: Mythos on Fable's seat, sharing its weekly allowance and ceiling.
- `start --goal <text>` and `--goal-file <file>`: a chain from a goal with no roadmap; its first session writes the roadmap, has it reviewed and approves it, and the work starts in the session after it.
- `start --worktree` (`"worktree": true`): the chain works in its own git worktree, `<parent>/<repo>-night` on the branch `night-shift`, made by the first such start and kept for the next, so the main tree stays yours while it runs. The guard reads the project's file in the main tree and protects its rule files and `.git`; the runner checks the worktree before each session, and never merges the branch or removes the worktree.
- `start --attended` (`"attended": true`): for a job by day. Sessions write a question that needs you to `<state>/questions.md` and go on; the watcher sends each as a card, and `wait` wakes on it with exit 3.
- A webhook for the cards, beside Telegram or instead of it: `~/.claude/night-shift/webhook.json` holds a URL and, when the URL does not say, its kind (`ntfy`, `slack` or `discord`); the watcher, `notify` and `card --send` post each card there as plain text (ntfy's body, Slack's `text`, Discord's `content`), and the bot's commands stay Telegram's. `doctor` shows its kind and host, and warns for a file it cannot use or for plain `http:` to a host that is not private or local.
- Phone commands in the Telegram bot's chat: `/stop` and `/stop now`, and `/inbox <text>`, which is off until the global config sets `"telegramInbox": true`.
- Caps: `weeklyCeiling` (`--weekly-ceiling`) for the seven-day window and `maxUsd` (`--max-usd`) for a start's dollars, each ending the chain with `next-prompt.md` kept; no session starts at or over 90 % of the five-hour window, the chain waits for its reset.
- `"mcp"` as a list of server names: a session starts only those servers, each from its own config.
- The night report's Tokens part shows each job's starting context; a handover prompt over 12 KB is flagged, on its card too.
- `night-chain.mjs --version`, a `version` in `run.json`, this changelog, and `package.json` with `npm test` (the suite and the guard's self-test).
- `examples/`: a small roadmap, a first prompt and a project rules file.
- `clock` in a language table: the times on the cards and in the report, 24-hour `HH:MM` in English; a table may give a 12-hour clock. `chain.log`, `watch.log`, the night report's section headings and a `chain.log` line quoted as it is (a chain's ending reason) keep `HH:MM`.
- `CONTRIBUTING.md`, and issue forms for a bug report (it asks for `--version` and `doctor`'s output) and a feature request.
- A plugin manifest and marketplace (`.claude-plugin/`): `claude plugin install night-shift@night-shift` installs the skill as a plugin, beside copying the folder; the guard protects either copy (README, "Install").

### Changed

- What differs by system is in one module, `scripts/platform.mjs`, with Windows behind it and no change in behaviour. On macOS and Linux the guard reads paths as those systems do (case, backslashes, `/tmp`, their system and login folders), and the runner finds, watches, waits for and stops processes, keeps the machine awake (`caffeinate`, `systemd-inhibit`) and looks for `claude` as they do; `start` runs the runner there as a detached process (its own session, Node's errors in `<state>/runner.err`, which the guard protects), and `--window` is for Windows only. README's "Systems" says what differs; macOS and Linux are untested on real machines. The tests judge their Windows-shaped cases by Windows' rules on every system, and a test that needs Windows itself skips elsewhere with its reason.
- README opens with what the skill is for, by night or by day, and a quick start: install, `init`, `doctor`, a first chain from `examples/`.
- `--max-sessions <n>` counts the sessions a `start` runs; it was the number of the last session.
- English is the only language in the repository: the bundled Turkish table left it, and any other language is a table you keep in `~/.claude/night-shift/lang/<code>.mjs`.
- Each mode's rules moved from `SKILL.md` into `references/mode-<mode>.md`, which the runner puts into a new session's header.
- Chain sessions refuse messages from your other Claude Code sessions (`crossSessionInbound: "refuse"`); their own subagents' results still arrive.
- A project's `.claude/night-shift.json` may lower `fableCeiling`, `fableSessions`, `weeklyCeiling` and `maxUsd` but not raise them; `start`'s flag for a cap is your word and wins.
- `CLAUDE_CONFIG_DIR` is followed by the runner, the guard and the report.
- The guard knows a linked `~/.claude`, refuses `git config` of a remote's URL and a push to a URL, reads the project's rules on written paths too, and protects the caps' count, the waiter's marks and your stop request in the state folder, the copy of the skill a chain runs from wherever it is (unless it is inside the chain's repository), and Claude Code's installed plugins, also from a delete or a move of a folder that holds them; `doctor`'s `skill` row says whether the guard protects the copy.
- The models the runner knows are one table, `MODEL_TABLE` in `scripts/effort.mjs` (each family's word, what `--model` gets, its seat and its default level); the rest of the code reads it, so a new model id is a change to its row, and a new name for Fable's seat a row with its `references/mode-<name>.md`. No change in behaviour.

### Fixed

- A session that writes STOP after `--until` ends the chain with its reason; a killed or crashed session counts against `--max-usd`; the report counts only real guard denials; many smaller fixes (`git log 2c14b8b..`).

## 0.2.0 (2026-11-16 to 2026-11-18, `c83fae8..2c14b8b`)

- A usage limit whose reset is too far away ends the chain (`--max-wait-hours`), a limit an empty result line follows is read, and a session the limit cut off after it wrote STOP finishes the chain; API and network failures are waited out; a session the timer killed and a runner crash are named.
- The guard reads commands by their words: wrappers (`bash -c`, `powershell -c`, `eval`, `xargs`, `find -exec`), git's abbreviations, aliases and its config, include and transport routes, deletes through globs, braces and pipes, stream and short paths; a call it cannot check is denied.
- MCP tools are refused unless `.claude/night-shift.json` lists their server.
- Telegram cards are sent until Telegram takes them, long reports split between lines, and the token stays out of the watcher's log.
- Modes (`--mode opus|fable`), a global config file below the project's, your rule files (global and per project) in every session's header and protected by the guard, and a language setting (`lang`) with English and Turkish tables.
- A STOP written by the last session `--max-sessions` allows ends the chain with its reason.
- The skill's texts say nothing of one person's setup.

## 0.1.0 (2026-11-15, `ca5fb74..c2f071d`)

- The first public version: `night-chain.mjs` chains fresh headless sessions through `<state>/next-prompt.md`, started through Task Scheduler (`start`, `status`, `wait`, `stop`, `reload`, `run`), waiting out a usage limit and resuming the session it cut off; the guard hook; the night report and its Telegram cards.
- Hardening after a security review, and `MODEL: fable` for one hard piece, behind a gate on Fable's weekly allowance.
