// node --test scripts/telegram-cards.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sessionCard, eventLine, chainCard, statusCard, reportSection, reportCard, splitHtml } from "./telegram-cards.mjs";

const done = {
  nn: "13", ok: true, took: "1 sa 21 dk", cost: "$19.24", five: "%56", seven: "%47",
  title: "R11 closure (Presets) — R11 done", next: "R12 plan (Settings)", problems: [],
  commits: ["5cf8e41 ui: R11 kapanışı — Presets"], rows: ["ana opus 5.5 · 221 çağrı · $15.11"], waits: [],
};

test("a finished job is a short card: title, one numbers line, what comes next", () => {
  const { text, silent } = sessionCard(done);
  const head = text.split("<blockquote")[0].trim().split("\n");
  assert.deepEqual(head, [
    "✅ <b>#13 · R11 closure (Presets) — R11 done</b>",
    "1 sa 21 dk · $19.24 · 5s %56 · 7g %47",
    "➡️ R12 plan (Settings)",
  ]);
  assert.equal(silent, false);
});

test("the card is short: no commit hashes and no token rows, only what waits in one collapsed quote", () => {
  const { text } = sessionCard(done);
  assert.doesNotMatch(text, /blockquote|Commit|Token|5cf8e41|çağrı/);
  const waiting = sessionCard({ ...done, waits: ["R65's physical acceptance"] }).text;
  assert.equal(waiting.match(/<blockquote expandable>/g).length, 1);
  assert.match(waiting, /<blockquote expandable><b>Seni bekleyen<\/b> · 1\n• R65's physical acceptance<\/blockquote>$/);
});

test("only this job's problems show, above the details", () => {
  const { text } = sessionCard({ ...done, ok: false, problems: ["guard 1 kez reddetti: git clean"] });
  assert.match(text, /^❌ <b>#13/);
  assert.match(text.split("<blockquote")[0], /⚠️ guard 1 kez reddetti: git clean/);
});

test("a job with no report section falls back to its commits, then to its number", () => {
  assert.match(sessionCard({ ...done, title: null }).text, /^✅ <b>#13 · ui: R11 kapanışı — Presets<\/b>/);
  assert.match(sessionCard({ ...done, title: null, commits: [] }).text, /^✅ <b>#13<\/b>/);
});

test("text from files is escaped", () => {
  const { text } = sessionCard({ ...done, title: "a <b> & c", commits: [] });
  assert.match(text, /#13 · a &lt;b&gt; &amp; c/);
});

test("a long card stays under Telegram's 4096 characters and closes its quote", () => {
  const waits = Array.from({ length: 400 }, (_, i) => `item ${i}: a long thing that waits for the user and keeps going on`);
  const { text } = sessionCard({ ...done, waits });
  assert.ok(text.length <= 4096, `${text.length}`);
  assert.match(text, /<\/blockquote>$/);
});

test("small events are one line; the ones that need nothing from the user are silent", () => {
  assert.deepEqual(eventLine("limit", { until: "11:20" }), { text: "⏳ Limit doldu · 11:20'de sürer", silent: true });
  assert.deepEqual(eventLine("resume", { nn: "07" }), { text: "▶️ #07 kaldığı yerden sürüyor", silent: true });
  assert.equal(eventLine("retry", { nn: "18" }).silent, false);
  assert.equal(eventLine("quiet", { nn: "12", minutes: 30, step: "Wait <x>" }).text, "⚠️ #12 30 dakikadır sessiz · son adım: Wait &lt;x&gt;");
  assert.deepEqual(eventLine("effort", { nn: "21", got: "high", want: "xhigh" }), { text: "⚠️ #21 high düzeyde çalışıyor (xhigh olmalı)", silent: false });
});

test("a transient error is one silent line with the retry time", () => {
  assert.deepEqual(eventLine("error", { nn: "07", until: "03:12" }),
    { text: "🔌 #07 bağlantı ya da API hatası · 03:12'de yeniden denenecek", silent: true });
});

test("the chain's end card counts the jobs and what waits, with each job one line in the details", () => {
  const { text } = chainCard({
    reason: "STOP: plan bitti", project: "demo-app", jobs: [
      { nn: "01", ok: true, title: "R7 closure", took: "1 sa 2 dk" },
      { nn: "02", ok: false, title: "R8 plan", took: "20 dk" },
    ], took: "23 sa 25 dk", cost: "$44.09", seven: "%24→%57", waits: 3, rows: ["ana opus 5.5 · 9 çağrı · $1"], problems: ["guard 1 kez reddetti"],
  });
  const head = text.split("<blockquote")[0].trim().split("\n");
  assert.deepEqual(head, [
    "🏁 <b>Zincir bitti · demo-app</b>",
    "plan bitti",
    "2 iş · 23 sa 25 dk · $44.09 · 7g %24→%57",
    "🙋 Seni bekleyen 3 madde",
  ]);
  assert.match(text, /✅ #01 R7 closure · 1 sa 2 dk\n❌ #02 R8 plan · 20 dk/);
  assert.doesNotMatch(text, /Token|çağrı/);
});

test("the next step drops its technical tail: an unclosed bracket, code and hashes", () => {
  const text = (next) => ["## 2026-11-10 · run 5 · session 7 (14:10–14:58) · D3b", `**Next:** ${next}`].join("\n");
  assert.equal(reportSection(text("the D3 closure (round-closure-review over `1384f12..HEAD`, one fix wave, every walk)."), "7", "14:10").next, "the D3 closure");
  assert.equal(reportSection(text("R10's plan (Taskbar), after `/clear`, base `abc`."), "7", "14:10").next, "R10's plan (Taskbar)");
  assert.equal(reportSection(text("fix `ab12cd3` in the walk."), "7", "14:10").next, "fix in the walk");
});

test("/rapor is a short card: this run's jobs one line each, the progress, problems and what waits", () => {
  const { text, silent } = reportCard({
    project: "demo-app", state: "çalışıyor", at: "15:54", progress: "3/5 iş bitti · tahmini bitiş ~17:20",
    five: "%39", seven: "%50", cost: "$40.72",
    jobs: [
      { nn: "05", ok: true, title: "D3 design and plan", took: "31 dk" },
      { nn: "06", ok: true, title: "D3a, type scale", took: "58 dk" },
      { nn: "08", running: true, took: "55 dk", step: "D3 closure fix wave" },
    ],
    problems: [], waits: ["R65's physical acceptance"],
  });
  assert.equal(silent, true);
  assert.deepEqual(text.split("\n"), [
    "🌙 <b>demo-app</b> · çalışıyor · 15:54",
    "📊 3/5 iş bitti · tahmini bitiş ~17:20",
    "5s %39 · 7g %50 · $40.72",
    "",
    "<b>İşler</b>",
    "✅ #05 D3 design and plan · 31 dk",
    "✅ #06 D3a, type scale · 58 dk",
    "⏳ #08 sürüyor · 55 dk · son adım: D3 closure fix wave",
    "",
    "<b>Seni bekleyen</b> · 1",
    "• R65's physical acceptance",
  ]);
  const many = reportCard({ project: "x", state: "durdu", at: "01:00", jobs: Array.from({ length: 30 }, (_, i) => ({ nn: String(i), ok: true, title: "t", took: "1 dk" })), problems: ["❌ #3 hata"], waits: [] });
  assert.match(many.text, /<b>İşler<\/b>\n… 18 iş daha\n✅ #18 t/);
  assert.match(many.text, /<b>Sorunlar<\/b>\n❌ #3 hata/);
});

test("/durum answers with what runs now and the limits", () => {
  const { text } = statusCard({ project: "demo-app", running: true, nn: "19", took: "59 dk", step: "Wait for T4", effort: "xhigh",
    five: "%72", fiveReset: "11:20", seven: "%56", last: { nn: "18", ok: true, title: "R13 T1" } });
  assert.deepEqual(text.split("\n"), [
    "🌙 <b>demo-app</b> · çalışıyor",
    "#19 · 59 dk · xhigh · son adım: Wait for T4",
    "5s %72 (11:20'de sıfırlanır) · 7g %56",
    "Son biten: ✅ #18 R13 T1",
  ]);
});

const report = [
  "## 2026-10-30 · session 7 (08:25–08:50) · R7 T1 (Effects)",
  "", "**Next:** something from run 1.",
  "## 2026-10-31 · run 2 · session 7 (19:23–22:25, stopped by the usage limit) · R9 closure (Mouse Pet) — R9 done",
  "", "**Done**", "- a", "", "**Waits for you**", "- **Look at** the `pet` stage", "  more of it", "- Physical test of R61", "",
  "**Next:** R10's plan (Taskbar), after `/clear`, base `abc`.",
  "## 2026-10-31 · run 2 · session 8 (22:19–23:01) · R10 plan",
].join("\n");

test("a job's section is found by its number and start time, not by the first heading with that number", () => {
  const s = reportSection(report, "07", "19:24");
  assert.equal(s.title, "R9 closure (Mouse Pet) — R9 done");
  assert.equal(s.next, "R10's plan (Taskbar)");
  assert.deepEqual(s.waits, ["Look at the pet stage", "Physical test of R61"]);
  assert.equal(s.older, 0);
  assert.equal(reportSection(report, "07", "12:00"), null);
});

// Run 2's sections split what waits into this session's new items and a list carried from earlier ones.
test("only the new waits are listed; the carried ones are counted", () => {
  const nested = [
    "## 2026-10-31 · run 2 · session 13 (03:07–04:35) · R11 closure",
    "**Waits for you**", "- New:", "  - decisions 1–5 above;", "  - **an orphan Edge** is still running.",
    "- Still waiting (from sessions 1–12):", "  - R11's task decisions;", "  - merging `cloud/min-window`.",
    "- No physical acceptance, and nothing touched the desktop.", "", "**Next:** the R12 plan.",
  ].join("\n");
  const s = reportSection(nested, "13", "03:07");
  assert.deepEqual(s.waits, ["decisions 1–5 above", "an orphan Edge is still running"]);
  assert.equal(s.older, 2);
  const { text } = sessionCard({ ...done, waits: s.waits, older: s.older });
  assert.match(text, /<b>Seni bekleyen<\/b> · 2\n• decisions 1–5 above\n• an orphan Edge is still running\n\+ 2 eski madde/);
});

// Sessions also write each item on one line, "- New: <item>" and "- Still waiting (…): <item>"
// (audit 2: a two-session trial and run 5's session 9; the cards showed nothing waiting for all three).
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
test("a one-line '- New: …' is one waiting item and a one-line '- Still waiting …: …' one carried item", () => {
  const starts = (s, ...heads) => {
    assert.equal(s.waits.length, heads.length, JSON.stringify(s.waits));
    heads.forEach((h, i) => { assert.ok(s.waits[i].startsWith(h), s.waits[i]); assert.ok(s.waits[i].length <= 100); });
  };
  const trial = fixture("report-inline-waits-trial.md");
  const t1 = reportSection(trial, "01", "19:02");
  starts(t1, "Lisans seçimi (MIT ya da Apache-2.0).");
  assert.equal(t1.older, 0);
  const t2 = reportSection(trial, "02", "19:13");
  starts(t2, "slugify şapkalı ve aksanlı harfleri ASCII'ye mi çevirsin");
  assert.equal(t2.older, 1);
  const r5 = reportSection(fixture("report-inline-waits-run5-s09.md"), "9", "16:49");
  starts(r5, "your feedback on D3.", "R66's physical acceptance, using R65's list");
  assert.equal(r5.older, 1);
});

test("'- New: none' is no waiting item, and the carried ones are still counted", () => {
  const none = (rest) => ["## 2026-11-10 · run 1 · session 03 (20:00–20:30) · Fix wave", "", "**Waits for you**", "- New: none.", ...rest, "", "**Remaining:** 0 sessions"].join("\n");
  const s = reportSection(none(["- Still waiting (session 01): the licence, `docs/plan.md:44`."]), "03", "20:00");
  assert.deepEqual(s.waits, []);
  assert.equal(s.older, 1);
  assert.deepEqual(reportSection(none([]), "03", "20:00").waits, []);
});

test("an item that only starts with the word 'New' is not a group heading", () => {
  const text = ["## 2026-11-10 · run 1 · session 04 (21:00–21:30) · Icons", "**Waits for you**", "- New icon set: pick one, `docs/icons.md:12`.", "- Still waiting for the push"].join("\n");
  assert.deepEqual(reportSection(text, "04", "21:00").waits, ["New icon set: pick one, docs/icons.md:12", "Still waiting for the push"]);
});

// Run 2, 2026-10-30 session 8 and run 2 session 2 wrote these headings.
test("a group heading may carry a comma clause or 'from …' before its colon", () => {
  const text = ["## 2026-10-30 · run 2 · session 2 (12:52–13:40) · R8 plan", "**Waits for you**",
    "- **New, tooling:** the driver re-applies the window size on every call.", "- Look at decisions 1, 2, 10 and 14.",
    "- Still waiting from earlier sessions:", "  - the R54 question;", "  - merging `cloud/min-window`."].join("\n");
  const s = reportSection(text, "2", "12:52");
  assert.deepEqual(s.waits, ["the driver re-applies the window size on every call"]);
  assert.equal(s.older, 2);
});

// ---------------------------------------------------------------- progress
// A session's report says how many sessions the approved work still needs ("**Remaining:**");
// the cards turn it into how far the chain is and when it should end.
import { chainProgress, progressText } from "./telegram-cards.mjs";

const at = (h, m = 0, day = 10) => new Date(2026, 10, day, h, m);
const min = (n) => n * 60_000;
const job = (workMin, remaining = null, extra = {}) => ({ ok: true, ended: true, workMs: min(workMin), remaining, ...extra });

test("a section's **Remaining:** line is read as a number; without it, nothing is known", () => {
  const text = [
    "## 2026-11-10 · run 5 · session 7 (14:10–14:58) · D3b",
    "**Waits for you**", "- New: none.", "",
    "**Remaining:** 2 sessions (the closure, then the package).", "",
    "**Next:** the D3 closure.",
  ].join("\n");
  assert.equal(reportSection(text, "7", "14:10").remaining, 2);
  assert.equal(reportSection(report, "07", "19:24").remaining, null);
});

test("between two jobs: the jobs left at this run's mean working time, from now", () => {
  const p = chainProgress([job(30), job(60), job(45, 2)], { now: at(15) });
  assert.deepEqual({ done: p.done, total: p.total, left: p.left }, { done: 3, total: 5, left: 2 });
  assert.deepEqual(p.eta, at(16, 30));
  assert.equal(progressText(p, at(15)), "3/5 iş bitti · tahmini bitiş ~16:30");
});

test("a running job counts as one of the jobs left, with only its rest still to come", () => {
  const running = { ok: false, ended: false, workMs: min(20), remaining: null };
  assert.deepEqual(chainProgress([job(30), job(60), job(45, 2), running], { now: at(15) }).eta, at(16, 10));
  // Past the mean, the running job is taken as ending now.
  assert.deepEqual(chainProgress([job(30), job(60), job(45, 2), { ...running, workMs: min(70) }], { now: at(15) }).eta, at(15, 45));
});

test("a later report without the line: the jobs finished since come off the last count", () => {
  const p = chainProgress([job(40, 3), job(50)], { now: at(15) });
  assert.deepEqual({ done: p.done, total: p.total, left: p.left }, { done: 2, total: 4, left: 2 });
});

test("a failed job is not done and its time is not in the mean", () => {
  const p = chainProgress([job(40, 3), job(5, null, { ok: false })], { now: at(15) });
  assert.deepEqual({ done: p.done, left: p.left }, { done: 1, left: 3 });
  assert.deepEqual(p.eta, at(17));
});

test("while a job runs, at least that job is left, even when the last count ran out", () => {
  const p = chainProgress([job(40, 1), job(40), { ok: false, ended: false, workMs: min(10), remaining: null }], { now: at(15) });
  assert.equal(p.left, 1);
  assert.deepEqual(p.eta, at(15, 30));
});

test("no report has said what remains: the jobs done, without a total or an estimate", () => {
  const p = chainProgress([job(40), job(50)], { now: at(15) });
  assert.deepEqual(p, { done: 2, total: null, left: null, eta: null });
  assert.equal(progressText(p, at(15)), "2 iş bitti");
  assert.equal(chainProgress([], { now: at(15) }), null);
});

test("nothing left: the count without an estimate", () => {
  const p = chainProgress([job(40, 1), job(50, 0)], { now: at(15) });
  assert.equal(p.eta, null);
  assert.equal(progressText(p, at(15)), "2/2 iş bitti");
});

test("a usage-limit wait moves the estimate to when the chain goes on", () => {
  const cut = { ok: false, ended: false, workMs: min(20), remaining: null };
  assert.deepEqual(chainProgress([job(60, 2), cut], { now: at(15), waitUntil: at(17) }).eta, at(18, 40));
});

test("the estimate is rounded to five minutes and says when it falls on another day", () => {
  assert.equal(progressText({ done: 1, total: 3, left: 2, eta: at(23, 58) }, at(22)), "1/3 iş bitti · tahmini bitiş yarın ~00:00");
  assert.equal(progressText({ done: 1, total: 3, left: 2, eta: at(16, 12) }, at(15)), "1/3 iş bitti · tahmini bitiş ~16:10");
  assert.equal(progressText({ done: 1, total: 9, left: 8, eta: at(9, 0, 12) }, at(15)), "1/9 iş bitti · tahmini bitiş 12.11 ~09:00");
});

test("the job card, /durum and the limit line carry the progress", () => {
  const head = sessionCard({ ...done, progress: "3/5 iş bitti · tahmini bitiş ~16:30" }).text.split("<blockquote")[0].trim().split("\n");
  assert.deepEqual(head.slice(1, 4), ["1 sa 21 dk · $19.24 · 5s %56 · 7g %47", "📊 3/5 iş bitti · tahmini bitiş ~16:30", "➡️ R12 plan (Settings)"]);
  const status = statusCard({ project: "demo-app", running: true, nn: "19", took: "59 dk", progress: "3/5 iş bitti · tahmini bitiş ~16:30" });
  assert.deepEqual(status.text.split("\n").slice(1, 3), ["#19 · 59 dk", "📊 3/5 iş bitti · tahmini bitiş ~16:30"]);
  assert.equal(eventLine("limit", { until: "17:00", progress: "3/5 iş bitti · tahmini bitiş ~18:40" }).text,
    "⏳ Limit doldu · 17:00'de sürer · 3/5 iş bitti · tahmini bitiş ~18:40");
  assert.equal(eventLine("limit", { until: "17:00" }).text, "⏳ Limit doldu · 17:00'de sürer");
});

// ---------------------------------------------------------------- tolerant markers, safe splitting
test("a report with CRLF line ends is read like one with LF", () => {
  const crlf = reportSection(report.replace(/\n/g, "\r\n"), "07", "19:24");
  assert.ok(crlf);
  assert.deepEqual(crlf, reportSection(report, "07", "19:24"));
});
test("the markers are read with the colon inside or outside the bold, and an approximate count", () => {
  const sec = (body) => `## 2026-11-16 · session 03 (02:00–03:00) · T\n\n${body}\n`;
  assert.equal(reportSection(sec("**Remaining**: 2"), "03", "02:00").remaining, 2);
  assert.equal(reportSection(sec("**Remaining:** ~4"), "03", "02:00").remaining, 4);
  const a = reportSection(sec("**Waits for you:**\n- New: push the branch"), "03", "02:00");
  const b = reportSection(sec("**Waits for you**\n- New: push the branch"), "03", "02:00");
  assert.deepEqual(a.waits, b.waits);
  assert.equal(a.waits.length, 1);
});
test("a card whose head alone is too long is cut, never over Telegram's limit", () => {
  const c = sessionCard({ ...done, title: "x".repeat(6000) });
  assert.ok(c.text.length <= 4096);
  // the cut keeps the bold tag closed, and an entity is never cut in half
  assert.match(c.text, /…<\/b>$/);
  const e = sessionCard({ ...done, title: "&".repeat(6000) }).text;
  assert.ok(e.length <= 4096);
  assert.doesNotMatch(e.replace(/&amp;/g, ""), /&/);
});
test("a long report is split at line ends with its tags closed and reopened", () => {
  const html = `<b>Jobs</b>\n<pre>${Array.from({ length: 300 }, (_, i) => `#${i} ${"y".repeat(40)}`).join("\n")}</pre>\ntail`;
  const parts = splitHtml(html);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 4000);
    assert.equal((p.match(/<pre>/g) || []).length, (p.match(/<\/pre>/g) || []).length);
  }
  assert.equal(parts.join("\n").replace(/<\/pre>\n<pre>/g, "\n"), html);
  assert.equal(splitHtml("short").length, 1);
});
test("a single line longer than the limit is cut hard, but not inside a tag or an entity, and each part still fits", () => {
  const html = `<blockquote expandable>${"a &amp; <b>b</b> ".repeat(500)}</blockquote>`;
  const parts = splitHtml(html, 300);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 300);
    assert.equal((p.match(/<blockquote expandable>/g) || []).length, (p.match(/<\/blockquote>/g) || []).length);
    assert.equal((p.match(/<b>/g) || []).length, (p.match(/<\/b>/g) || []).length);
    assert.doesNotMatch(p.replace(/<[^>]*>|&amp;/g, ""), /[<>&]/);
  }
});
test("a head that nearly fills the message never leaves a half tag or an open one, for any title length", () => {
  const waits = ["w1", `w2 ${"z".repeat(300)}`];
  for (let n = 3900; n <= 4060; n++) {
    const { text } = sessionCard({ ...done, title: "x".repeat(n), waits });
    assert.ok(text.length <= 4096, `length at ${n}`);
    for (const tag of ["b", "blockquote", "pre"]) {
      assert.equal((text.match(new RegExp(`<${tag}[ >]`, "g")) || []).length, (text.match(new RegExp(`</${tag}>`, "g")) || []).length, `<${tag}> at ${n}`);
    }
    assert.doesNotMatch(text.replace(/<[^>]*>/g, ""), /[<>]/, `half tag at ${n}`);
  }
});
