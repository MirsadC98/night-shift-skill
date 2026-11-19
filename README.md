# night-shift

A [Claude Code](https://claude.com/claude-code) skill that keeps work going for hours while you are away, such as overnight.

It runs a chain of fresh headless sessions (`claude -p`). Each session is like opening a fresh chat and pasting a continuation prompt. A session does one finished piece of an approved plan, commits it, adds its section to a night report and writes the prompt for the next session. The chain stops when a session writes `STOP`, when two handovers fail in a row, or when you stop it. When it hits a usage limit, it waits for the reset and resumes the same session.

## Read this first

- **Windows only.** The runner starts itself through Task Scheduler in a hidden console (`conhost --headless`) and uses PowerShell, so it keeps running after your editor closes.
- **It runs unattended with no permission prompts.** Sessions run with `--permission-mode auto --permission-prompts none`, and `AskUserQuestion` and plan mode are turned off. `scripts/guard.mjs` is a hook that blocks dangerous commands (see below). It is a safety net, not a sandbox. Run it only on a repository you have committed and can restore.
- **It costs tokens.** By default (mode `opus`) every session runs Opus at `xhigh`, subagents run Sonnet at `medium` and Haiku at `high`, and the chain has no end time. Use `--max-sessions` or `--until` if you want a limit. A session whose prompt opens with `MODEL: fable` runs on Fable at `high`; `SKILL.md` allows that for one hard piece only. Fable has its own weekly allowance, so the runner grants it only while less than 60 % of that allowance is used, and to at most two sessions in a chain while the share is unknown. A piece it refuses, or one the allowance cuts off, runs on Opus at `max`. Mythos, which Anthropic opens only to organizations it has verified, is the same model as Fable under another name and draws on the same weekly allowance: everything this page says about Fable's allowance, its ceiling and its count holds for the two together, and `MODEL: mythos` works as `MODEL: fable` does. See "Modes" for the other modes.

## Requirements

- Windows 10 or 11
- Node.js (tested on 22)
- The Claude Code CLI, installed globally with npm or with the native installer (`~/.local/bin/claude.exe`). The runner looks only in those places, not on `PATH`; for any other location, set `NIGHT_SHIFT_CLAUDE` to the path of `claude.exe`.
- git; the target repository must have no uncommitted changes before a start

## Install

Copy the `night-shift` folder to `~/.claude/skills/night-shift/`. The guard protects the skill's files at that path from night sessions, so a copy anywhere else is not protected; the commands below use it too.

```bash
git clone https://github.com/<you>/<this-repo>.git
cp -r <this-repo>/night-shift ~/.claude/skills/night-shift
```

## Use

In a Claude Code chat, ask for a night shift ("run a night shift on the plan in docs/plan.md until it is done"). A night session's prompt opens with `Night shift (night-shift)`; that is how the skill knows it is inside one. The skill's `references/interactive.md` tells Claude how to write the first prompt, start the chain and report back when it ends.

You can also drive the runner yourself:

```bash
node ~/.claude/skills/night-shift/scripts/night-chain.mjs start  --repo <dir> --prompt-file <file>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs status --repo <dir>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs wait   --repo <dir>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs stop   --repo <dir> [--now]
node ~/.claude/skills/night-shift/scripts/night-chain.mjs reload --repo <dir>
```

`start` also takes `--until HH:MM`, `--max-sessions <n>`, `--model <m>`, `--effort <level>`, `--fable-ceiling <share>`, `--fable-sessions <n>`, `--mode opus|fable|mythos`, `--lang <code>`, `--max-wait-hours <h>` (the longest wait for a usage limit or an outage, default 6; a value that is not a positive number stops `start`), `--state <dir>` (continue in an earlier run's folder) and `--window` (a visible console; closing it stops the chain). `start` without a prompt goes on from a session a limit or an error cut off, kept in `<state>/resume.json`.

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
  "mcp": "none",
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
- `mcp`: `"none"` (the default), `"inherit"` or a list of server names. A night run loads no MCP server and the guard refuses every `mcp__` tool, unless the project lists the server (`"mcp": ["my-server"]`) or sets `"inherit"`.
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

Each file is at most 8 KB (UTF-8 bytes) and is read again at every session start, so an edit takes effect on the next session. `start` and `status` name the files in force. A file that grows too big or cannot be read mid-chain keeps its last text, and the log and Telegram say so; a file you empty or remove drops out. A project rule file is a file in the repository: commit it (or ignore it in git) before `start`, which refuses a working tree with uncommitted changes, an untracked file included (`--allow-dirty` exists).

| A rule can change | A rule cannot change |
|---|---|
| The five tests that decide which decisions wait for you (`night-shift/SKILL.md`, "What reaches the user") | What the guard refuses: merges, branch deletes, history rewrites, force pushes |
| How work is split into pieces | Deletes outside the repository and temp folders |
| The stops the guard does not enforce: live desktop, physical tests, messages, work outside the roadmap | Publishing |
| When a session asks for another model | Writes to the skill, Claude settings, the config files and the rule files |

### Language

`lang` (`--lang` on `start`) sets the language of what you read: the Telegram cards, the `/status` and `/report` answers, the `status` and `wait` output, dates and units. The skill ships English, `en`, the default. Any other language is a table you own: copy `night-shift/scripts/lang/en.mjs` to `~/.claude/night-shift/lang/<code>.mjs` (a lowercase code such as `de` or `pt-br`), translate its strings, and set `lang` to that code. Besides the strings, the table gives the language's English name (`name`; each session is told the language the night report is written in, and a table without one is named by its code), names for the two bot commands in that language (`cmdStatus`, `cmdReport`: up to 32 lowercase letters, digits or `_`, as Telegram takes them, else both read English; their menu texts, `cmdStatusDesc` and `cmdReportDesc`, take 1 to 256 characters, else that one reads English; `/status` and `/report` always answer) and the phrase that follows `docs: ` in a night-report commit (`reportCommit`; `night report` always counts). A key the table lacks reads English, so a table written for an older version keeps working after an update. `start` refuses a code whose table is missing or does not load, and names the file; a runner or watcher that cannot load it later reads English and says so once in its log. Earlier versions shipped a `tr` table in the skill folder; a config that names `tr` now needs that table in `~/.claude/night-shift/lang/tr.mjs` (it is in this repository's history: `git show 4a566e4:night-shift/scripts/lang/tr.mjs`). A language table is code that the runner and the watcher import and run, like a hook. Everything the model reads (prompts, headers, notes) stays English.

### Global settings

`~/.claude/night-shift/config.json` holds defaults for every project. It takes six keys: `mode`, `lang`, `effort`, `fableCeiling`, `fableSessions` and `maxWaitHours`. Any other key, bad JSON or a value of the wrong type stops `start` and names the file. A setting comes from the first of these that has it: the command-line flag, the project file `.claude/night-shift.json`, the global file, the default.

## The guard

`scripts/guard.mjs` runs as a hook in every night session. It blocks:

- history rewrites, force pushes, merges, branch, tag and ref deletes, `git reset --hard`, `git clean -f`, forced worktree removal, pruning of unreachable objects, and discarding the whole working tree (`git checkout .`, `git restore .`);
- changes to remotes (also as `git config` of a remote's `url` or `pushurl` or of `url.<base>.insteadOf`, and a push to a URL instead of a remote's name), to global git config and to git settings that run a command, and a git command started with another home folder;
- publishing: `npm publish`, `gh release`, GitHub API writes and store uploads;
- deletes and moves outside the repository and temp folders, recursive or not, with the target read from the folder the command stands in (`cd elsewhere && rm -rf x` is refused);
- file writes (Write, Edit) outside the repository and temp folders, and writes to the skill itself, Claude settings, your global `CLAUDE.md`, the project's `.claude/night-shift.json`, the rule files, `~/.claude/night-shift/`, `.git`, and the runner's own files in the state folder (`night-settings.json`, `run.json`, `launch.cmd`, the logs); the same files are protected from a shell redirect and from the common commands that write a file in place (`sed -i`, `tee`, `cp`, `Set-Content` and the like);
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

- **A usage limit** pauses the chain, and the session it cut off resumes in the same conversation once the limit resets. A reset more than `maxWaitHours` away, or after `--until`, ends the chain (`the usage limit resets …`) with `resume.json` (or the handover) kept for the next `start`.
- **An API or network error** is retried: the same conversation goes on when the session had already worked, else its prompt runs again. The waits are 1, 2, 5, 10, 20 and then 30 minutes, and they do not count toward "two handovers fail in a row". After `maxWaitHours` of failures the chain ends (`session NN kept failing for N h (…)`).
- **A refused login** or a bad request ends the chain at once (`session NN cannot run: …`), since the next session would fail the same way.
- **A runner that crashes** ends the chain with `the runner crashed: …`.

## Telegram (optional)

The runner can send a short card to Telegram when each session ends, plus one line for limit waits and retries.

1. Create a bot with BotFather.
2. Save `{ "token": "<bot token>" }` to `~/.claude/night-shift/telegram.json`. This file stays outside the skill folder; never commit it.
3. Press Start in the bot's chat, then run `node ~/.claude/skills/night-shift/scripts/night-report.mjs telegram-setup`. It prints the chat it saved, by name; check that it is yours. Reports go only to that chat, and only that chat's commands are answered. If someone else has written to the bot as well, setup saves nothing and lists the chats: run it again with `--chat <id>`.

In the bot's chat, `/status` shows what is running and `/report` lists this run's jobs. A language table may give the two commands names in its language as well (see "Language").

## Tests

```bash
cd ~/.claude/skills/night-shift
node --test scripts/*.test.mjs
```

The tests use a temporary home folder and launch nothing through Task Scheduler.

## License

[MIT](LICENSE)
