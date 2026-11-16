# night-shift

A [Claude Code](https://claude.com/claude-code) skill that keeps work going for hours while you are away, such as overnight.

It runs a chain of fresh headless sessions (`claude -p`). Each session is like opening a fresh chat and pasting a continuation prompt. A session does one finished piece of an approved plan, commits it, adds its section to a night report and writes the prompt for the next session. The chain stops when a session writes `STOP`, when two handovers fail in a row, or when you stop it. When it hits a usage limit, it waits for the reset and resumes the same session.

## Read this first

- **Windows only.** The runner starts itself through Task Scheduler in a hidden console (`conhost --headless`) and uses PowerShell, so it keeps running after your editor closes.
- **Opinionated.** It was built for one person's workflow, and `SKILL.md` quotes that person's rules. Read it and change what doesn't fit you.
- **Partly in Turkish.** A night session's prompt must start with `Gece vardiyası (night-shift)`. The Telegram cards, the status lines and some rules are in Turkish.
- **It assumes a `~/.claude/CLAUDE.md` you will have to write yourself.** `SKILL.md` points to one section of it, "Models and effort", for the models and levels subagents run at. Write your own version or edit that line.
- **It runs unattended with no permission prompts.** Sessions run with `--permission-mode auto --permission-prompts none`, and `AskUserQuestion` and plan mode are turned off. `scripts/guard.mjs` is a hook that blocks dangerous commands (see below). It is a safety net, not a sandbox. Run it only on a repository you have committed and can restore.
- **It costs tokens.** By default every session runs Opus at `xhigh`, subagents run Sonnet at `medium` and Haiku at `high`, and the chain has no end time. Use `--max-sessions` or `--until` if you want a limit. A session whose prompt opens with `MODEL: fable` runs on Fable at `high`; `SKILL.md` allows that for one hard piece only. Fable has its own weekly allowance, so the runner grants it only while less than 60 % of that allowance is used, and to at most two sessions in a chain while the share is unknown. A piece it refuses, or one the allowance cuts off, runs on Opus at `max`.

## Requirements

- Windows 10 or 11
- Node.js (tested on 22)
- The Claude Code CLI, installed globally with npm or with the native installer (`~/.local/bin/claude.exe`). The runner looks only in those places, not on `PATH`; for any other location, set `NIGHT_SHIFT_CLAUDE` to the path of `claude.exe`.
- git; the target repository must have no uncommitted changes before a start

## Install

Copy the `night-shift` folder to `~/.claude/skills/night-shift/`. `SKILL.md` refers to its scripts by that path.

```bash
git clone https://github.com/<you>/<this-repo>.git
cp -r <this-repo>/night-shift ~/.claude/skills/night-shift
```

## Use

In a Claude Code chat, ask for a night shift ("run a night shift on the plan in docs/plan.md until it is done"). The skill's `references/interactive.md` tells Claude how to write the first prompt, start the chain and report back when it ends.

You can also drive the runner yourself:

```bash
node ~/.claude/skills/night-shift/scripts/night-chain.mjs start  --repo <dir> --prompt-file <file>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs status --repo <dir>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs wait   --repo <dir>
node ~/.claude/skills/night-shift/scripts/night-chain.mjs stop   --repo <dir> [--now]
node ~/.claude/skills/night-shift/scripts/night-chain.mjs reload --repo <dir>
```

`start` also takes `--until HH:MM`, `--max-sessions <n>`, `--model <m>`, `--effort <level>`, `--fable-ceiling <share>`, `--fable-sessions <n>`, `--max-wait-hours <h>` (the longest wait for a usage limit or an outage, default 6), `--state <dir>` (continue in an earlier run's folder) and `--window` (a visible console; closing it stops the chain). `start` without a prompt goes on from a session a limit or an error cut off, kept in `<state>/resume.json`.

While a chain runs, write new work or changed rules into `<state>/inbox.md`. The next session reads that file first.

### Per-project settings

Put a `.claude/night-shift.json` in the target repository. Every key is optional, and a key the runner does not know is an error: `start` refuses to run and names it (a key that starts with `_` or `$` is a comment). The guard reads the same file and refuses MCP tools while it is invalid.

```json
{
  "stateDir": "C:/temp/my-app-night-{date}",
  "report": "docs/NIGHT_RUNS.md",
  "lessons": "docs/agents/NOTES.md",
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

- `stateDir`: the folder for the chain's log, prompts and inbox. The default is `<temp>/night-shift-<repo>-{date}`, inside your own profile. A folder under `C:/temp` is shorter to type, but on a PC with other accounts those users can write there too, and the next session reads `inbox.md` and `next-prompt.md` from this folder as instructions. On a shared PC keep the default.
- `report`: the night report. The default is `NIGHT_RUNS.md`.
- `lessons`: the notes file where sessions keep lessons that outlast one session.
- `model`, `effort`: what a session runs on when its prompt names neither.
- `fableCeiling`, `fableSessions`: the share of Fable's weekly allowance above which a `MODEL: fable` prompt runs on Opus at `max` instead, and how many Fable sessions a chain may run while that share is unknown.
- `maxWaitHours`: the longest the chain waits for a usage limit to reset or for an outage to pass (see "When a session fails"). The default is 6.
- `mcp`: `"none"` (the default), `"inherit"` or a list of server names. A night run loads no MCP server and the guard refuses every `mcp__` tool, unless the project lists the server (`"mcp": ["my-server"]`) or sets `"inherit"`.
- `deny`: your own guard rules. `pattern` is a regular expression and `flags` defaults to `i`.

## The guard

`scripts/guard.mjs` runs as a hook in every night session. It blocks:

- history rewrites, force pushes, merges, branch and ref deletes, `git reset --hard`, `git clean -f`, and discarding the whole working tree (`git checkout .`, `git restore .`);
- changes to remotes and to global git config;
- publishing: `npm publish`, `gh release`, GitHub API writes and store uploads;
- deletes outside the repository and temp folders, recursive or not, with the target read from the folder the command stands in (`cd elsewhere && rm -rf x` is refused);
- file writes (Write, Edit) outside the repository and temp folders, and writes to the skill itself, Claude settings, your global `CLAUDE.md`, the project's `.claude/night-shift.json`, `.git`, and the runner's own files in the state folder (`night-settings.json`, `run.json`, `launch.cmd`, the logs);
- registry writes, system-level commands, and killing `node`, `claude`, the editor or the shell;
- MCP tools, unless the project lists their server (`mcp` above);
- anything your project's `deny` rules match.

A blocked action becomes an item under "Waits for you" in the night report.

Paths are compared the way Windows resolves them (`..`, a trailing dot or space, a `\\?\` prefix, UNC); a path with a stream name or an 8.3 short name is refused outright. The guard also reads the command a wrapper runs (`bash -c`, `powershell -c`, `eval`, `xargs`, `find -exec`, `timeout`, `nice`), a shell fed by a pipe, a git alias, abbreviated options (`git push --dele`, `git reset --har`) and the targets of a delete through globs and braces. A quoted flag (`git push "--force"`) or flags written together (`-uf`) are still read as flags. The runner writes the hook into `night-settings.json` again before every session, and registers it with `onFailure: "block"`, so a guard that crashes refuses the action; a CLI too old to know that option would let it through.

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

In the bot's chat, `/durum` shows what is running and `/rapor` lists this run's jobs.

## Tests

```bash
cd ~/.claude/skills/night-shift
node --test scripts/*.test.mjs
```

The tests use a temporary home folder and launch nothing through Task Scheduler.

## License

[MIT](LICENSE)
