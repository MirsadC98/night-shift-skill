Plan the goal below into an approved roadmap, then hand its first piece to the next session.

## Rules
- This session is the chain's planning piece and only that: it writes the roadmap and changes no code. The work starts in the next session.
- The goal is the user's word, with the prompt's weight. It approves the work the goal needs and nothing beyond it: work the goal does not need is new work outside the roadmap (the "Roadmap" hard stop), named under Waits for you and not built. A hard stop the goal would need (a push, a release, a message to someone) goes under Waits for you, never into a piece.
- Where the goal leaves a choice open, decide it as `SKILL.md` says, from the user's recorded preferences first, and record it as `decision · why`.

## State
- No roadmap exists yet. The goal, in the user's words:

{{goal}}

## This piece
1. Read the repository and the user's recorded preferences: the CLAUDE.md files, memory, the project's plans, decisions and design docs, its notes file, and the rules in this header. A plan already in the repository that covers the goal is the roadmap's base, not something to write again.
2. Write the roadmap where the project keeps its plans (else `docs/plans/<yyyy-mm-dd>-<short-name>.md`), with the decisions file beside it. It opens with the goal word for word, then gives:
   - the pieces in order, each the size `SKILL.md`'s "One session, one piece" gives (a round of at most four tasks, its closure review, a fix wave, a package, a measurement), with what done looks like for each;
   - the checks each piece runs before its commit, by their commands;
   - what is out of scope.
3. Have one fresh reviewer subagent check the roadmap against the goal and the recorded preferences: does every piece serve the goal, is a piece the goal needs missing, is each piece one session's work. Fix what it finds.
4. Mark the roadmap `Approved: night delegate (night-shift, <date>)` and commit it (where the project's rules keep plans out of git, write it and leave it uncommitted).
5. End with `SKILL.md`'s three steps. The continuation prompt hands piece 1 to the next session, and `**Remaining:**` counts the roadmap's pieces. A goal the repository cannot serve, or one that needs only hard stops, ends the chain instead: `STOP: <reason>`, with what waits for the user.

Done: the roadmap approved and committed, its decisions recorded, this session's section in the night report, and a prompt for piece 1.

## Lessons for this piece
- Give each piece its own short heading in the roadmap, so a later session greps its piece instead of reading the whole file, and its prompt points there instead of copying it.
- A roadmap of one piece is fine: the chain ends after that piece.
