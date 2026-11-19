# night-shift

A [Claude Code](https://claude.com/claude-code) skill that keeps work going for hours while you are away, such as overnight.

It runs a chain of fresh headless sessions (`claude -p`). Each session is like opening a fresh chat and pasting a continuation prompt. A session does one finished piece of an approved plan, commits it, adds its section to a night report and writes the prompt for the next session. The chain stops when a session writes `STOP`, when two handovers fail in a row, or when you stop it. When it hits a usage limit, it waits for the reset and resumes the same session.

## Read this first

- **Windows only.** The runner starts itself through Task Scheduler in a hidden console (`conhost --headless`) and uses PowerShell, so it keeps running after your editor closes.
- **It runs unattended with no permission prompts.** Sessions run with `--permission-mode auto --permission-prompts none`, and `AskUserQuestion` and plan mode are turned off. `scripts/guard.mjs` is a hook that blocks dangerous commands (see below). It is a safety net, not a sandbox. Run it only on a repository you have committed and can restore. The runner's settings layer also sets `crossSessionInbound` to `refuse`: a message from another of your Claude Code sessions is not your word, so the chain's sessions take none (each still gets its own subagents' results).
- **It costs tokens.** By default (mode `opus`) every session runs Opus at `xhigh`, subagents run Sonnet at `medium` and Haiku at `high`, and the chain has no end time. Use `--max-sessions` or `--until` if you want a limit. A session whose prompt opens with `MODEL: fable` runs on Fable at `high`; `references/mode-opus.md`, the rules every session of mode `opus` gets in its header, allows that for one hard piece only. Fable has its own weekly allowance, so the runner grants it only while less than 60 % of that allowance is used, and to at most two sessions in a chain while the share is unknown. A piece it refuses, or one the allowance cuts off, runs on Opus at `max`. Mythos, which Anthropic opens only to organizations it has verified, is the same model as Fable under another name and draws on the same weekly allowance: everything this page says about Fable's allowance, its ceiling and its count holds for the two together, and `MODEL: mythos` works as `MODEL: fable` does. See "Modes" for the other modes.

## Requirements

- Windows 10 or 11
- Node.js 22 or later; nothing to install from npm, the skill uses Node's built-ins only
- The Claude Code CLI, installed globally with npm or with the native installer (`~/.local/bin/claude.exe`). The runner looks only in those places, not on `PATH`; for any other location, set `NIGHT_SHIFT_CLAUDE` to the path of `claude.exe`.
- git; the target repository must have no uncommitted changes before a start

## Install

Copy the `night-shift` folder to `~/.claude/skills/night-shift/`. The guard protects the skill's files at that path from night sessions, so a copy anywhere else is not protected; the commands below use it too. If you set `CLAUDE_CONFIG_DIR`, Claude Code keeps its folder there instead, and so does this skill: read that folder wherever this page says `~/.claude` (the runner, the guard and the report follow it, and the guard protects `~/.claude` as well). `status`, `stop` and `wait` find a run only from a shell that has the variable too.

```bash
git clone https://github.com/<you>/<this-repo>.git
cp -r <this-repo>/night-shift ~/.claude/skills/night-shift
```

## Use

In a Claude Code chat, ask for a night shift ("run a night shift on the plan in docs/plan.md until it is done"). A night session's prompt opens with `Night shift (night-shift)`; that is how the skill knows it is inside one. The skill's `references/interactive.md` tells Claude how to write the first prompt, start the chain and report back when it ends.

You can also drive the runner yourself:

```bash
node ~/.claude/skills/night-shift/scripts/night-chain.mjs start  --repo <dir> --prompt-file <file>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs start  --repo <dir> --goal <text>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs status --repo <dir>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs wait   --repo <dir>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs stop   --repo <dir> [--now]
node ~/.claude/skills/night-shift/scripts/night-chain.mjs reload --repo <dir>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs init   --repo <dir>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs doctor [--repo <dir>]
node ~/.claude/skills/night-shift/scripts/night-chain.mjs --version
```

`doctor` checks what a start needs without starting anything, one line a check (`ok`, `warn`, `skip` or `FAIL`), and exits 1 on a `FAIL`: the skill's copy (whole, and whether it is the one at `~/.claude/skills/night-shift` whose files the guard protects); Node, git and the CLI; your config file and the project's, read as `start` reads them with no flags, so a cap the project's file raises fails with `start`'s message; the model the mode gives; the rule files; the language table; the project's `"mcp"` list; the state folder a start would use today (it makes a probe folder in it, or in its nearest folder that exists, and removes it); the guard's self-test; the guard run as the hook the runner writes, on a call it must refuse and one it must let through; and a `~/.claude` that is a link, whose settings the guard must refuse by the target's path too. It makes no network or model call. Without `--repo` it checks the repository the current folder is in, or only your own files outside one. Run it after installing and on a repository that has not run a chain yet.

`init --repo <dir>` writes a starter `.claude/night-shift.json` (the defaults written out, with examples as comments; it sets nothing your own `config.json` sets) and a rules file skeleton, `.claude/night-shift-rules.md`, which is all comment until you write below it. It never writes over a file that exists, and it prints the next steps: commit the two files (`start` wants a committed tree), run `doctor`, start a chain.

A chain works from an approved roadmap: the pieces in order, each one session's work. Without one, give `start` the goal instead of a prompt, with `--goal <text>` or `--goal-file <file>` (one of the two, and never beside `--prompt` or `--prompt-file`). The runner wraps it in the planning prompt `references/goal.md`. The first session reads the repository and your recorded preferences, writes the roadmap (the pieces in order, what done looks like for each, the checks, what is out of scope), has one reviewer check it, marks it approved and commits it; the work starts in the second session. The goal approves the work it needs and nothing beyond it. Keep a long specification in the repository and name it in the goal ("the spec in docs/spec.md"): the first session reads the goal again in every call. Like a prompt, a goal starts fresh: it replaces a kept `next-prompt.md` and a session kept in `resume.json`.

Start with `--attended` (or set `"attended": true`) when you are at hand but not watching, for a job by day. No session waits for you and `AskUserQuestion` stays off, as at night. But a decision that needs you (one that passes the five tests, or a hard stop the work meets, such as a push you can do by hand) is written at once to `<state>/questions.md`, one line each: `Q<n> · <time> · question · the session's pick and why · what changes otherwise`. When Telegram is set up, the watcher sends each new line to your chat as it appears. The piece that depends on it goes behind the other work. Answer with a line `A<n>: <answer>` in `<state>/inbox.md`; the next session applies the answers before anything else. When nothing else is left ahead of it and no answer has come, the session builds its pick, as an unattended run does. The rules are in `references/attended.md`, which only an attended run's sessions get. `--attended false` turns a config's `true` off for one start. `wait` (in the commands above) also wakes on each new question: it prints the question and how to answer, and exits 3 while the chain goes on; run it again to wait on. A Claude Code chat that started the chain does this for you and writes your answer into the inbox, and with Remote Control (`/remote-control` in that chat) you can answer from your phone without Telegram.

`start` also takes `--until HH:MM`, `--max-sessions <n>` (the sessions this `start` runs, counted from the first, also in an earlier run's folder), `--session-hours <h>`, `--model <m>`, `--effort <level>`, `--fable-ceiling <share>`, `--fable-sessions <n>`, `--mode opus|fable|mythos`, `--attended [true|false]`, `--lang <code>`, `--max-wait-hours <h>` (the longest wait for a usage limit or an outage, default 6), `--weekly-ceiling <share>`, `--max-usd <dollars>`, `--state <dir>` (continue in an earlier run's folder) and `--window` (a visible console; closing it stops the chain). A value of the wrong shape for any of them stops `start` and names the flag; a flag with a config key below takes the values that key takes. `start` without a prompt goes on from a session a limit or an error cut off, kept in `<state>/resume.json`.

While a chain runs, write new work or changed rules into `<state>/inbox.md`. The next session reads that file first.

### Per-project settings

Put a `.claude/night-shift.json` in the target repository. Every key is optional, and a key the runner does not know is an error: `start` refuses to run and names it (a key that starts with `_` or `$` is a comment). The guard reads the same file and, while it is invalid, refuses every shell command and MCP tool.

```json
{
  "stateDir": "C:/temp/my-app-night-{date}",
  "report": "docs/NIGHT_RUNS.md",
  "lessons": "docs/agents/NOTES.md",
  "mode": "opus",
  "lang": "en",
  "model": "opus",
  "effort": "xhigh",
  "fableCeiling": 0.6,
  "fableSessions": 2,
  "maxWaitHours": 6,
  "weeklyCeiling": 0.8,
  "mcp": "none",
  "attended": false,
  "deny": [
    { "pattern": "\\bmy-app\\.exe\\b", "reason": "that is the app running on my desktop" }
  ]
}
```

- `stateDir`: the folder for the chain's log, prompts and inbox. The default is `<temp>/night-shift-<repo>-{date}`, inside your own profile. A folder under `C:/temp` is shorter to type, but on a PC with other accounts those users can write there too, and the next session reads `inbox.md` and `next-prompt.md` from this folder as instructions. On a shared PC keep the default. A drive root, a folder directly below one, your home folder, the repository, the temp folder itself, `.git` and `~/.claude` are refused.
- `report`: the night report. The default is `NIGHT_RUNS.md`.
- `lessons`: the notes file where sessions keep lessons that outlast one session.
- `mode`: `"opus"` (the default), `"fable"` or `"mythos"` (see "Modes").
- `lang`: the language of what you read; `"en"` is the default (see "Language").
- `model`, `effort`: what a session runs on when its prompt names neither. What `model` means depends on the mode (see "Modes").
- `fableCeiling`, `fableSessions`: in mode `opus`, the share of the weekly allowance Fable and Mythos share at or over which a `MODEL: fable` or `MODEL: mythos` prompt runs on Opus at `max` instead, and how many sessions on either a chain may run while that share is unknown (the two count together). In mode `fable` or `mythos`, `fableCeiling` is the share at or over which sessions run on Opus at `xhigh` until the reset, and `fableSessions` does not apply. The keys and their flags keep Fable's name for both models.
- `maxWaitHours`: the longest the chain waits for a usage limit to reset or for an outage to pass (see "When a session fails"). The default is 6.
- `weeklyCeiling`: the share of your seven-day usage window at or over which no new session starts, as a ratio (`0.8`) or a percentage (`80`; so `1` means 100 %). The chain ends then (`the seven-day window is at …`) and keeps `next-prompt.md`, so a later `start --state <that folder>` goes on once the window resets. A session a limit or an error cut off still finishes first, since its work may not be committed yet. There is no ceiling by default. If the same allowance also pays for your daytime work, set `0.8`: a night session takes one or two points of the window, and the check comes before each session, so the chain stops at about 80 % and leaves a fifth of the week for the day. The runner reads the share from the stream's `rate_limit_event`; when that field stops arriving, `chain.log` and the card say so once (`stream field … stopped arriving`), so the ceiling never stops checking in silence. A chain in a new state folder reads the window in its first session.
- `maxUsd`: the dollars the sessions of one `start` may cost, at or over which no new session starts. The chain ends then (`this start's sessions cost …`) and keeps `next-prompt.md`; a session a limit or an error cut off still finishes first. The runner adds up what the CLI reports for each session (the `$` in `chain.log`'s `ends` line), a resumed conversation once. A session that ends with no result line (killed at `--session-hours`, crashed) reports nothing; it counts what its transcript is priced at, at the other sessions' dollars per token of each model (nothing while none of them has reported dollars for its model), and `chain.log` says so. It checks between sessions, so a chain can go over the cap by the cost of its last session; the CLI's own `--max-budget-usd` would instead stop a session in the middle of its piece, with its work uncommitted. A later `start` counts from zero. There is no cap by default. On a subscription these dollars are list prices, not what you pay, and the usage windows bind first: use `weeklyCeiling` there; `maxUsd` is for an API key.
- `mcp`: `"none"` (the default), a list of server names, or `"inherit"`. With `"none"` a night session starts no MCP server and the guard refuses every `mcp__` tool. A list (`"mcp": ["my-server"]`) starts only the servers it names, each from its own config (`--strict-mcp-config` with `--mcp-config`), so no other server's tools fill the context: one of yours or of this repository in `~/.claude.json` (what `claude mcp add` writes), one in the repository's `.mcp.json`, or an installed plugin's, written `plugin:<plugin>:<server>` as `claude mcp list` shows it (or as its tools spell it, `plugin_<plugin>_<server>`). `start` refuses a name no config holds, and prints where each listed server comes from; an empty list starts none. A claude.ai connector and a server packed as an `.mcpb` bundle have no config to copy: they start only with `"inherit"`, which starts every server you have, as an interactive session does, and lets all their tools through.
- `attended`: `true` makes every `start` an attended run (see "Use"); `--attended false` turns it off for one start. The default is `false`.
- `deny`: your own guard rules. `pattern` is a regular expression and `flags` defaults to `i`. A rule reads the text of each Bash and PowerShell command, and the path of each file a Write, Edit, MultiEdit or NotebookEdit call writes, with forward slashes, both as given and from the repository down (so `^secrets/` means the folder at the repository's root). It does not read MCP calls, or what a program writes on its own.

### Modes

`mode` in the project file, or `--mode` on `start`, picks how the chain uses models.

- **`opus`** (the default): every session runs on Opus at `xhigh`. A session whose prompt opens with `MODEL: fable` (or `MODEL: mythos`) runs on that model at `high`, for one hard piece, while the gate allows it (see above). A session on a model your account cannot run (the CLI refuses it as not found before any turn) does not end the chain: its piece runs on Opus at `max`, and so does every later ask for that model in the chain.
- **`fable`**: every session runs on Fable at `high`. While Fable's weekly share is at or over `fableCeiling` (default 0.6), or used up, sessions run on Opus at `xhigh` until the reset. The runner never picks `max` in this mode. `effort` is Fable's level there: the sample config's `"effort": "xhigh"`, or a global `effort`, runs every Fable session at `xhigh` instead of `high`, and a `max` you set runs them all at `max`. The Opus fallback stays at `xhigh`.
- **`mythos`**: mode `fable` with Mythos as the main model, for an account Mythos is open to. Everything said for `fable` holds, on the same allowance and the same `fableCeiling`.

In mode `fable` or `mythos`, a prompt that opens with `MODEL: opus` runs that session on the Opus fallback, and one that names the other of the two models stays on the main model (they are one model; `chain.log` notes it). A main model your account cannot run ends the chain (`session NN cannot run: …`): pick another mode.

What `model` means: in mode `opus` it is the main model, and any model that is not Fable or Mythos passes. In mode `fable` or `mythos` an id of that model is the main model and an Opus id is the fallback. `--model fable` alone means mode `fable`, and `--model mythos` alone means mode `mythos` on the model id `claude-mythos-5-2` (the CLI has no `mythos` alias). `--mode opus` with a Fable or Mythos model is refused, and so is a Mythos model in mode `fable` or a Fable model in mode `mythos`.

The limit: the allowance's share arrives only on Fable or Mythos calls. If the CLI never reports it, mode `fable` or `mythos` uses its main model until the weekly allowance runs out, then Opus until the reset.

### Your rules

Write rules in plain text, in any language, in either file:

- `~/.claude/night-shift/rules.md`: for every project.
- `<repo>/.claude/night-shift-rules.md`: for one project. Its rules win over the global ones, and both win over the skill's defaults.

Text between `<!--` and `-->` is a comment that reaches no session when its `<!--` starts a line, outside a ```` ``` ```` code block (a `<!--` inside a line is text, so a rule can name it); `init` writes the project's file as one such comment. Each file, comments included, is at most 8 KB (UTF-8 bytes) and is read again at every session start, so an edit takes effect on the next session. `start` and `status` name the files in force. A file that grows too big or cannot be read mid-chain keeps its last text, and the log and Telegram say so; a file you empty or remove drops out. A project rule file is a file in the repository: commit it (or ignore it in git) before `start`, which refuses a working tree with uncommitted changes, an untracked file included (`--allow-dirty` exists).

| A rule can change | A rule cannot change |
|---|---|
| The five tests that decide which decisions wait for you (`night-shift/SKILL.md`, "What reaches the user") | What the guard refuses: merges, branch deletes, history rewrites, force pushes |
| How work is split into pieces | Deletes outside the repository and temp folders |
| The stops the guard does not enforce: live desktop, physical tests, messages, work outside the roadmap | Publishing |
| When a session asks for another model | Writes to the skill, Claude settings, the config files and the rule files |

### Language

`lang` (`--lang` on `start`) sets the language of what you read: the Telegram cards, the `/status` and `/report` answers, the `status` and `wait` output, dates and units. The skill ships English, `en`, the default. Any other language is a table you own: copy `night-shift/scripts/lang/en.mjs` to `~/.claude/night-shift/lang/<code>.mjs` (a lowercase code such as `de` or `pt-br`), translate its strings, and set `lang` to that code. Besides the strings, the table gives the language's English name (`name`; each session is told the language the night report is written in, and a table without one is named by its code), names for the bot's commands in that language (`cmdStatus`, `cmdReport`, `cmdStop`, `cmdInbox`: up to 32 lowercase letters, digits or `_`, as Telegram takes them, none another command's English name or a name an earlier one took, else that one reads English; their menu texts, `cmdStatusDesc`, `cmdReportDesc`, `cmdStopDesc` and `cmdInboxDesc`, take 1 to 256 characters, else that one reads English; `/status`, `/report`, `/stop` and `/inbox` always answer), the word after `/stop` that stops at once (`cmdNow`, one word; `now` always does) and the phrase that follows `docs: ` in a night-report commit (`reportCommit`; `night report` always counts). A key the table lacks reads English, so a table written for an older version keeps working after an update. `start` refuses a code whose table is missing or does not load, and names the file; a runner or watcher that cannot load it later reads English and says so once in its log. Earlier versions shipped a `tr` table in the skill folder; a config that names `tr` now needs that table in `~/.claude/night-shift/lang/tr.mjs` (it is in this repository's history: `git show 4a566e4:night-shift/scripts/lang/tr.mjs`). A language table is code that the runner and the watcher import and run, like a hook. Everything the model reads (prompts, headers, notes) stays English.

### Global settings

`~/.claude/night-shift/config.json` holds defaults for every project. It takes ten keys: `mode`, `lang`, `effort`, `fableCeiling`, `fableSessions`, `maxWaitHours`, `weeklyCeiling`, `maxUsd`, `attended` and `telegramInbox` (only here: a project file that holds it stops `start`). Any other key, bad JSON or a value of the wrong type stops `start` and names the file. A setting comes from the first of these that has it: the command-line flag, the project file `.claude/night-shift.json`, the global file, the default. The four caps on what a chain spends, `fableCeiling`, `fableSessions`, `weeklyCeiling` and `maxUsd`, are the exception: a repository's file may come from someone else, so it may lower what applies without it (your global value, else the default) but not raise it. A raise stops `start`, naming the key, both values and the flag to pass instead (`--max-usd 100`): a flag is your own word and wins, and with it the file's value is not used.

## The guard

`scripts/guard.mjs` runs as a hook in every night session. It blocks:

- history rewrites, force pushes, merges, branch, tag and ref deletes, `git reset --hard`, `git clean -f`, forced worktree removal, pruning of unreachable objects, and discarding the whole working tree (`git checkout .`, `git restore .`);
- changes to remotes (also as `git config` of a remote's `url` or `pushurl` or of `url.<base>.insteadOf`, and a push to a URL instead of a remote's name), to global git config and to git settings that run a command, and a git command started with another home folder;
- publishing: `npm publish`, `gh release`, GitHub API writes and store uploads;
- deletes and moves outside the repository and temp folders, recursive or not, with the target read from the folder the command stands in (`cd elsewhere && rm -rf x` is refused);
- file writes (Write, Edit) outside the repository and temp folders, and writes to the skill itself, Claude settings, your global `CLAUDE.md`, the project's `.claude/night-shift.json`, the rule files, `~/.claude/night-shift/`, `.git`, and the runner's own files in the state folder (`night-settings.json`, `run.json`, `launch.cmd`, `fable.json`, the caps' count `limits.json`, the waiter's `wait.json`, your `STOP-REQUEST`, the logs); the same files are protected from a shell redirect and from the common commands that write a file in place (`sed -i`, `tee`, `cp`, `Set-Content` and the like);
- registry writes, system-level commands, and killing `node`, `claude`, the editor or the shell;
- MCP tools, unless the project lists their server (`mcp` above);
- anything your project's `deny` rules match, in a command or in the path of a file write.

A blocked action becomes an item under "Waits for you" in the night report.

Paths are compared the way Windows resolves them (`..`, a trailing dot or space, a `\\?\` prefix, UNC); a path with a stream name or an 8.3 short name is refused outright. The guard also reads the command a wrapper runs (`bash -c`, `powershell -c`, `eval`, `xargs`, `find -exec`, `timeout`, `nice`, `su -c`), a shell fed by a pipe, a git alias, abbreviated options (`git push --dele`, `git reset --har`), the targets of a delete through globs and braces, the tests of a `find` that deletes, and the folder a PowerShell pipeline lists before it deletes (`Get-ChildItem … | Remove-Item`). A quoted flag (`git push "--force"`) or flags written together (`-uf`) are still read as flags. The runner writes the hook into `night-settings.json` again before every session, and registers it with `onFailure: "block"`, so a guard that crashes refuses the action; a CLI too old to know that option would let it through.

### What the guard does not stop

It reads the text of a command; it does not confine the process. These still pass, among others:

- a shell redirect, or a program that writes or deletes on its own (`echo x > C:\somewhere\file`, `node -e "fs.rmSync(...)"`, a build script);
- a script file the session writes and then runs: the guard reads commands, not the files they start;
- network calls such as `curl -X POST`;
- `git push` to a branch and `gh pr create`: sessions are meant to push their work.

So the rule from the top of this page stands: run it only on a repository you have committed and can restore, on a machine and with credentials you would hand to an unattended script.

## When a session fails

- **A usage limit** pauses the chain, and the session it cut off resumes in the same conversation once the limit resets. A reset more than `maxWaitHours` away, or after `--until`, ends the chain (`the usage limit resets …`) with `resume.json` (or the handover) kept for the next `start`. No session starts at or over 90 % of the five-hour window: one started there is cut off minutes in, and its subagents' caches are lost. The chain waits for that window's reset instead (`five-hour window at …` in `chain.log`, then the usage-limit wait), under the same two rules, and a resumed session waits the same way.
- **An API or network error** is retried: the same conversation goes on when the session had already worked, else its prompt runs again. The waits are 1, 2, 5, 10, 20 and then 30 minutes, and they do not count toward "two handovers fail in a row". After `maxWaitHours` of failures the chain ends (`session NN kept failing for N h (…)`).
- **A refused login** or a bad request ends the chain at once (`session NN cannot run: …`), since the next session would fail the same way.
- **A runner that crashes** ends the chain with `the runner crashed: …`.

## Telegram (optional)

The runner can send a short card to Telegram when each session ends, plus one line for limit waits and retries, and one for each question of an attended run (see "Use").

1. Create a bot with BotFather.
2. Save `{ "token": "<bot token>" }` to `~/.claude/night-shift/telegram.json`. This file stays outside the skill folder; never commit it.
3. Press Start in the bot's chat, then run `node ~/.claude/skills/night-shift/scripts/night-report.mjs telegram-setup`. It prints the chat it saved, by name; check that it is yours. Reports go only to that chat, and only that chat's commands are answered. If someone else has written to the bot as well, setup saves nothing and lists the chats: run it again with `--chat <id>`.

In the bot's chat, `/status` shows what is running and `/report` lists this run's jobs. `/stop` stops the chain after the session in progress, and `/stop now` at once (the session in progress is killed and its work stays uncommitted in the tree), as `stop` and `stop --now` do; the bot answers what it did, before the kill. It is always on, answers only your chat, and does not take a `/stop` sent more than a minute before the watcher started. With chains on several repositories watching one bot, a command reaches the chain whose watcher reads it first, and the answer names that project. `/inbox <text>` adds the text, after the time, to the run's `inbox.md`, which the next session reads first; in an attended run `/inbox A2: <answer>` answers question 2. It lets a phone steer a chain, so it is off until your global `config.json` holds `"telegramInbox": true`; it answers only your chat and, like `/stop`, does not take one sent more than a minute before the watcher started; a project's `.claude/night-shift.json` cannot turn it on, and the bot's menu lists it when it is on as the watcher starts. A language table may give the commands names in its language as well (see "Language").

## Tests

```bash
cd ~/.claude/skills/night-shift
node --test scripts/*.test.mjs
node scripts/guard.mjs --self-test
```

In a clone of this repository, `npm test` at its root runs both. The tests use a temporary home folder and launch nothing through Task Scheduler.

On GitHub, `.github/workflows/test.yml` runs both on every push and pull request. On Windows they must pass, on Node 22 and on the newest LTS. On macOS and Linux they run but may fail without failing the workflow: the runner, the watcher and their tests use Windows' own tools (Task Scheduler, PowerShell, `taskkill`) today, and those systems are untested on real machines.

## Versions

`night-chain.mjs --version` prints the version of a copy, and each run keeps the version that started it in its `run.json`. [CHANGELOG.md](CHANGELOG.md) says what each version brought.

## License

[MIT](LICENSE)
