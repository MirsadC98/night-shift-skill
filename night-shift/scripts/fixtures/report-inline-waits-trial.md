# Night report

## 2026-11-10 · run 1 · session 01 (19:02–19:13) · T1 slugify, T2 wordCount, npm question

**Done**
- T1 slugify (`1b92fd9`): `src/slugify.mjs` and its test; accented letter mapping, NFC, locale-free lower case. Task review clean.
- T2 wordCount (`017bec9`): `src/wordcount.mjs` and its test; split on `\s`, a part with a letter or a digit counts. Task review clean.
- Question answered (`031f946`): npm's code has no helper that makes slugs or counts words; `unique-slug` only makes an 8-character hash. Details in `docs/plan.md` "Answers".
- Records (`031f946`): `docs/log.md` opened, the plan's Status table updated, the place the SDD scripts write to added to `docs/agents/GOTCHAS.md`. `node --test`: 14/14.

Decisions: `docs/plan.md`, "Decisions (night shift, 2026-11-10, session 01)".

**Waits for you**
- New: License choice (MIT or Apache-2.0). Sessions do not choose, they do not write `LICENSE`. Code range to read `d617701..031f946` (the commit after this one only adds this report). Detail: `docs/plan.md`, "Waiting for the user".

**Remaining:** 1 sessions

## 2026-11-10 · run 1 · session 02 (19:13–19:29) · Closure

**Done**
- Closure review (Opus, full range `d617701..017bec9`): Critical 0, Important 1, Minor 3. The 5 small findings deferred from the task reviews were sorted out. The main session re-ran every claim against the source, and all were right.
- Important: slugify turns accented letters into `-` (`"Hôtel"` → `"h-tel"`, `"crème"` → `"cr-me"`, `"côté"` → `"c-t"`). Session 01's "only the letters in the plan" decision was lifted. The fix (convert to NFD and drop the combining marks) and three coverage tests will be done in night session 03, because the fix wave is a separate piece from the closure.
- `node --test`: 14/14.
- Records (`ae30b26`): the closure review line was added to `docs/log.md`. The plan's Status table became "review done, fix wave waiting". The plan's "Waiting for the user" and "Decisions (session 02)" sections were written. A "Rulings" lesson was added to `docs/agents/GOTCHAS.md`.

Decisions: `docs/plan.md`, "Decisions (night shift, 2026-11-10, session 02)". The `Ruling:` lines are in the SDD ledger (`C:\temp\demo-app-audit2-20261110\trial\scratch\sdd\progress.md`, "Closure").

**Waits for you**
- New: should slugify turn accented letters into ASCII (`"Hôtel"` → `"hotel"`, `"Café"` → `"cafe"`), or make them `-` as the plan's rule has it (`"h-tel"`)? Choice: converting to ASCII, being built in session 03. If you choose otherwise, the fix commit is reverted. Detail: `docs/plan.md:45`.
- Still waiting (session 01): License choice (MIT or Apache-2.0). Sessions do not choose, they do not write `LICENSE`. Code range to read `d617701..ae30b26` (was d617701..031f946: session 02's commits). Detail: `docs/plan.md:44`.

**Remaining:** 1 sessions
