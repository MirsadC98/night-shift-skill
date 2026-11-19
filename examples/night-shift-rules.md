<!--
This project's rules for night-shift. Every night session on this repository gets the text of this file in its
header, where it wins over the skill's defaults and over your own rules file (~/.claude/night-shift/rules.md).
Text inside these comment marks reaches no session: write your rules below the closing mark, in any language.
The whole file, this comment included, is at most 8 KB. A rule cannot loosen the guard: what it refuses stays refused.

A rule can change:
- which decisions wait for you in the morning (the five tests in the skill's SKILL.md, "What reaches the user");
- how the work is split into pieces, and when a session asks for another model;
- the stops the guard does not enforce: your live desktop, physical tests, messages, work outside the roadmap.

For example:
- The app on my desktop is never started; tests run headless only.
- A change to the save file format waits for me.
-->
- Never start the app or open its window on my desktop; the tests run headless (`npm test`).
- A change to the format of saved notes waits for me: write it down under Waits for you, do not build it.
- A round of more than three tasks goes over two sessions (the skill splits one of more than four).
- Ask for another model only for a bug that already resisted a whole session.
- Commit subjects are one plain sentence in the imperative, at most 72 characters.
