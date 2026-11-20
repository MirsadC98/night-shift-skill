// node --test night-shift/scripts/lang.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strings, langOf, loadLang, langFile } from "./lang/index.mjs";
import en from "./lang/en.mjs";
// A CLAUDE_CONFIG_DIR of the user's own would move every file these tests read or write (claudeHome in config.mjs).
delete process.env.CLAUDE_CONFIG_DIR;

const XX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lang-xx.mjs");
const throwaway = () => fs.mkdtempSync(path.join(os.tmpdir(), "ns-lang-"));
const homeWithGlobal = (cfg) => {
  const home = throwaway();
  fs.mkdirSync(path.join(home, ".claude", "night-shift"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "night-shift", "config.json"), JSON.stringify(cfg));
  return home;
};
// A home holding the user's table for code: the made-up one, or the text given.
const homeWithTable = (code, text) => {
  const home = throwaway(), file = langFile(code, home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (text === undefined) fs.copyFileSync(XX, file);
  else fs.writeFileSync(file, text);
  return home;
};

// Every key path of a table with the kind of its value; a nested object is walked.
const shape = (t, prefix = "") => Object.entries(t).flatMap(([k, v]) => (v && typeof v === "object" ? shape(v, `${prefix}${k}.`) : [[`${prefix}${k}`, typeof v]]));

test("the English table names its language and its night-report commit phrase", () => {
  assert.equal(en.name, "English");
  assert.equal(en.reportCommit, "night report");
  assert.equal(en.cmdStatus, "status");
  assert.equal(en.cmdReport, "report");
  assert.equal(en.cmdStop, "stop");
  assert.equal(en.cmdNow, "now");
  assert.equal(en.cmdInbox, "inbox");
  assert.ok(shape(en).length > 50, "the walk reached the table's contents");
});

test("a user table lives in ~/.claude/night-shift/lang/<code>.mjs", () => {
  assert.equal(langFile("xx", "/h"), path.join("/h", ".claude", "night-shift", "lang", "xx.mjs"));
});

test("a language nothing loaded reads English", () => {
  assert.equal(strings("de"), strings("en"));
  assert.equal(strings(), strings("en"));
  assert.equal(strings("en"), en);
});

test("the user's table is found and used, and a key it lacks or gives the wrong kind reads English", async () => {
  const home = homeWithTable("xx");
  const r = await loadLang("xx", home);
  assert.equal(r.error, undefined);
  const T = strings("xx");
  assert.equal(r.table, T);
  assert.equal(T.name, "Xxish");
  assert.equal(T.reportTitle, "xx·title");
  assert.equal(T.ended("STOP: done"), "xx·ended: STOP: done");
  assert.equal(T.ev.start({ project: "p" }), "🌙 xx·start · p");
  assert.equal(T.cli.userWaits([]), "xx·waits: none");
  assert.equal(T.cmdStatus, "xxstatus");
  assert.equal(T.cmdReport, "xxreport");
  assert.equal(T.cmdStop, "xxstop");
  assert.equal(T.cmdNow, "xxnow");
  assert.equal(T.cmdInbox, "xxinbox");
  assert.equal(T.reportCommit, "xx·report");
  // what the table leaves out, top-level and nested, is the English text
  assert.equal(T.noProblems, en.noProblems);
  assert.equal(T.ev.limit, en.ev.limit);
  assert.equal(T.cli.noRun, en.cli.noRun);
  assert.equal(T.note.mainCut, en.note.mainCut);
  assert.equal(T.note.fableAsked("why", "Mythos"), "xx·asked Mythos (why)");
  assert.equal(T.pct(40), "40%", "a string where English has a function reads English");
  assert.equal(T.note.fableCut("Mythos"), en.note.fableCut("Mythos"), "so does a nested one (a note from before it named the model)");
  // the result has English's shape: every key, each of English's kind
  assert.deepEqual(shape(T), shape(en));
});

test("a table that is missing, does not load or exports no table is an error naming its path, and reads English", async () => {
  const empty = throwaway();
  const missing = await loadLang("yy", empty);
  assert.match(missing.error, /no language table at /);
  assert.ok(missing.error.includes(langFile("yy", empty)), missing.error);
  assert.equal(missing.file, langFile("yy", empty));
  assert.equal(strings("yy"), en);
  const broken = await loadLang("zz", homeWithTable("zz", "export default {\n  name: 'Zz',,\n};\n"));
  assert.match(broken.error, /zz\.mjs does not load: /);
  assert.equal(strings("zz"), en);
  const thrown = await loadLang("zt", homeWithTable("zt", "throw new Error('boom');\nexport default {};\n"));
  assert.match(thrown.error, /does not load: boom/);
  const none = await loadLang("zn", homeWithTable("zn", "export const name = 'Zn';\n"));
  assert.match(none.error, /zn\.mjs exports no table \(export default \{ … \}\)/);
  assert.equal(strings("zn"), en);
});

test("a table names its language in the language itself (nativeName), and one without it is named by its name, never by English's", async () => {
  assert.equal(en.nativeName, "English");
  // 2026-11-20: the dashboard's switch read "Turkish" for the user's Turkish table, since `name` is the English name
  const own = await loadLang("yn", homeWithTable("yn", "export default { name: 'Ynnish', nativeName: 'Ynçe' };\n"));
  assert.deepEqual([own.table.name, own.table.nativeName], ["Ynnish", "Ynçe"]);
  // a table from before the key: its own name, not the "English" every other missing key reads
  assert.equal((await loadLang("xx", homeWithTable("xx"))).table.nativeName, "Xxish");
  for (const [code, text] of [["yo", "nativeName: '  '"], ["yp", "nativeName: 5"], ["yr", "nativeName: null"]])
    assert.equal((await loadLang(code, homeWithTable(code, `export default { name: 'Yish', ${text} };\n`))).table.nativeName, "Yish", code);
  // neither: the code, as for name
  const bare = (await loadLang("ys", homeWithTable("ys", "export default { reportTitle: 'ys·title' };\n"))).table;
  assert.deepEqual([bare.name, bare.nativeName], ["ys", "ys"]);
  // a native name alone does not name the language for the session header, which reads English
  const only = (await loadLang("yt", homeWithTable("yt", "export default { nativeName: 'Ytçe' };\n"))).table;
  assert.deepEqual([only.name, only.nativeName], ["yt", "Ytçe"]);
});

test("a table without a name reads its code as its name, and command names Telegram would refuse read English", async () => {
  const nameless = await loadLang("zq", homeWithTable("zq", "export default { name: '  ', reportTitle: 'zq·title' };\n"));
  assert.equal(nameless.error, undefined);
  assert.equal(nameless.table.name, "zq");
  assert.equal(nameless.table.reportTitle, "zq·title");
  // Each name on its own: one Telegram would refuse, another command's English name, or a name an earlier command
  // took reads English, and the others keep theirs.
  const cases = [["zc", "'Status'", "'zcreport'", "'zcstop'", ["status", "zcreport", "zcstop"]],
    ["zd", "'report'", "'zdreport'", "'zdstop'", ["status", "zdreport", "zdstop"]],
    ["ze", "'same'", "'same'", "'same'", ["same", "report", "stop"]],
    ["zf", `'${"s".repeat(33)}'`, "'zfreport'", "'zfstop'", ["status", "zfreport", "zfstop"]],
    ["zg", "'zgstatus'", "'status'", "'report'", ["zgstatus", "report", "stop"]],
    ["zi", "'zi-status'", "'zireport'", "'zi stop'", ["status", "zireport", "stop"]],
    ["zj", "'durum'", "'rapor'", "'stop'", ["durum", "rapor", "stop"]]];
  for (const [code, status, report, stop, want] of cases) {
    const r = await loadLang(code, homeWithTable(code, `export default { name: 'Z', cmdStatus: ${status}, cmdReport: ${report}, cmdStop: ${stop} };\n`));
    assert.equal(r.error, undefined, code);
    assert.deepEqual([r.table.cmdStatus, r.table.cmdReport, r.table.cmdStop], want, code);
  }
  const good = await loadLang("zh", homeWithTable("zh", "export default { name: 'Z', cmdStatus: 'zh_status2', cmdReport: 'zhreport' };\n"));
  assert.deepEqual([good.table.cmdStatus, good.table.cmdReport, good.table.cmdStop], ["zh_status2", "zhreport", "stop"]);
  // /inbox's name is checked the same way, after the other three.
  for (const [code, names, want] of [["ya", "cmdStatus: 'yas', cmdInbox: 'yas'", ["yas", "inbox"]], ["yb", "cmdInbox: 'stop'", ["status", "inbox"]],
    ["yc", "cmdInbox: 'not'", ["status", "not"]]]) {
    const r = await loadLang(code, homeWithTable(code, `export default { name: 'Z', ${names} };\n`));
    assert.deepEqual([r.table.cmdStatus, r.table.cmdInbox], want, code);
  }
  // The word after /stop that stops at once: one word of up to 32 characters, any letters, else English.
  for (const [code, word, want] of [["zk", "'şimdi'", "şimdi"], ["zl", "'two words'", "now"], ["zm", "''", "now"], ["zn", `'${"n".repeat(33)}'`, "now"]]) {
    const r = await loadLang(code, homeWithTable(code, `export default { name: 'Z', cmdNow: ${word} };\n`));
    assert.equal(r.table.cmdNow, want, code);
  }
});

test("a command description Telegram would refuse (not 1 to 256 characters) reads English, each on its own", async () => {
  const long = "d".repeat(257), most = "d".repeat(256);
  const cases = [["zu", "", "zu report", ""], ["zv", "   ", "zv report", "zv stop"], ["zw", long, "zw report", long],
    ["zy", "zy status", "", "zy stop"], ["zz", most, "zz report", most]];
  const want = { zu: [en.cmdStatusDesc, "zu report", en.cmdStopDesc], zv: [en.cmdStatusDesc, "zv report", "zv stop"],
    zw: [en.cmdStatusDesc, "zw report", en.cmdStopDesc], zy: ["zy status", en.cmdReportDesc, "zy stop"], zz: [most, "zz report", most] };
  for (const [code, status, report, stop] of cases) {
    const r = await loadLang(code, homeWithTable(code, `export default { name: 'Z', cmdStatusDesc: ${JSON.stringify(status)}, cmdReportDesc: ${JSON.stringify(report)}, cmdStopDesc: ${JSON.stringify(stop)} };\n`));
    assert.equal(r.error, undefined, code);
    assert.deepEqual([r.table.cmdStatusDesc, r.table.cmdReportDesc, r.table.cmdStopDesc], want[code], code);
  }
  const inbox = await loadLang("yd", homeWithTable("yd", `export default { name: 'Z', cmdInboxDesc: ${JSON.stringify(long)} };\n`));
  assert.equal(inbox.table.cmdInboxDesc, en.cmdInboxDesc);
});

test("loadLang refuses a code of the wrong shape before it looks for a file, and en needs no file", async () => {
  for (const bad of ["../x", "TR", "tr-TR", "x", "", "a/b", "en.mjs"]) {
    const r = await loadLang(bad, throwaway());
    assert.match(r.error, /is not a language code/, bad);
    assert.equal(r.file, undefined, bad);
  }
  const r = await loadLang("en", throwaway());
  assert.equal(r.error, undefined);
  assert.equal(r.table, en);
});

test("langOf: the run's own language, else the config files as they are now, else en", () => {
  const repo = path.join(throwaway(), "repo");
  assert.equal(langOf({ lang: "xx" }), "xx");
  assert.equal(langOf({ repo, lang: undefined }, homeWithGlobal({ lang: "xx" })), "xx");   // a run.json from before the language was a setting
  assert.equal(langOf({}, throwaway()), "en");
  assert.equal(langOf({ repo }, throwaway()), "en");
  assert.equal(langOf({}, homeWithGlobal({ lang: "xx" })), "xx");
  // the project's file wins over the global one; a value that is no language code is not one
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "night-shift.json"), JSON.stringify({ lang: "en" }));
  assert.equal(langOf({ repo }, homeWithGlobal({ lang: "xx" })), "en");
  assert.equal(langOf({ repo: path.join(throwaway(), "x"), lang: "X X" }, homeWithGlobal({ lang: "../fr" })), "en");
});

test("every dash entry is a plain string", () => {
  assert.ok(Object.keys(en.dash).length > 50, "the dashboard's words are in the table");
  for (const [k, v] of Object.entries(en.dash)) {
    assert.equal(typeof v, "string", k);
    // a place is {name}; a brace that is not one would reach the page as it is
    assert.equal(v.replace(/\{[a-z][A-Za-z]*\}/g, "").match(/[{}]/), null, k);
  }
});

test("a user table's dash words go over English's, key by key", async () => {
  const r = await loadLang("xx", homeWithTable("xx"));
  assert.equal(r.error, undefined);
  const mine = Object.entries(strings("xx").dash).filter(([k, v]) => v !== en.dash[k]).map(([k]) => k).sort();
  assert.deepEqual(mine, ["stateRunning", "waitsHead"]);
  assert.deepEqual(Object.keys(strings("xx").dash), Object.keys(en.dash));
});
