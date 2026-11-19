// The skill's version: the one place that holds it. night-chain.mjs --version prints it, start writes it into
// run.json, and the repository's package.json and CHANGELOG.md name it too (skill-text.test.mjs checks they agree).
// A version with a pre-release part ("-dev") is the CHANGELOG's unreleased part; a release drops that part here and in
// package.json, and dates the CHANGELOG's heading.
export const VERSION = "0.3.0-dev";
// The oldest Node the skill runs on; package.json's engines names it too, and doctor checks it. node --test reads the
// quoted glob of npm test itself only from 21 on, and 22 is the oldest line still maintained.
export const NODE_FLOOR = 22;
