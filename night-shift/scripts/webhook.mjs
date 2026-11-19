// night-shift's webhook (C6, 2026-11-19): every card the watcher sends, also posted to one URL kept in
// <claude home>/night-shift/webhook.json beside telegram.json, as { "url": …, "kind": "ntfy" | "slack" | "discord" }.
// ntfy gets the card's plain text as the body, Slack { text }, Discord { content }. One-way: the bot's commands stay
// Telegram's. The URL is the secret (an ntfy topic anyone can read, a Slack or Discord token in its path): no outcome,
// log line or card names it, only its kind and host.
import fs from "node:fs";
import path from "node:path";
import { claudeHome } from "./config.mjs";

// A function: the runner sets CLAUDE_CONFIG_DIR from run.json after this module has loaded (claudeHome).
export const webhookFile = () => path.join(claudeHome(), "night-shift", "webhook.json");

// The cards are Telegram's HTML: their tags dropped and the three entities esc() writes read back (&amp; last, so that
// an escaped "&lt;" stays that text).
export const plainText = (html) => String(html).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The parts a text goes in, each at most max by size (characters or UTF-8 bytes, both a sum over the characters):
// split at line ends, and a line too long alone at its characters, never halving one.
export function textParts(text, size, max) {
  const out = [];
  let cur = null, n = 0;
  for (const line of String(text).split("\n")) {
    const s = size(line);
    if (cur !== null && n + 1 + s <= max) { cur += `\n${line}`; n += 1 + s; continue; }
    if (cur !== null) out.push(cur);
    cur = ""; n = 0;
    for (const ch of line) {
      const c = size(ch);
      if (n + c > max && cur) { out.push(cur); cur = ""; n = 0; }
      cur += ch; n += c;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

const chars = (s) => s.length, bytes = (s) => Buffer.byteLength(s);
const slackText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// What each kind takes. silent: a card Telegram sends with no sound.
const KINDS = {
  // ntfy.sh's message limit is 4,096 bytes; Priority low makes no sound or vibration.
  ntfy: { size: bytes, max: 4096, request: (text, silent) => ({ headers: { "content-type": "text/plain; charset=utf-8", ...(silent ? { priority: "low" } : {}) }, body: text }) },
  // Slack reads & < > as its control characters (<!channel> is a mention); it cuts a text at 40,000 characters, counted
  // as it gets them, escaped.
  slack: { size: (s) => slackText(s).length, max: 40_000, request: (text) => json({ text: slackText(text) }) },
  // Discord caps content at 2,000 characters; no mention pings anyone, and flag 4096 suppresses the notification.
  discord: { size: chars, max: 2000, request: (text, silent) => json({ content: text, allowed_mentions: { parse: [] }, ...(silent ? { flags: 4096 } : {}) }) },
};
const json = (o) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

const DISCORD = /^(?:[a-z0-9-]+\.)?discord(?:app)?\.com$/;
const kindOf = (u) => (u.hostname === "hooks.slack.com" ? "slack" : DISCORD.test(u.hostname) && u.pathname.startsWith("/api/webhooks/") ? "discord" : "ntfy");

// webhook.json's text -> { url, kind, host, auth, hide } or { error }. An error names the problem, never the URL.
// hide: the spellings of the secret an error message might hold, replaced before anything is logged.
export function webhookConfig(text) {
  let j;
  try { j = JSON.parse(String(text).replace(/^\uFEFF/, "")); } catch { return { error: "webhook.json: not JSON" }; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { error: "webhook.json: not a JSON object" };
  if (typeof j.url !== "string" || !j.url.trim()) return { error: "webhook.json: no url" };
  const raw = j.url.trim();
  let u;
  try { u = new URL(raw); } catch { return { error: "webhook.json: the url does not parse" }; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "webhook.json: the url must start with https:// or http://" };
  const kind = j.kind == null ? kindOf(u) : String(j.kind).toLowerCase();
  if (!Object.hasOwn(KINDS, kind)) return { error: "webhook.json: kind must be ntfy, slack or discord" };
  // fetch refuses a URL that holds a user name or password: they go as a Basic header, the way curl sends them.
  let auth = null;
  if (u.username || u.password) {
    try { auth = `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}`; }
    catch { return { error: "webhook.json: the url's user name or password is not valid percent-encoding" }; }
    u.username = ""; u.password = "";
  }
  const hide = [raw, u.href, `${u.pathname}${u.search}`, u.search, u.pathname].filter((s) => s.length > 1);
  return { url: u.href, kind, host: u.host, auth, hide };
}

const scrub = (cfg, s) => cfg.hide.reduce((t, h) => t.split(h).join("<webhook>"), String(s));

// Posts the messages' parts in order, from the first one done.parts does not count yet, and counts each one taken, so
// that a retry of the same messages with the same done sends no part twice. Outcomes, as night-report.mjs's send():
// "sent"; "retry: webhook: …" when the request threw or passed its timeout, or the answer was 408, 429 or 5xx; "webhook:
// <status> <text>" for any other answer, refused for good. Redirects are not followed (fetch would by default).
export async function postWebhook(cfg, messages, done = { parts: 0 }, { timeoutMs = 10_000 } = {}) {
  const kind = KINDS[cfg.kind];
  const parts = [].concat(messages).flatMap((m) => {
    const { text, silent = false, plain = false } = typeof m === "string" ? { text: m } : m;
    return textParts((plain ? String(text) : plainText(text)).trim(), kind.size, kind.max).filter((p) => p.trim()).map((p) => ({ text: p, silent }));
  });
  for (let i = done.parts || 0; i < parts.length; i++) {
    const { headers, body } = kind.request(parts[i].text, parts[i].silent);
    let r;
    try {
      r = await fetch(cfg.url, { method: "POST", headers: { ...headers, ...(cfg.auth ? { authorization: cfg.auth } : {}) }, body, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return `retry: webhook: ${scrub(cfg, `${e.message}${e.cause?.message ? `: ${e.cause.message}` : ""}`)}`;
    }
    // The answer's body is never read into a log (it may echo the request); it is let go so the connection can close.
    try { await r.body?.cancel(); } catch {}
    if (r.status < 200 || r.status > 299) {
      const said = scrub(cfg, `${r.status}${r.statusText ? ` ${r.statusText}` : ""}`);
      return `${r.status === 408 || r.status === 429 || r.status >= 500 ? "retry: " : ""}webhook: ${said}`;
    }
    done.parts = i + 1;
  }
  return "sent";
}

// The watcher's, notify's and card --send's way in: webhook.json read now (a change needs no restart), then the post.
// It never rejects: a throw the checks did not foresee would end notify, or make the watcher send the card again to
// Telegram, so it is an outcome refused for good, named without the URL.
export async function sendWebhook(messages, done) {
  let cfg = null;
  try {
    let text;
    try { text = fs.readFileSync(webhookFile(), "utf8"); } catch (e) { return `webhook.json: cannot be read (${e.code || e.message})`; }
    cfg = webhookConfig(text);
    return cfg.error || await postWebhook(cfg, messages, done);
  } catch (e) {
    return `webhook: ${cfg?.hide ? scrub(cfg, e.message) : e.name}`;
  }
}
