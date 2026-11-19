# Security

## What the guard is, and is not

`night-shift/scripts/guard.mjs` is a hook that runs in every unattended session. It reads the text of each Bash or PowerShell command and the path of each file write, and refuses the mechanical cases of what no one may approve at night: history rewrites, publishing, deletes and writes outside the repository and temp folders, changes to the skill, Claude settings and the runner's own files, and MCP tools the project has not listed.

It is a safety net, not a sandbox. It does not confine a process: a program the session starts can do what the program does, and a script file the session writes and then runs is not read. Run a chain only on a repository you have committed and can restore, on a machine and with credentials you would hand to an unattended script.

## Rule files

A project's `.claude/night-shift-rules.md` is trusted like its `CLAUDE.md`, and `start` names the rule files in force. A night session cannot write the rule files, the config files or anything under `~/.claude/night-shift/`. In a chain on its own worktree (`start --worktree`), the guard reads the project's `.claude/night-shift.json` in the main tree, not the worktree's copy, and protects the main tree's config file, rule file and `.git` as it protects the worktree's. `worktreeCopy` copies only paths inside the repository that git ignores and that are no link and lie under none, leaving out any link inside a copied folder, from the main tree into the worktree when `start` makes it, never back.

## Language tables

A language table (`~/.claude/night-shift/lang/<code>.mjs`, see the README's "Language") is a JavaScript module that the runner and the watcher import and run with your rights, as Claude Code runs a hook, so install only a table you wrote or have read; a night session cannot write it.

## Reporting a bypass

If you find a command or a path the guard should have refused and did not, report it privately: open a private security advisory on this repository (the Security tab, "Report a vulnerability"). Please do not open a public issue for it. Include the command or path, the guard's answer, and what it should have been.

## Telegram token and webhook URL

The optional Telegram report keeps its bot token in `~/.claude/night-shift/telegram.json`, outside the skill folder. The runner reads it only to call Telegram and does not write it to `chain.log`, `watch.log` or a card. The file must never be committed.

An optional webhook keeps its URL in `~/.claude/night-shift/webhook.json`. The URL is a secret too: anyone who knows an ntfy topic can read it, and a Slack or Discord webhook URL lets anyone post to its channel. The watcher reads it only to post the cards and does not write it to `watch.log` or a card; an error that names it has it replaced by `<webhook>`, and an answer is logged by its status alone; `doctor` shows only its kind and host. The guard refuses a night session's write or delete of either file. The file must never be committed.
