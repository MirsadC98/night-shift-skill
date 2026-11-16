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

const REPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), "night-report.mjs");
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
      calls.push({ method, body });
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
async function scene(answer, { chatId = 42, notified, env = {} } = {}, body) {
  const api = await bot(answer);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ns-watch-"));
  const home = path.join(dir, "home"), state = path.join(dir, "state"), root = path.join(dir, "repo");
  fs.mkdirSync(path.join(home, ".claude", "night-shift"), { recursive: true });
  fs.mkdirSync(state);
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(home, ".claude", "night-shift", "telegram.json"), JSON.stringify({ token: "T", chatId }));
  fs.writeFileSync(path.join(state, "run.json"), JSON.stringify({ repo: root }));
  fs.writeFileSync(path.join(state, "chain.log"), "");
  if (notified !== undefined) fs.writeFileSync(path.join(state, "notified.json"), notified);
  const helper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
  let watcher, code;
  let onExit;
  const exited = new Promise((r) => { onExit = r; });
  try {
    watcher = spawn(process.execPath, [REPORT, "watch", "--state", state, "--pid", String(helper.pid)], {
      stdio: "ignore", windowsHide: true,
      env: { ...process.env, USERPROFILE: home, HOME: home, NIGHT_SHIFT_TELEGRAM_API: api.url, NIGHT_SHIFT_SEND_RETRY_MS: "100", ...env },
    });
    watcher.on("exit", (c) => { code = c ?? -1; onExit(code); });
    const chain = (line) => fs.appendFileSync(path.join(state, "chain.log"), stamp(line));
    await body({ api, state, home, chain, exited, watcher, ended: () => code !== undefined });
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
    assert.match(api.sends().at(-1).body.text, /#02 devam istemi bırakmadı/);
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

test("a chat id saved as text still answers /durum", async () => {
  const ask = { ok: true, result: [{ update_id: 1, message: { chat: { id: 42 }, date: Math.floor(Date.now() / 1000), text: "/durum" } }] };
  await scene((m, b, n) => (m === "getUpdates" && n === 0 ? [200, ask] : m === "sendMessage" ? [200, { ok: true }] : undefined), { chatId: "42" }, async ({ api }) => {
    await until(() => api.sends().length >= 1, 10_000, "the /durum answer");
  });
});
