# Contributing

This skill runs unattended on other people's machines, for hours, with no one to ask. So the bar is trust first: a change that widens what a night session may do needs a reason and a test, and a change that makes the skill safer or plainer is welcome.

## Running the tests

From the repository's root:

```bash
npm test
```

It runs the suite (`node --test "scripts/*.test.mjs"` in `night-shift/`, a few minutes) and then the guard's self-test (`node scripts/guard.mjs --self-test`). It installs nothing: there are no dependencies. The tests start a stand-in for the `claude` CLI, never the real one, so they cost no tokens and send nothing anywhere; they make their folders under the system's temp folder.

Both must pass on Windows before a change is merged. CI runs them on every push and pull request (`.github/workflows/test.yml`): Windows is the gate; macOS and Linux run too but may fail, since the runner still uses Windows' own tools there.

## Rules for a change

- **No dependencies.** Node's built-ins only: no packages, no build step, no `node_modules`. The skill is one folder to copy. The oldest Node it runs on is `NODE_FLOOR` in `night-shift/scripts/version.mjs`.
- **English and LF.** Every tracked file is in English: the runner's other languages are tables users keep outside the repository. Lines end in LF (`.gitattributes`); if your editor wrote CRLF, `git add --renormalize .` fixes the index.
- **The guard is not loosened without a test.** A pull request that lets through something `night-shift/scripts/guard.mjs` refuses today needs a test that shows the case and why it is safe (in `guard.test.mjs`, or a case in the guard's self-test), and the reason in its description. Apart from the `mcp` list, which lets through the tools of the servers it names, no flag, config key or rule file may loosen the guard. Making it refuse more is welcome, with a test too.
- **A failing test first.** A fix comes with a test that fails without it.
- **Text follows code.** A change to what a command does updates its `--help` and `README.md`, and the skill's own texts (`night-shift/SKILL.md`, `night-shift/references/`) where they say it, in the same pull request. `SKILL.md` is read by every session of every chain: a test pins its size, so new guidance goes into a file under `references/` that only the sessions that need it read.
- **No private data.** Tests and fixtures use made-up names and ids (`demo-app`, `00000000-0000-4000-8000-000000000001`), never a real user's name, path, session id or token.
- **The version.** `night-shift/scripts/version.mjs` holds it; `package.json`, `.claude-plugin/plugin.json` and `CHANGELOG.md` name it too, and a test checks that they agree. Add what your change brings under the changelog's unreleased part.

## Reporting a bug

Open an issue with the bug report form: it asks for `night-chain.mjs --version` and `doctor`'s output, which answer most first questions. A security problem goes by [SECURITY.md](SECURITY.md) instead, not a public issue.
