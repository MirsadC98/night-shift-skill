Tags for the notes CLI, round 1: `notes tag add` and `notes tag remove`

## Rules
- The roadmap is `docs/plans/tags.md`, approved. This session does its piece 1 and nothing else.
- Before every commit, `npm test` and `npm run lint` pass. One commit per task.
- Do not push: I push in the morning.

## State
- Branch `tags`, made from `main` at `<commit>`; the tree is clean.
- Notes are saved in `notes.json`. Each note has a `meta` object that older versions ignore.

## This piece
Round 1 of the roadmap: `notes tag add <id> <tag>` and `notes tag remove <id> <tag>`, the tags kept in `meta.tags`.
Done: both commands with tests (a missing note, a tag added twice, removing a tag the note lacks), the README's command list updated, two commits.

## Lessons for this piece
- None yet. Lessons that outlive a session go into `docs/agents/NOTES.md`.
