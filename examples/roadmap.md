# Roadmap: tags for the notes CLI

Approved: <your name>, <yyyy-mm-dd>

Goal: a note can carry tags, and `notes list --tag <tag>` shows only the notes that have it. Notes saved today stay readable by older versions.

## Checks before every commit

- `npm test`
- `npm run lint`

## Pieces

Each piece is one session's work.

1. **Round 1, tasks.** `notes tag add <id> <tag>` and `notes tag remove <id> <tag>`, the tags kept in the note's existing `meta` object, which older versions ignore. Done: both commands with tests (a missing note, a tag added twice, removing a tag the note lacks), the README's command list updated, one commit per command.
2. **Round 1, closure review.** One reviewer reads round 1's diff. A few small findings are fixed in the same session; more become a fix wave, which this session hands on as the next piece, before piece 3. Done: every finding fixed or handed on.
3. **Round 2, tasks.** `notes list --tag <tag>`, and `--tag` given twice for notes that have both. Done: tests for no match, one tag and two tags; the help text names the flag.
4. **Round 2, closure review.** As piece 2, for round 2.

## Out of scope

- Renaming or merging tags.
- Any change to the saved file's format version.
- A release, or a push to `main`.
