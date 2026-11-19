// The report and the cards read from a state folder built by hand: no runner, no CLI. node --test scripts/night-report.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildReport, sessionMessage, chainMessage, questionLines } from "./night-report.mjs";
import { reportSection } from "./telegram-cards.mjs";
import { loadLang } from "./lang/index.mjs";
// A CLAUDE_CONFIG_DIR of the user's own would move every file these tests read or write (claudeHome in config.mjs).
delete process.env.CLAUDE_CONFIG_DIR;

const FIXTURE = new URL("./fixtures/session-guard-text-2026-11-19.jsonl", import.meta.url);
const line = (j) => JSON.stringify(j);
const SID = "00000000-0000-4000-8000-000000000012";
const success = (modelUsage, total) => line({ type: "result", subtype: "success", is_error: false, num_turns: 3, session_id: SID, total_cost_usd: total, modelUsage });
const used = (inputTokens, outputTokens, costUSD) => ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD });

// A finished one-job run: chain.log, run.json (English, so the user's own config is not read), the job's
// stream, and a night report in the repository when `report` is given.
function finished(stream, { report = null, start = "2026-11-19 03:27:12", end = "2026-11-19 04:10:00", runStart = start } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "night-report-test-"));
  const state = path.join(base, "state"), repo = path.join(base, "repo");
  fs.mkdirSync(state);
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(state, "run.json"), line({ repo, report: "NIGHT_RUNS.md", lang: "en", mode: "opus", startedAt: runStart }));
  fs.writeFileSync(path.join(state, "chain.log"), [`[${start}] chain starts`, `[${start}] session 01 starts: the piece`, `[${end}] session 01 ends: ok`, `[${end}] chain ends: STOP: done`, ""].join("\n"));
  fs.writeFileSync(path.join(state, "session-01.jsonl"), [line({ type: "system", subtype: "init", session_id: SID }), ...stream, ""].join("\n"));
  fs.writeFileSync(path.join(state, "next-prompt.md"), "STOP: done");
  if (report != null) fs.writeFileSync(path.join(repo, "NIGHT_RUNS.md"), report);
  return state;
}

const guardText = fs.readFileSync(FIXTURE, "utf8").trim().split("\n");
// A failed command whose output shows the guard's source: an error, but not the hook's.
const failedRead = [
  line({ type: "assistant", message: { id: "msg_fixture_x", model: "claude-opus-5-5", role: "assistant", content: [{ type: "tool_use", id: "toolu_fixture_x", name: "Bash", input: { command: "grep -n 'night-shift guard:' guard.mjs; false" } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fixture_x", is_error: true, content: "Exit code 1\n2:// night-shift guard: a PreToolUse hook for unattended runs. It denies the\n1417:      permissionDecisionReason: `night-shift guard: ${reason}. Do not work around it; note it for the morning and take other work.`," }] } }),
];

test("a guard denial is counted only when the hook refused a call, and its reason is one short line", () => {
  // Sessions 01, 02 and 08 of the chain that found it: the guard's source read and grepped, the hook run by hand
  // (its JSON printed), and two real refusals, one of them with a reason that ran over many lines.
  const state = finished([...guardText, ...failedRead, success({ "claude-opus-5-5": used(10, 7, 1.2) }, 1.2)]);
  const plain = buildReport(state, { focus: "all", pid: 0 }).plain;
  const refused = plain.split("\n").filter((l) => /guard refused/.test(l));
  assert.equal(refused.length, 1, plain);
  assert.match(refused[0], /^⚠️ #01 guard refused 2 times: a command named by a variable cannot be read; refusing a path with an NTFS stream name \( import\('\.\/guard\.mjs'\)/);
  assert.ok(refused[0].length < 400, refused[0]);
  assert.doesNotMatch(plain, /\$\{reason\}|PreToolUse hook for unattended runs|hookSpecificOutput/);
  const card = sessionMessage(state, "01", 0).text;
  assert.match(card, /guard refused 2 times: a command named by a variable cannot be read/);
  assert.doesNotMatch(card, /\$\{reason\}|hookSpecificOutput/);
  // one line of at most 160 characters, the cut marked
  const long = buildReport(finished([guardText.at(-2), guardText.at(-1).replace("NTFS stream name (", "NTFS stream name (" + "x".repeat(300))]), { focus: "all", pid: 0 }).plain;
  const reason = /guard refused 1 time: (.*)$/m.exec(long)?.[1] ?? "";
  assert.ok(reason.length <= 160 && reason.endsWith("…"), reason);
});

// T9: a session's start is the context its first main-thread call read: the header, the prompt and the tools, before any work.
const call = (model, usage, extra = {}) => line({ type: "assistant", ...extra, message: { model, role: "assistant", content: [], usage: { output_tokens: 1, ...usage } } });
test("each job's Tokens part shows its start, the first main-thread call's context, and the night total the mean", () => {
  const first = { input_tokens: 3, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 13_000 };
  const state = finished([
    call("<synthetic>", { input_tokens: 0 }),
    call("claude-sonnet-5-5", { input_tokens: 90_000 }, { parent_tool_use_id: "toolu_fixture_a" }),
    call("claude-haiku-4-5", { input_tokens: 70_000 }, { isSidechain: true }),
    call("claude-opus-5-5", first),
    call("claude-opus-5-5", { input_tokens: 1, cache_read_input_tokens: 80_000 }),
    success({ "claude-opus-5-5": used(10, 7, 1.2) }, 1.2),
  ]);
  const plain = buildReport(state, { focus: "all", pid: 0 }).plain;
  assert.match(plain, /^other: start 33k · compactions 0 · /m);
  assert.match(plain, /^mean start 33k over 1 job$/m);
  // A second job: the mean is over the jobs that made a call; one without a call shows no start.
  fs.appendFileSync(path.join(state, "chain.log"), ["[2026-11-19 04:20:00] session 02 starts: two", "[2026-11-19 04:30:00] session 02 ends: ok",
    "[2026-11-19 04:31:00] session 03 starts: three", "[2026-11-19 04:32:00] session 03 ends: ok", ""].join("\n"));
  fs.writeFileSync(path.join(state, "session-02.jsonl"), [call("claude-opus-5-5", { input_tokens: 1, cache_read_input_tokens: 40_998 }), success({}, 0.5), ""].join("\n"));
  fs.writeFileSync(path.join(state, "session-03.jsonl"), [success({}, 0), ""].join("\n"));
  const two = buildReport(state, { focus: "all", pid: 0 }).plain;
  assert.match(two, /^other: start 41k · /m);
  assert.match(two, /^mean start 37k over 2 jobs$/m);
  assert.equal((two.match(/^other: start /gm) || []).length, 2, "job 03 made no call");
});

test("a session that only reads or greps the guard's source shows no denial", () => {
  const readOnly = guardText.filter((l) => !/hook error: night-shift guard/.test(l));
  const state = finished([...readOnly, ...failedRead, success({ "claude-opus-5-5": used(10, 7, 1.2) }, 1.2)]);
  assert.doesNotMatch(buildReport(state, { focus: "all", pid: 0 }).plain, /guard refused/);
  assert.doesNotMatch(sessionMessage(state, "01", 0).text, /guard refused/);
});

test("a model with dollars in the totals but no rows in the transcripts keeps its dollars", () => {
  // The stream holds Opus's calls only; the totals also bill Haiku (calls no transcript records).
  const opusCall = line({ type: "assistant", message: { id: "msg_a", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 7 } } });
  const state = finished([opusCall, success({ "claude-opus-5-5": used(10, 7, 1.2), "claude-haiku-5-5": used(3000, 200, 0.3) }, 1.5)]);
  const plain = buildReport(state, { focus: "all", pid: 0 }).plain;
  assert.match(plain, /main haiku 5\.5\s+—\s+\$0\.30\n\s+in 3k read 0 write 0 out 200/);
  assert.match(plain, /main opus 5\.5\s+1 call\s+\$1\.20/);
  // the night total is the sessions' own total
  assert.match(plain.split("Night total")[1] ?? "", /total \$1\.50/);
});

// U16: the transcripts sit in the Claude folder the run used; start keeps it in run.json when CLAUDE_CONFIG_DIR is set.
test("the main rows come from the transcript in run.json's Claude folder, read from a shell without the variable", () => {
  const call = (id) => line({ type: "assistant", message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 7 } } });
  const state = finished([call("msg_a"), success({ "claude-opus-5-5": used(20, 14, 1) }, 1)]);
  assert.match(buildReport(state, { focus: "all", pid: 0 }).plain, /main opus 5\.5\s+1 call\s/, "the stream, with no transcript found");
  const cfg = path.join(path.dirname(state), "claude-config");
  fs.mkdirSync(path.join(cfg, "projects", "demo-app"), { recursive: true });
  fs.writeFileSync(path.join(cfg, "projects", "demo-app", `${SID}.jsonl`), [call("msg_a"), call("msg_b"), ""].join("\n"));
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), line({ ...run, claudeConfigDir: cfg }));
  assert.match(buildReport(state, { focus: "all", pid: 0 }).plain, /main opus 5\.5\s+2 calls\s/);
});

test("two keys of one model in the totals (the plain id and its [1m] form) add up, on a row of its own too", () => {
  const opusCall = line({ type: "assistant", message: { id: "msg_a", model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 7 } } });
  const usage = { "claude-opus-5-5": used(10, 7, 1), "claude-opus-5-5[1m]": used(0, 0, 0.5), "claude-haiku-5-5": used(3000, 200, 0.3), "claude-haiku-5-5[1m]": used(1000, 100, 0.2) };
  const plain = buildReport(finished([opusCall, success(usage, 2)]), { focus: "all", pid: 0 }).plain;
  assert.match(plain, /main opus 5\.5\s+1 call\s+\$1\.50/);
  assert.equal(plain.split("Night total")[0].match(/main haiku 5\.5/g)?.length, 1, plain);
  assert.match(plain, /main haiku 5\.5\s+—\s+\$0\.50\n\s+in 4k read 0 write 0 out 300/);
  assert.match(plain.split("Night total")[1] ?? "", /total \$2\.00/);
});

// Session 32's final review: one model's two keys (its "[1m]" form for the main thread, the plain id for the subagents)
// are added up before the output the rows missed is counted, so the subagents' missing output is not lost.
test("a model with two keys gives its subagents the output their transcripts missed, counted against both keys", () => {
  const msg = (id, out) => line({ type: "assistant", message: { id, model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: out } } });
  const state = finished([msg("msg_a", 1000), success({ "claude-opus-5-5[1m]": used(10, 1000, 1), "claude-opus-5-5": used(10, 3000, 1) }, 2)]);
  const cfg = path.join(path.dirname(state), "claude-config"), base = path.join(cfg, "projects", "demo-app", SID);
  fs.mkdirSync(path.join(base, "subagents"), { recursive: true });
  fs.writeFileSync(`${base}.jsonl`, [msg("msg_a", 1000), ""].join("\n"));
  fs.writeFileSync(path.join(base, "subagents", "agent-a.jsonl"), [msg("msg_b", 1000), ""].join("\n"));
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), line({ ...run, claudeConfigDir: cfg }));
  const plain = buildReport(state, { focus: "all", pid: 0 }).plain;
  assert.match(plain, /main opus 5\.5\s+1 call\s+\$0\.50\n\s+in 10 read 0 write 0 out 1k/, plain);
  assert.match(plain, /sub opus 5\.5\s+1 agent\s+\$1\.50\n\s+in 10 read 0 write 0 out 3k/, plain);
  assert.match(plain.split("Night total")[1] ?? "", /total \$2\.00/);
});

// U20: a time the user reads comes from the language table's clock; a section is still found by its heading's HH:MM.
test("the report's clock times are the language table's, and a section is still found by its heading's HH:MM", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "night-report-clock-"));
  fs.mkdirSync(path.join(home, ".claude", "night-shift", "lang"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "night-shift", "lang", "zc.mjs"),
    "export default { name: 'Zc', clock: (d) => `${d.getHours() % 12 || 12}.${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}` };\n");
  assert.equal((await loadLang("zc", home)).error, undefined);
  const state = finished([success({ "claude-opus-5-5": used(10, 7, 1.2) }, 1.2)],
    { report: "## 2026-11-19 · run 1 · session 01 (03:27–04:10) · the clock piece\n\n**Waits for you**\n- New: none.\n\n**Remaining:** 0 sessions\n" });
  const run = JSON.parse(fs.readFileSync(path.join(state, "run.json"), "utf8"));
  fs.writeFileSync(path.join(state, "run.json"), line({ ...run, lang: "zc" }));
  fs.appendFileSync(path.join(state, "chain.log"), "[2026-11-19 03:40:00] usage limit: waiting until 2026-11-19 15:05:12\n");
  const plain = buildReport(state, { focus: "all", pid: 0 }).plain;
  assert.match(plain, /3\.27am–4\.10am/);
  assert.match(plain, /the clock piece/);
  assert.match(plain, /⏳ 3\.40am usage limit reached, waited until 3\.05pm/);
});

// A report with session nn of two runs: last night's at the same clock time, and tonight's when given.
const twoNights = (tonight, nn = "07") => [
  "# Night runs", "",
  `## 2026-11-18 · run 1 · session ${nn} (19:24–20:00) · last night's piece`, "", "**Waits for you**", "- New: the old question. Detail: `a.md:1`.", "", "**Remaining:** 3 sessions", "",
  ...(tonight ? [`## 2026-11-19 · run 2 · session ${nn} (19:25–20:10) · tonight's piece`, "", "**Waits for you**", "- New: none.", "", "**Remaining:** 1 sessions", ""] : []),
].join("\n");
const sevens = (tonight) => twoNights(tonight);

test("a report section is found by its date and start time, not by the time alone", () => {
  assert.equal(reportSection(sevens(false), "07", "19:24", "2026-11-19"), null);
  assert.equal(reportSection(sevens(true), "07", "19:24", "2026-11-19").title, "tonight's piece");
  assert.equal(reportSection(sevens(true), "07", "19:24", "2026-11-18").title, "last night's piece");
  // Without a date (an older caller) the time decides, as before.
  assert.equal(reportSection(sevens(false), "07", "19:24").title, "last night's piece");
  // Near midnight: a heading that names the day the session ended, or a start a few minutes the other side.
  const late = "## 2026-11-19 · run 1 · session 03 (23:55–00:40) · late piece\n\n**Remaining:** 2 sessions\n";
  assert.equal(reportSection(late, "03", "23:55", "2026-11-18").title, "late piece");
  const early = "## 2026-11-18 · run 1 · session 04 (23:58–00:40) · early piece\n\n**Remaining:** 2 sessions\n";
  assert.equal(reportSection(early, "04", "00:03", "2026-11-19").title, "early piece");
  assert.equal(reportSection(early, "04", "00:03", "2026-11-20"), null);
  // The day after only for a heading whose span crosses midnight or names no end (session 32's final review): the next
  // night's session of the same number and start time is another job, and an older job without a section gets none.
  const nextNight = "## 2026-11-19 · run 2 · session 07 (22:00–23:10) · tonight's piece\n\n**Remaining:** 1 sessions\n";
  assert.equal(reportSection(nextNight, "07", "22:00", "2026-11-18"), null);
  assert.equal(reportSection(nextNight, "07", "22:00", "2026-11-19").title, "tonight's piece");
  assert.equal(reportSection("## 2026-11-19 · run 1 · session 03 (23:55-00:30) · hyphen piece\n", "03", "23:55", "2026-11-18").title, "hyphen piece");
  assert.equal(reportSection("## 2026-11-19 · run 1 · session 03 (23:55) · open piece\n", "03", "23:55", "2026-11-18").title, "open piece");
  // A heading with no date is read by its time.
  assert.equal(reportSection("## run 1 · session 05 (10:00–11:00) · undated\n", "05", "10:05", "2026-11-19").title, "undated");
});

test("a session card does not show last night's section of the same number when tonight's is missing", () => {
  const job = [success({ "claude-opus-5-5": used(10, 7, 1.2) }, 1.2)], at = { start: "2026-11-19 19:24:30", end: "2026-11-19 20:05:00" };
  assert.doesNotMatch(sessionMessage(finished(job, { report: twoNights(false, "01"), ...at }), "01", 0).text, /last night's piece|the old question/);
  assert.match(sessionMessage(finished(job, { report: twoNights(true, "01"), ...at }), "01", 0).text, /tonight's piece/);
});

test("a section the cards cannot read says so: no section at all, or one without its fixed words", () => {
  const job = [success({ "claude-opus-5-5": used(10, 7, 1.2) }, 1.2)];
  const head = "## 2026-11-19 · run 1 · session 01 (03:27–04:10) · the piece\n\n";
  const card = (report) => sessionMessage(finished(job, { report }), "01", 0).text;
  const plain = (report) => buildReport(finished(job, { report }), { focus: "all", pid: 0 }).plain;
  // A translated heading: no section is found.
  assert.match(card("## 2026-11-19 · lauf 1 · sitzung 01 (03:27–04:10) · das Ziel\n"), /no night-report section names this job/);
  assert.match(plain("## 2026-11-19 · lauf 1 · sitzung 01 (03:27–04:10) · das Ziel\n"), /⚠️ #01 no night-report section names this job/);
  // Translated fixed words inside a found section.
  assert.match(card(`${head}**Wartet auf dich**\n- Neu: nichts.\n\n**Verbleibend:** 2\n`), /its night-report section lacks \*\*Waits for you\*\* and \*\*Remaining:\*\* &lt;n&gt;,/);
  assert.match(card(`${head}**Waits for you**\n- New: none.\n\n**Verbleibend:** 2\n`), /section lacks \*\*Remaining:\*\* &lt;n&gt;,/);
  // The word without a count: the count is what is missing.
  assert.match(plain(`${head}**Waits for you**\n- New: none.\n\n**Remaining:** none\n`), /⚠️ #01 its night-report section lacks \*\*Remaining:\*\* <n>,/);
  // A section with both says nothing; nor does a run without a report file (the repository may keep none).
  for (const c of [card(`${head}**Waits for you**\n- New: none.\n\n**Remaining:** 0 sessions\n`), card(null)]) assert.doesNotMatch(c, /night-report section/);
  assert.doesNotMatch(chainMessage(finished(job, { report: `${head}**Waits for you**\n- New: none.\n\n**Remaining:** 0 sessions\n` }), "STOP: done", 0).text, /night-report section/);
  // Not for a job that failed (its failure is the problem), nor for an earlier run's job in the same state folder.
  const failed = [line({ type: "result", subtype: "error_during_execution", is_error: true, session_id: SID, total_cost_usd: 1, modelUsage: {} })];
  const failedPlain = buildReport(finished(failed, { report: "# Night runs\n" }), { focus: "all", pid: 0 }).plain;
  assert.match(failedPlain, /#01 ended with an error/);
  assert.doesNotMatch(failedPlain, /night-report section/);
  assert.doesNotMatch(buildReport(finished(job, { report: "# Night runs\n", runStart: "2026-11-19 05:00:00" }), { focus: "all", pid: 0 }).plain, /night-report section/);
});

// F6 (session 20's closure): --help printed only the header's first lines, so the bot's commands never showed.
test("night-report.mjs --help prints the whole header comment: the bot's commands and the language note", () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./night-report.mjs", import.meta.url)), "--help"], { encoding: "utf8" });
  for (const w of ["/status", "/report", "/stop now", "/inbox <text>", "telegramInbox", "the run's language"]) assert.ok(r.stdout.includes(w), w);
  assert.doesNotMatch(r.stdout, /^import |^\/\//m, "the comment only, its slashes taken off");
});

// F7: Windows PowerShell 5's Set-Content -Encoding UTF8 starts the file with a BOM, which hid its first question.
test("questionLines reads a questions.md that starts with a BOM and has CRLF line ends", () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "night-questions-"));
  fs.writeFileSync(path.join(state, "questions.md"), "\uFEFFQ1 · Which name? · picked A · B changes the menu\r\nQ2 · Ship it? · picked yes · no keeps it local\r\nQ3 · half-written");
  assert.deepEqual(questionLines(state), ["Q1 · Which name? · picked A · B changes the menu", "Q2 · Ship it? · picked yes · no keeps it local"]);
});
