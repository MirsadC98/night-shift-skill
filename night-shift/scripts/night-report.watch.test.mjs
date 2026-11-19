// node --test night-shift/scripts/night-report.watch.test.mjs
// The Telegram watcher against a local stand-in for the bot API; no real Telegram, no real home.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// A CLAUDE_CONFIG_DIR of the user's own would move every file these tests read or write (claudeHome in config.mjs).
delete process.env.CLAUDE_CONFIG_DIR;

const REPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), "night-report.mjs");
// A made-up language table, "xx", that a scene copies into its home as the user's own (lang/index.mjs).
const XX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "lang-xx.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms, what) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(50); }
  assert.fail(`timed out waiting for ${what}`);
};
const RETRY = "session 02 left no continuation prompt; retrying with a recovery note";
const stamp = (line) => `[2026-11-16 03:00:00] ${line}\n`;

// answer(method, body, n) -> [status, json] or undefined for the default; n counts that method's calls.
// setMyCommands and getUpdates answer after 200 ms, as a long poll would, unless the test says otherwise.
async function bot(answer) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const method = req.url.split("/").pop();
      const body = raw ? JSON.parse(raw) : {};
      const n = calls.filter((c) => c.method === method).length;
      calls.push({ method, body, url: req.url });
      const [status, json] = answer(method, body, n) || [200, { ok: true, result: [] }];
      if (method === "setMyCommands" || method === "getUpdates") await sleep(200);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, sends: () => calls.filter((c) => c.method === "sendMessage"), close: () => server.close() };
}

// A throwaway home and state folder, a helper process standing in for the runner, the watcher itself.
// lang: null writes a run.json from before the language was a setting; lang "xx" puts the made-up table in the home
// unless table is false. configDir: the user set CLAUDE_CONFIG_DIR, so the night-shift folder sits there instead of in ~/.claude.
async function scene(answer, { chatId = 42, notified, env = {}, token = "T", lang = "en", table = true, configDir = false } = {}, body) {
  const api = await bot(answer);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-watch-"));
  const home = path.join(dir, "home"), state = path.join(dir, "state"), root = path.join(dir, "repo");
  const claude = configDir ? path.join(dir, "claude-config") : path.join(home, ".claude");
  fs.mkdirSync(path.join(claude, "night-shift"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(state);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(claude, "night-shift", "telegram.json"), JSON.stringify({ token, chatId }));
  if (lang === "xx" && table) {
    fs.mkdirSync(path.join(claude, "night-shift", "lang"));
    const file = path.join(claude, "night-shift", "lang", "xx.mjs");
    // table: true copies the made-up table; a string is a table's own text.
    if (typeof table === "string") fs.writeFileSync(file, table); else fs.copyFileSync(XX, file);
  }
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ repo: root, ...(lang && { lang }) }));
  fs.writeFileSync(path.join(state, "chain.log"), "");
  if (notified !== undefined) fs.writeFileSync(path.join(state, "notified.json"), notified);
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  let watcher, code;
  let onExit;
  const exited = new Promise((r) => { onExit = r; });
  try {
    watcher = spawn(process.execPath, [REPORT, "watch", "--state", state, "--pid", String(helper.pid)], {
      stdio: "ignore", windowsHide: true,
      env: { ...process.env, USERPROFILE: home, HOME: home, NIGHT_SHIFT_TELEGRAM_API: api.url, NIGHT_SHIFT_SEND_RETRY_MS: "100", ...(configDir ? { CLAUDE_CONFIG_DIR: claude } : {}), ...env },
    });
    watcher.on("exit", (c) => { code = c ?? -1; onExit(code); });
    const chain = (line) => fs.appendFileSync(path.join(state, "chain.log"), stamp(line));
    await body({ api, state, home, chain, exited, watcher, helper, ended: () => code !== undefined });
  } finally {
    watcher?.kill();
    helper.kill();
    api.close();
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("a card Telegram did not take is sent again, and the log line is counted only then", async () => {
  const down = [500, { ok: false, error_code: 500, description: "Internal Server Error" }];
  await scene((m, b, n) => (m === "sendMessage" ? (n < 2 ? down : [200, { ok: true }]) : undefined), {}, async ({ api, state, chain }) => {
    chain(RETRY);
    await until(() => api.sends().length >= 3, 10_000, "three sendMessage calls");
    assert.match(api.sends().at(-1).body.text, /#02 left no continuation prompt/);
    const marked = () => { try { return JSON.parse(fs.readFileSync(path.join(state, "notified.json"), "utf8")).lines; } catch { return 0; } };
    await until(() => marked() === 1, 5_000, "the line to be counted");
    assert.equal(api.sends().length, 3);
  });
});

test("a refusal for good is not repeated; unreadable HTML goes out once more as plain text", async () => {
  const refused = [400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }];
  await scene((m, b) => (m === "sendMessage" ? (b.parse_mode ? refused : [200, { ok: true }]) : undefined), {}, async ({ api, chain, exited }) => {
    chain("chain ends: STOP: done");
    await exited; // the card is the chain's last; the watcher ends after it
    const sent = api.sends();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].body.parse_mode, "HTML");
    assert.equal(sent[1].body.parse_mode, undefined);
    assert.doesNotMatch(sent[1].body.text, /</);
  });
});

test("with Telegram down at the chain's end the watcher gives up, says so in watch.log and exits", async () => {
  const down = [500, { ok: false, error_code: 500, description: "Internal Server Error" }];
  await scene((m) => (m === "sendMessage" ? down : undefined), { env: { NIGHT_SHIFT_SEND_GIVEUP_MS: "500" } }, async ({ state, chain, exited }) => {
    chain("chain ends: STOP: done");
    const code = await Promise.race([exited, sleep(10_000).then(() => "still running")]);
    assert.notEqual(code, "still running");
    assert.equal(fs.existsSync(path.join(state, "watch.pid")), false);
    assert.match(fs.readFileSync(path.join(state, "watch.log"), "utf8"), /gave up on a card after \d+ tries/);
  });
});

test("a half-written notified.json or telegram.json does not end the watcher", async () => {
  await scene(() => undefined, { notified: "{" }, async ({ api, state, home, chain, ended }) => {
    chain(RETRY);
    await until(() => api.sends().length >= 1, 10_000, "a sendMessage call");
    const marked = () => { try { return JSON.parse(fs.readFileSync(path.join(state, "notified.json"), "utf8")).lines; } catch { return 0; } };
    await until(() => marked() === 1, 5_000, "the line to be counted");
    // telegram.json caught mid-write: the card cannot go out, the watcher stays up
    fs.writeFileSync(path.join(home, ".claude", "night-shift", "telegram.json"), "{");
    chain(RETRY);
    await until(() => marked() === 2, 10_000, "the second line to be counted");
    assert.equal(ended(), false);
    assert.equal(api.sends().length, 1);
  });
});

test("a chat id saved as text still answers /status", async () => {
  const ask = { ok: true, result: [{ update_id: 1, message: { chat: { id: 42 }, date: Math.floor(Date.now() / 1000), text: "/status" } }] };
  await scene((m, b, n) => (m === "getUpdates" && n === 0 ? [200, ask] : m === "sendMessage" ? [200, { ok: true }] : undefined), { chatId: "42" }, async ({ api }) => {
    await until(() => api.sends().length >= 1, 10_000, "the /status answer");
  });
});

// A command typed in the user's own chat: the English name always answers, and so does the name the run's table gives it.
const asked = (text) => ({ ok: true, result: [{ update_id: 1, message: { chat: { id: 42 }, date: Math.floor(Date.now() / 1000), text } }] });
const asking = (text) => (m, b, n) => (m === "getUpdates" && n === 0 ? [200, asked(text)] : m === "sendMessage" ? [200, { ok: true }] : undefined);

test("/status and the table's own name both answer, in the run's language; a name only another table gives does not", async () => {
  for (const cmd of ["/status", "/xxstatus"]) {
    await scene(asking(cmd), { lang: "xx" }, async ({ api }) => {
      await until(() => api.sends().length >= 1, 10_000, `the ${cmd} answer`);
      assert.match(api.sends()[0].body.text, /<b>repo<\/b> · xx·running/);
    });
  }
  await scene(asking("/xxstatus"), { lang: "en" }, async ({ api }) => {
    await until(() => api.calls.filter((c) => c.method === "getUpdates").length >= 2, 10_000, "the poll after the command");
    await sleep(300);
    assert.equal(api.sends().length, 0);
  });
});

test("/report and the table's own name both give the report, in the run's language", async () => {
  for (const [lang, cmd, head] of [["en", "/report", /^🌙 <b>repo<\/b> · running · \d\d:\d\d/], ["xx", "/report", /^🌙 <b>repo<\/b> · xx·running · \d\d:\d\d/],
    ["xx", "/xxreport", /^🌙 <b>repo<\/b> · xx·running · \d\d:\d\d/]]) {
    await scene(asking(cmd), { lang }, async ({ api }) => {
      await until(() => api.sends().length >= 1, 10_000, `the ${cmd} answer`);
      assert.match(api.sends()[0].body.text, head);
    });
  }
});

test("the bot's menu lists the command pair of the run's language", async () => {
  for (const [lang, names] of [["xx", ["xxstatus", "xxreport"]], ["en", ["status", "report"]]]) {
    await scene(() => undefined, { lang }, async ({ api }) => {
      await until(() => api.calls.some((c) => c.method === "setMyCommands"), 10_000, "setMyCommands");
      assert.deepEqual(api.calls.find((c) => c.method === "setMyCommands").body.commands.map((c) => c.command), names);
    });
  }
});

test("a watcher whose language table is gone watches in English and says so once in watch.log", async () => {
  await scene(() => undefined, { lang: "xx", table: false }, async ({ api, state, chain }) => {
    chain(RETRY);
    await until(() => api.sends().length >= 1, 10_000, "the retry card");
    assert.match(api.sends()[0].body.text, /#02 left no continuation prompt, retrying/);
    assert.deepEqual(api.calls.find((c) => c.method === "setMyCommands").body.commands.map((c) => c.command), ["status", "report"]);
    const lines = fs.readFileSync(path.join(state, "watch.log"), "utf8").split("\n").filter((l) => /language table/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /\] language table: no language table at .*xx\.mjs; what the user reads is in English$/);
  });
});

test("a run.json from before the language was a setting is watched in English", async () => {
  await scene(() => undefined, { lang: null }, async ({ api, chain }) => {
    chain(RETRY);
    await until(() => api.sends().length >= 1, 10_000, "the retry card");
    assert.match(api.sends()[0].body.text, /#02 left no continuation prompt, retrying/);
  });
});

const marks = (state) => { try { return JSON.parse(fs.readFileSync(path.join(state, "notified.json"), "utf8")); } catch { return {}; } };
const logOf = (state) => { try { return fs.readFileSync(path.join(state, "watch.log"), "utf8"); } catch { return ""; } };
const SESSION_DONE = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, total_cost_usd: 1, session_id: "s-1", result: "ok" });

// fetch's own error text carries the URL, which holds the token; it must not reach watch.log.
test("a Telegram error that names the request's URL does not leak the token into watch.log", async () => {
  const token = "123456:SECRET-TOKEN-VALUE";
  await scene(() => undefined, { token, env: { NIGHT_SHIFT_TELEGRAM_API: "not a url", NIGHT_SHIFT_SEND_GIVEUP_MS: "300" } }, async ({ state, chain }) => {
    chain(RETRY);
    await until(() => /gave up on a card/.test(logOf(state)) && /getUpdates:/.test(logOf(state)), 15_000, "the send and getUpdates failures in watch.log");
    assert.match(logOf(state), /<token>/);
    assert.equal(logOf(state).includes("SECRET-TOKEN-VALUE"), false, logOf(state));
  });
});

// A mark is saved after its card went out, so a watcher that dies mid-send sends the card again.
// The old session file makes the quiet case due at once (no 30-minute wait); Telegram stays down until the test lifts it.
async function markAfterCard(prepare, mark, card) {
  let up = false;
  await scene((m) => (m === "sendMessage" ? (up ? [200, { ok: true }] : [500, { ok: false, error_code: 500, description: "down" }]) : undefined), {}, async ({ api, state, chain }) => {
    prepare(state);
    chain("session 01 starts: x");
    await until(() => api.sends().length >= 2, 10_000, "two attempts at the card");
    assert.match(api.sends()[0].body.text, card);
    assert.deepEqual(marks(state)[mark] ?? {}, {}, "the mark must wait for the card");
    const before = api.sends().length;
    up = true;
    await until(() => Object.keys(marks(state)[mark] ?? {}).length === 1, 10_000, "the mark after the card went out");
    await sleep(500);
    assert.equal(api.sends().length, before + 1, "one card per event");
  });
}
test("the quiet mark is saved only after the quiet card went out", async () => {
  await markAfterCard((state) => {
    const f = path.join(state, "session-01.jsonl");
    fs.writeFileSync(f, JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }) + "\n");
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(f, old, old);
  }, "quiet", /quiet for \d+ minutes/);
});
test("the effort mark is saved only after the effort card went out", async () => {
  await markAfterCard((state) => {
    fs.writeFileSync(path.join(state, "session-01.jsonl"), JSON.stringify({ type: "assistant", session_id: "s-1", perTurnEffort: "low", message: { model: "m", content: [] } }) + "\n");
  }, "effort", /is running at low/);
});

// The chain's last card is out and its line counted; a notified.json that cannot be written (here: a folder
// in its place) must not keep the watcher going, to send a false "died" card once the runner is gone.
test("the watcher ends after the chain's last card even when notified.json cannot be saved", async () => {
  await scene(() => undefined, {}, async ({ api, state, chain, exited, helper }) => {
    fs.mkdirSync(path.join(state, "notified.json"));
    chain("chain ends: STOP: done");
    const code = await Promise.race([exited, sleep(4_000).then(() => "still running")]);
    assert.notEqual(code, "still running");
    helper.kill();
    await sleep(300);
    assert.equal(api.sends().length, 1);
    assert.equal(fs.existsSync(path.join(state, "watch.pid")), false);
    assert.match(logOf(state), /notified\.json/);
  });
});

// During an outage each retry logs "ends" and then "transient error"; only the error is a card.
const OUTAGE = [
  "session 01 starts: x",
  "session 01 ends: success (error), 0 turns, $0.00",
  "session 01: transient error (API Error: 500); try 1, waiting until 2026-11-16 03:01",
  "session 01 resumes fake-1 after the error",
  "session 01 ends: success (error), 0 turns, $0.00",
  "session 01: transient error (API Error: 500); try 2, waiting until 2026-11-16 03:03",
  "session 01 resumes fake-1 after the error",
  "session 01 ends: success, 3 turns, $1.00",
  "session 02 left no continuation prompt; retrying with a recovery note",
];
test("an outage's retries make one error card and no session card until the session really ends", async () => {
  await scene(() => undefined, {}, async ({ api, state, chain }) => {
    fs.writeFileSync(path.join(state, "session-01.jsonl"), SESSION_DONE + "\n");
    for (const l of OUTAGE) chain(l);
    await until(() => api.sends().some((c) => /#02 left no continuation prompt/.test(c.body.text)), 10_000, "the last card");
    await sleep(300);
    const texts = api.sends().map((c) => c.body.text);
    assert.equal(texts.filter((t) => /connection or API error/.test(t)).length, 1, "the try 1 error card, none for try 2");
    assert.equal(texts.filter((t) => /<b>#01/.test(t)).length, 1, "one session card, for the final end");
    assert.equal(texts.filter((t) => /is going on where it left off/.test(t)).length, 2);
    await until(() => marks(state).lines === OUTAGE.length, 10_000, "every line marked (the mark follows Telegram's answer)");
  });
});
test("a session's end with no transient error behind it still gets its card", async () => {
  await scene(() => undefined, {}, async ({ api, state, chain }) => {
    fs.writeFileSync(path.join(state, "session-01.jsonl"), SESSION_DONE + "\n");
    for (const l of ["session 01 starts: x", "session 01 ends: success, 3 turns, $1.00", "session 02 starts: y"]) chain(l);
    await until(() => api.sends().length >= 1, 10_000, "the session card");
    await sleep(300);
    assert.equal(api.sends().length, 1);
    assert.match(api.sends()[0].body.text, /<b>#01/);
  });
});

// Test only: the error card's line, and the skip of a line no card can be made of.
test("the error card comes from try 1 only", async () => {
  await scene(() => undefined, {}, async ({ api, chain }) => {
    chain("session 01: transient error (API Error: 500); try 2, waiting until 2026-11-16 03:03");
    chain("session 01: transient error (API Error: 500); try 1, waiting until 2026-11-16 03:01");
    chain(RETRY);
    await until(() => api.sends().length >= 2, 10_000, "two cards");
    await sleep(300);
    assert.equal(api.sends().length, 2);
    assert.match(api.sends()[0].body.text, /#01 connection or API error · retrying at 03:01/);
    assert.match(api.sends()[1].body.text, /#02 left no continuation prompt/);
  });
});
test("a log line no card can be made of is skipped on the third try, and later lines still get theirs", async () => {
  // status.md as a folder makes say() throw (EISDIR) before it sends. Breaks if the skip goes: the line is then retried for ever.
  await scene(() => undefined, { env: { NIGHT_SHIFT_WATCH_RETRY_MS: "50" } }, async ({ api, state, chain }) => {
    fs.mkdirSync(path.join(state, "status.md"));
    chain(RETRY);
    await until(() => /skipped a line it could not make a card of/.test(logOf(state)), 10_000, "the skip in watch.log");
    assert.equal(api.sends().length, 0);
    fs.rmSync(path.join(state, "status.md"), { recursive: true });
    chain("session 03 left no continuation prompt; retrying with a recovery note");
    await until(() => api.sends().length >= 1, 10_000, "the later line's card");
    assert.match(api.sends()[0].body.text, /#03 left no continuation prompt/);
    await until(() => marks(state).lines === 2, 10_000, "both lines marked (the mark follows Telegram's answer)");
  });
});

test("a rules: line from the runner is sent as a card, not silent, in the run's language", async () => {
  await scene(() => undefined, { lang: "xx" }, async ({ api, state, chain }) => {
    chain("rules: C:/Users/demo-app/.claude/night-shift/rules.md is 9000 bytes, over the 8192 limit; the last text read stays in force");
    chain(RETRY);
    await until(() => api.sends().length >= 2, 10_000, "two cards");
    const [rules] = api.sends();
    assert.equal(rules.body.text, "⚠️ Rules file: C:/Users/demo-app/.claude/night-shift/rules.md is 9000 bytes, over the 8192 limit; the last text read stays in force");
    assert.notEqual(rules.body.disable_notification, true, "it makes a sound");
    assert.match(api.sends()[1].body.text, /#02 xx·retry/, "the run's table; the rules line, which it lacks, reads English");
    await until(() => marks(state).lines === 2, 10_000, "both lines marked (the mark follows Telegram's answer)");
  });
  await scene(() => undefined, { lang: "en" }, async ({ api, chain }) => {
    chain("rules: <b>x</b>.md is gone or empty; its rules no longer apply");
    await until(() => api.sends().length >= 1, 10_000, "the card");
    assert.equal(api.sends()[0].body.text, "⚠️ Rules file: &lt;b&gt;x&lt;/b&gt;.md is gone or empty; its rules no longer apply");
  });
});

// U16: with CLAUDE_CONFIG_DIR set, telegram.json and the user's language tables are read from that folder.
test("the watcher reads telegram.json and the language table from CLAUDE_CONFIG_DIR's folder", async () => {
  await scene(() => undefined, { lang: "xx", configDir: true, token: "CFG" }, async ({ api, chain }) => {
    chain(RETRY);
    await until(() => api.sends().length >= 1, 10_000, "the card");
    assert.ok(api.sends()[0].url.includes("/botCFG/"), "the token from that folder");
    assert.match(api.sends()[0].body.text, /#02 xx·retry/);
  });
});

// C3: an attended run's questions (<state>/questions.md) go out as they appear: each newline-ended Q line once, by its
// text, and the last session's before the chain's end card or the died line; an unattended run sends none.
const ask = (state, text) => fs.appendFileSync(path.join(state, "questions.md"), text);
const attendedRun = (state) => {
  const f = path.join(state, "run.json");
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), attended: true }));
};
const sentQuestions = (state) => { try { return JSON.parse(fs.readFileSync(path.join(state, "notified.json"), "utf8")).questions || []; } catch { return []; } };

test("an attended run's watcher sends each new question once, with a sound, and a half-written line only once it ends", async () => {
  await scene(() => undefined, {}, async ({ api, state }) => {
    attendedRun(state);
    ask(state, "Q1 · 10:12 · Push the branch? · yes: the suite passes · otherwise it stays local\n");
    await until(() => api.sends().length >= 1, 10_000, "the first question");
    assert.equal(api.sends()[0].body.text, "❓ repo asks · Q1 · 10:12 · Push the branch? · yes: the suite passes · otherwise it stays local");
    assert.equal(api.sends()[0].body.disable_notification, false);
    ask(state, "Q2 · 10:20 · Name the page <Export>?");
    await sleep(1500);
    assert.equal(api.sends().length, 1, "a line without its newline is still being written");
    ask(state, " · Export · otherwise Download\n");
    await until(() => api.sends().length >= 2, 10_000, "the second question");
    assert.equal(api.sends()[1].body.text, "❓ repo asks · Q2 · 10:20 · Name the page &lt;Export&gt;? · Export · otherwise Download");
    // A file rewritten without its first line neither hides a later question nor sends the rest again.
    fs.writeFileSync(path.join(state, "questions.md"), "Q2 · 10:20 · Name the page <Export>? · Export · otherwise Download\nQ3 · 10:30 · Merge? · no · otherwise merged\n");
    await until(() => api.sends().length >= 3, 10_000, "the third question");
    assert.match(api.sends()[2].body.text, /^❓ repo asks · Q3 · 10:30 · Merge\?/);
    await until(() => sentQuestions(state).length === 3, 5_000, "notified.json's questions");
    await sleep(1000);
    assert.equal(api.sends().length, 3);
  });
});

test("the last session's question goes out before the chain's end card", async () => {
  await scene(() => undefined, {}, async ({ api, state, chain, exited }) => {
    attendedRun(state);
    ask(state, "Q1 · 10:12 · Push? · yes · otherwise local\n");
    chain("chain ends: STOP: done");
    await exited;
    const texts = api.sends().map((s) => s.body.text);
    assert.equal(texts.length, 2, texts.join("\n---\n"));
    assert.match(texts[0], /^❓ repo asks · Q1 /);
  });
});

test("a question written as the runner dies still goes out, before the died line", async () => {
  await scene(() => undefined, {}, async ({ api, state, helper, exited }) => {
    attendedRun(state);
    // Written after the watcher saw the runner gone (it then waits 5 s): only the questions pass before died sends it.
    helper.kill();
    await sleep(1000);
    ask(state, "Q1 · 10:12 · Push? · yes · otherwise local\n");
    await exited;
    const texts = api.sends().map((s) => s.body.text);
    assert.equal(texts.length, 2, texts.join("\n---\n"));
    assert.match(texts[0], /^❓ repo asks · Q1 /);
    assert.match(texts[1], /stopped unexpectedly/);
  });
});

test("a question no card can be made of is skipped on its third try and holds no other card back", async () => {
  const table = "export default { ev: { question: () => { throw new Error(\"no card\"); } } };\n";
  await scene(() => undefined, { lang: "xx", table }, async ({ api, state, chain, exited }) => {
    attendedRun(state);
    ask(state, "Q1 · 10:12 · Push? · yes · otherwise local\n");
    const log = () => (fs.existsSync(path.join(state, "watch.log")) ? fs.readFileSync(path.join(state, "watch.log"), "utf8") : "");
    await until(() => /skipped a question it could not make a card of: no card/.test(log()), 10_000, "the skip in watch.log");
    chain("chain ends: STOP: done");
    await exited;
    assert.equal(api.sends().length, 1);
    assert.doesNotMatch(api.sends()[0].body.text, /❓/);
    assert.deepEqual(sentQuestions(state), ["Q1 · 10:12 · Push? · yes · otherwise local"]);
  });
});

test("an unattended run's watcher sends no question", async () => {
  await scene(() => undefined, {}, async ({ api, state, chain, exited }) => {
    ask(state, "Q1 · 10:12 · Push? · yes · otherwise local\n");
    chain("chain ends: STOP: done");
    await exited;
    assert.equal(api.sends().length, 1);
    assert.doesNotMatch(api.sends()[0].body.text, /❓/);
  });
});
