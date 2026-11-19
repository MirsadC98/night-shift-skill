// node --test night-shift/scripts/webhook.test.mjs
// The webhook notifier (C6): its file, the body each kind takes, the parts a long text goes in, and its outcomes,
// against a local stand-in on 127.0.0.1; no real ntfy, Slack or Discord.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { webhookConfig, plainText, textParts, postWebhook, sendWebhook } from "./webhook.mjs";
import { tempRoot } from "./config.mjs";
// A CLAUDE_CONFIG_DIR of the user's own would move the file sendWebhook reads (claudeHome in config.mjs).
delete process.env.CLAUDE_CONFIG_DIR;

// A stand-in receiver: answer(n) -> a status (200 when it gives none); keeps each request's path, headers and body.
async function receiver(answer = () => 200) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ url: req.url, method: req.method, headers: req.headers, raw });
      const status = answer(calls.length - 1) || 200;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status < 300 ? "ok" : "no");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

test("webhookConfig reads the kind from the URL when the file names none, and the file's own kind wins", () => {
  const kind = (o) => webhookConfig(JSON.stringify(o)).kind;
  assert.equal(kind({ url: "https://hooks.slack.com/services/T0/B0/x" }), "slack");
  assert.equal(kind({ url: "https://discord.com/api/webhooks/1/abc" }), "discord");
  assert.equal(kind({ url: "https://discordapp.com/api/webhooks/1/abc" }), "discord");
  assert.equal(kind({ url: "https://ptb.discord.com/api/webhooks/1/abc" }), "discord");
  assert.equal(kind({ url: "https://discord.com/channels/1/2" }), "ntfy", "not a webhook path");
  assert.equal(kind({ url: "https://ntfy.sh/a-topic" }), "ntfy");
  assert.equal(kind({ url: "https://example.org/hook" }), "ntfy", "any other URL takes plain text");
  assert.equal(kind({ url: "https://example.org/hook", kind: "discord" }), "discord");
  assert.equal(kind({ url: "https://example.org/hook", kind: "Slack" }), "slack", "case-blind");
  assert.equal(kind({ url: "https://HOOKS.SLACK.COM/services/T0/B0/x" }), "slack", "a host in capitals");
  const c = webhookConfig(JSON.stringify({ url: "https://ntfy.sh/a-topic" }));
  assert.equal(c.host, "ntfy.sh");
  assert.equal(c.error, undefined);
});

test("webhookConfig names what is wrong with a file, never the URL itself", () => {
  const secret = "s3cret-topic";
  const err = (text) => webhookConfig(text).error;
  assert.match(err("{"), /^webhook\.json: not JSON/);
  assert.match(err("[]"), /^webhook\.json: /);
  assert.match(err("{}"), /^webhook\.json: no url/);
  assert.match(err(JSON.stringify({ url: 42 })), /^webhook\.json: no url/);
  for (const url of [`http://[${secret}`, `not a url ${secret}`]) {
    assert.match(err(JSON.stringify({ url })), /^webhook\.json: the url does not parse/, url);
    assert.doesNotMatch(err(JSON.stringify({ url })), new RegExp(secret));
  }
  assert.match(err(JSON.stringify({ url: `ftp://example.org/${secret}` })), /^webhook\.json: the url must start with https:\/\/ or http:\/\//);
  assert.doesNotMatch(err(JSON.stringify({ url: `ftp://example.org/${secret}` })), new RegExp(secret));
  assert.match(err(JSON.stringify({ url: "https://ntfy.sh/x", kind: "teams" })), /^webhook\.json: kind must be ntfy, slack or discord/);
  for (const kind of ["constructor", "__proto__", "toString"]) assert.match(err(JSON.stringify({ url: "https://ntfy.sh/x", kind })), /^webhook\.json: kind must be/, kind);
  assert.match(err(JSON.stringify({ url: `https://u:p%zz${secret}@ntfy.sh/t` })), /^webhook\.json: the url's user name or password is not valid percent-encoding$/);
  // A file Windows PowerShell 5 or Notepad saved with a BOM still reads.
  assert.equal(webhookConfig(`\uFEFF${JSON.stringify({ url: "https://ntfy.sh/x" })}`).kind, "ntfy");
});

test("plainText drops the cards' tags and reads their entities back", () => {
  assert.equal(plainText("<b>#02</b> &lt;b&gt; &amp; <blockquote expandable>a\nb</blockquote><pre>c</pre>"), "#02 <b> & a\nbc");
  assert.equal(plainText("&amp;lt;"), "&lt;", "an escaped entity stays the text it was");
});

test("textParts splits at line ends within a limit, and cuts a line too long alone at its characters", () => {
  const len = (s) => s.length;
  assert.deepEqual(textParts("ab\ncd\nef", len, 5), ["ab\ncd", "ef"]);
  assert.deepEqual(textParts("abcdefgh", len, 3), ["abc", "def", "gh"]);
  assert.deepEqual(textParts("short", len, 2000), ["short"]);
  // ntfy counts UTF-8 bytes: ş is two, so four of them fill eight bytes.
  const bytes = (s) => Buffer.byteLength(s);
  assert.deepEqual(textParts("şşşşş", bytes, 8), ["şşşş", "ş"]);
  // A character is never halved, not even one of two UTF-16 units.
  assert.deepEqual(textParts("😀😀", len, 3), ["😀", "😀"]);
  for (const p of textParts(`${"x".repeat(1500)}\n${"y".repeat(1500)}\n${"z".repeat(4500)}`, len, 2000)) assert.ok(p.length <= 2000);
});

test("postWebhook sends ntfy the plain text, with a low priority for a silent card", async () => {
  const rx = await receiver();
  try {
    const cfg = webhookConfig(JSON.stringify({ url: `${rx.url}/s3cret-topic`, kind: "ntfy" }));
    assert.equal(await postWebhook(cfg, { text: "<b>#02</b> ends &amp; goes on", silent: true }), "sent");
    assert.equal(await postWebhook(cfg, { text: "<b>#03</b> ends" }), "sent");
    assert.equal(rx.calls.length, 2);
    assert.equal(rx.calls[0].method, "POST");
    assert.equal(rx.calls[0].url, "/s3cret-topic");
    assert.match(rx.calls[0].headers["content-type"], /^text\/plain; charset=utf-8$/);
    assert.equal(rx.calls[0].raw, "#02 ends & goes on");
    assert.equal(rx.calls[0].headers.priority, "low");
    assert.equal(rx.calls[1].headers.priority, undefined);
  } finally { await rx.close(); }
});

test("postWebhook sends Slack { text } with its control characters escaped, and Discord { content } that pings no one", async () => {
  const rx = await receiver();
  try {
    const card = { text: "⚠️ Rules file: a &lt;!channel&gt; &amp; @everyone", silent: true };
    assert.equal(await postWebhook(webhookConfig(JSON.stringify({ url: `${rx.url}/slack`, kind: "slack" })), card), "sent");
    assert.equal(await postWebhook(webhookConfig(JSON.stringify({ url: `${rx.url}/discord`, kind: "discord" })), card), "sent");
    assert.equal(await postWebhook(webhookConfig(JSON.stringify({ url: `${rx.url}/discord`, kind: "discord" })), { text: "loud" }), "sent");
    const [slack, discord, loud] = rx.calls;
    assert.match(slack.headers["content-type"], /^application\/json/);
    assert.deepEqual(JSON.parse(slack.raw), { text: "⚠️ Rules file: a &lt;!channel&gt; &amp; @everyone" });
    assert.deepEqual(JSON.parse(discord.raw), { content: "⚠️ Rules file: a <!channel> & @everyone", allowed_mentions: { parse: [] }, flags: 4096 });
    assert.deepEqual(JSON.parse(loud.raw), { content: "loud", allowed_mentions: { parse: [] } });
  } finally { await rx.close(); }
});

test("postWebhook sends a text over Discord's 2000 characters in parts, in order", async () => {
  const rx = await receiver();
  try {
    const text = [..."abc"].map((c) => c.repeat(1500)).join("\n");
    assert.equal(await postWebhook(webhookConfig(JSON.stringify({ url: `${rx.url}/d`, kind: "discord" })), { text, plain: true }), "sent");
    assert.deepEqual(rx.calls.map((c) => JSON.parse(c.raw).content), ["a".repeat(1500), "b".repeat(1500), "c".repeat(1500)]);
  } finally { await rx.close(); }
});

test("a retry of a card in parts starts at the first part not taken, so none goes twice", async () => {
  const rx = await receiver((n) => (n === 1 ? 429 : 200));
  try {
    const cfg = webhookConfig(JSON.stringify({ url: `${rx.url}/d`, kind: "discord" }));
    const text = [..."abc"].map((c) => c.repeat(1500)).join("\n"), done = { parts: 0 };
    assert.match(await postWebhook(cfg, { text, plain: true }, done), /^retry: webhook: 429/);
    assert.equal(done.parts, 1);
    assert.equal(await postWebhook(cfg, { text, plain: true }, done), "sent");
    assert.deepEqual(rx.calls.map((c) => JSON.parse(c.raw).content[0]), ["a", "b", "b", "c"]);
  } finally { await rx.close(); }
});

test("postWebhook's outcomes: busy or down is retry, any other refusal is for good, and none names the URL", async () => {
  const secret = "s3cret-topic";
  const statuses = [503, 429, 408, 404, 401, 301];
  const rx = await receiver((n) => statuses[n]);
  try {
    const cfg = webhookConfig(JSON.stringify({ url: `${rx.url}/${secret}?auth=tk`, kind: "ntfy" }));
    const got = [];
    for (let i = 0; i < statuses.length; i++) got.push(await postWebhook(cfg, { text: "x" }));
    assert.deepEqual(got.map((o) => o.replace(/ [A-Za-z ]+$/, "")), ["retry: webhook: 503", "retry: webhook: 429", "retry: webhook: 408", "webhook: 404", "webhook: 401", "webhook: 301"]);
    assert.equal(rx.calls.length, statuses.length, "a redirect is not followed");
  } finally { await rx.close(); }
  // Nothing listens there any more: the request throws, which is worth another try.
  const gone = webhookConfig(JSON.stringify({ url: `${rx.url}/${secret}`, kind: "ntfy" }));
  const outcome = await postWebhook(gone, { text: "x" });
  assert.match(outcome, /^retry: webhook: /);
  assert.doesNotMatch(outcome, new RegExp(secret));
});

test("Slack's parts are measured escaped, as Slack gets them, and an empty card posts nothing", async () => {
  const rx = await receiver();
  try {
    const cfg = webhookConfig(JSON.stringify({ url: `${rx.url}/s`, kind: "slack" }));
    const text = Array.from({ length: 3 }, () => "&".repeat(9000)).join("\n");
    assert.equal(await postWebhook(cfg, { text, plain: true }), "sent");
    const got = rx.calls.map((c) => JSON.parse(c.raw).text);
    assert.ok(got.length > 1);
    for (const t of got) assert.ok(t.length <= 40_000, t.length);
    assert.equal(got.join("").split("&amp;").length - 1, 27_000, "every & sent once, escaped");
    const before = rx.calls.length;
    assert.equal(await postWebhook(webhookConfig(JSON.stringify({ url: `${rx.url}/d`, kind: "discord" })), { text: "<b></b>\n" }), "sent");
    assert.equal(rx.calls.length, before);
  } finally { await rx.close(); }
});

test("sendWebhook reads webhook.json each time and answers with an outcome, never a throw", async () => {
  const dir = fs.mkdtempSync(path.join(tempRoot(), "ns-webhook-"));
  const file = path.join(dir, "night-shift", "webhook.json");
  fs.mkdirSync(path.dirname(file));
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.match(await sendWebhook([{ text: "x" }]), /^webhook\.json: cannot be read \(ENOENT\)$/);
    fs.writeFileSync(file, JSON.stringify({ url: "https://u:p%zz@ntfy.sh/t" }));
    assert.match(await sendWebhook([{ text: "x" }]), /^webhook\.json: the url's user name or password/);
    fs.writeFileSync(file, JSON.stringify({ url: "https://ntfy.sh/t", kind: "constructor" }));
    assert.match(await sendWebhook([{ text: "x" }]), /^webhook\.json: kind must be/);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a user name and password in the URL go as a Basic header, not in the request's URL", async () => {
  const rx = await receiver();
  try {
    const cfg = webhookConfig(JSON.stringify({ url: rx.url.replace("http://", "http://me:p%40ss@") + "/topic", kind: "ntfy" }));
    assert.equal(cfg.error, undefined);
    assert.equal(cfg.host, new URL(rx.url).host);
    assert.equal(await postWebhook(cfg, { text: "x" }), "sent");
    assert.equal(rx.calls[0].headers.authorization, `Basic ${Buffer.from("me:p@ss").toString("base64")}`);
    assert.equal(rx.calls[0].url, "/topic");
  } finally { await rx.close(); }
  // Nothing listens there any more: the outcome names neither the password nor the header made of it.
  const pw = "Pa55w0rd-x", gone = webhookConfig(JSON.stringify({ url: rx.url.replace("http://", `http://me:${pw}@`) + "/topic" }));
  const outcome = await postWebhook(gone, { text: "x" });
  assert.match(outcome, /^retry: webhook: /);
  for (const s of [pw, Buffer.from(`me:${pw}`).toString("base64"), "me:"]) assert.equal(outcome.includes(s), false, outcome);
});
