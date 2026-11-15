# night-shift

A [Claude Code](https://claude.com/claude-code) skill that keeps work going for hours while you are away, such as overnight.

It runs a chain of fresh headless sessions (`claude -p`). Each session is like typing `/clear` and pasting a continuation prompt. A session does one finished piece of an approved plan, commits it, adds its section to a night report and writes the prompt for the next session. The chain stops when a session writes `STOP`, when two handovers fail in a row, or when you stop it. When it hits a usage limit, it waits for the reset and resumes the same session.

## Read this first

- **Windows only.** The runner starts itself through Task Scheduler in a hidden console (`conhost --headless`) and uses PowerShell, so it keeps running after your editor closes.
- **Opinionated.** It was built for one person's workflow, and `SKILL.md` quotes that person's rules. Read it and change what doesn't fit you.
- **Partly in Turkish.** A night session's prompt must start with `Gece vardiyası (night-shift)`. The Telegram cards, the status lines and some rules are in Turkish.
- **It assumes a `~/.claude/CLAUDE.md` you will have to write yourself.** `SKILL.md` and `references/interactive.md` point to two sections of it: "Subagent models and efforts" and the `/clear` continuation-prompt rule. Write your own versions or edit those lines.
- **It runs unattended with no permission prompts.** Sessions run with `--permission-mode auto --permission-prompts none`, and `AskUserQuestion` and plan mode are turned off. `scripts/guard.mjs` is a hook that blocks dangerous commands (see below). It is a safety net, not a sandbox. Run it only on a repository you have committed and can restore.
- **It costs tokens.** By default every session runs Opus at `xhigh`, subagents run Sonnet at `medium` and Haiku at `high`, and the chain has no end time. Use `--max-sessions` or `--until` if you want a limit.

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

`start` also takes `--until HH:MM`, `--max-sessions <n>`, `--model <m>`, `--effort <level>`, `--state <dir>` (continue in an earlier run's folder) and `--window` (a visible console; closing it stops the chain).

While a chain runs, write new work or changed rules into `<state>/inbox.md`. The next session reads that file first.

### Per-project settings

Put a `.claude/night-shift.json` in the target repository. Every key is optional:

```json
{
  "stateDir": "C:/temp/my-app-night-{date}",
  "report": "docs/NIGHT_RUNS.md",
  "lessons": "docs/agents/NOTES.md",
  "model": "opus",
  "effort": "xhigh",
  "deny": [
    { "pattern": "\\bmy-app\\.exe\\b", "reason": "that is the app running on my desktop" }
  ]
}
```

- `stateDir`: the folder for the chain's log, prompts and inbox. The default is `<temp>/night-shift-<repo>-{date}`.
- `report`: the night report. The default is `NIGHT_RUNS.md`.
- `lessons`: the notes file where sessions keep lessons that outlast one session.
- `deny`: your own guard rules. `pattern` is a regular expression and `flags` defaults to `i`.

## The guard

`scripts/guard.mjs` runs as a hook in every night session. It blocks:

- history rewrites, force pushes, merges, branch deletes, `git reset --hard` and `git clean -f`;
- changes to remotes and to global git config;
- publishing: `npm publish`, `gh release`, GitHub API writes and store uploads;
- deletes outside the repository and temp folders;
- registry writes, system-level commands, and killing `node`, `claude`, the editor or the shell;
- anything your project's `deny` rules match.

A blocked action becomes an item under "Waits for you" in the night report.

## Telegram (optional)

The runner can send a short card to Telegram when each session ends, plus one line for limit waits and retries.

1. Create a bot with BotFather.
2. Save `{ "token": "<bot token>" }` to `~/.claude/night-shift/telegram.json`. This file stays outside the skill folder; never commit it.
3. Press Start in the bot's chat, then run `node ~/.claude/skills/night-shift/scripts/night-report.mjs telegram-setup`.

In the bot's chat, `/durum` shows what is running and `/rapor` lists this run's jobs.

## Tests

```bash
cd ~/.claude/skills/night-shift
node --test scripts/*.test.mjs
```

The tests use a temporary home folder and launch nothing through Task Scheduler.

## License

[MIT](LICENSE)
