// Telegram messages for the night shift: a short card per event, with the details
// in one collapsed quote. The full report stays behind /rapor (/report) and `status`.
// Each function takes plain facts and the language table (lang/index.mjs; English when
// none is given) and returns { text, silent } (silent: no sound).

import { strings } from "./lang/index.mjs";

const LIMIT = 4096;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (s) => String(s ?? "").replace(/\*\*|`/g, "").trim();
const mark = (ok) => (ok ? "✅" : "❌");

// HTML helpers: Telegram rejects a message whose tag is left open or whose entity is cut in half.
const TAG = /<(\/?)([a-zA-Z][\w-]*)[^>]*>/g;
// The tags still open after s, given those open before it.
function openTags(s, stack = []) {
  const st = [...stack];
  for (const m of s.matchAll(TAG)) {
    if (!m[1]) st.push({ name: m[2], tag: m[0] });
    else { const i = st.findLastIndex((t) => t.name === m[2]); if (i >= 0) st.length = i; }
  }
  return st;
}
const closers = (st) => st.map((t) => `</${t.name}>`).reverse().join("");
const openers = (st) => st.map((t) => t.tag).join("");
// The length to cut s to, at most n, backed off out of a tag or an "&…;" entity.
function safeCut(s, n) {
  let head = s.slice(0, n);
  const lt = head.lastIndexOf("<");
  if (lt > head.lastIndexOf(">")) head = head.slice(0, lt);
  return head.length - (/&#?\w*$/.exec(head)?.[0].length ?? 0);
}
// s cut to fit max with "…", its open tags closed, so the result is valid HTML.
function trimHtml(s, max) {
  if (s.length <= max) return s;
  for (let n = max - 1; ; ) {
    const head = s.slice(0, safeCut(s, n));
    const tail = `…${closers(openTags(head))}`;
    const over = head.length + tail.length - max;
    if (over <= 0 || n <= 1) return head + tail;
    n -= over;
  }
}

// A long message as parts of at most max characters, each cut at a line end. A tag open at
// the cut (<pre>, <blockquote expandable>) is closed there and opened again in the next part.
// A line longer than max is cut hard, still outside a tag or an entity. A max below the
// length of the tags open at the cut is not supported.
export function splitHtml(html, max = 4000) {
  if (html.length <= max) return [html];
  const parts = [];
  let stack = [], head = "", text = "", started = false;
  const flush = () => {
    if (started) parts.push(head + text + closers(stack));
    head = openers(stack); text = ""; started = false;
  };
  for (const line of html.split("\n")) {
    let rest = line;
    while (true) {
      const joined = started ? `${text}\n${rest}` : rest;
      const after = openTags(rest, stack);
      if (head.length + joined.length + closers(after).length <= max) { text = joined; started = true; stack = after; break; }
      if (started) { flush(); continue; }
      let n = max - head.length - closers(stack).length, k, st;
      while (true) {
        k = safeCut(rest, n);
        if (k <= 0) k = Math.max(1, n);
        st = openTags(rest.slice(0, k), stack);
        const over = head.length + k + closers(st).length - max;
        if (over <= 0 || k <= 1) break;
        n = k - over;
      }
      text = rest.slice(0, k); started = true; stack = st;
      flush();
      rest = rest.slice(k);
      if (!rest) break;
    }
  }
  flush();
  return parts;
}

// Details as "<b>Name</b> · n" blocks inside one expandable quote, cut to fit the message.
function card(head, blocks, silent = false) {
  const top = head.filter(Boolean).join("\n");
  const body = blocks.filter((b) => b.lines.length)
    .map((b) => `<b>${b.name}</b>${b.count ? ` · ${b.lines.length}` : ""}\n${[...b.lines, ...(b.extra ? [b.extra] : [])].map(esc).join("\n")}`)
    .join("\n\n");
  if (!body) return { text: trimHtml(top, LIMIT), silent };
  const open = "\n<blockquote expandable>", close = "</blockquote>";
  let inner = body;
  if (top.length + open.length + inner.length + close.length > LIMIT) {
    // A cut at a line end is outside every tag and entity; a cut holding no line end (a head
    // that nearly fills the message) would leave half a tag, so the head goes alone then.
    const room = LIMIT - top.length - open.length - close.length - 2;
    const end = room > 0 ? inner.slice(0, room).lastIndexOf("\n") : -1;
    if (end <= 0) return { text: trimHtml(top, LIMIT), silent };
    inner = `${inner.slice(0, end)}\n…`;
  }
  return { text: `${top}${open}${inner}${close}`, silent };
}

// Fable's share shows only once a Fable call of the night reported it.
const numbers = (f, T) => [f.took, f.cost, f.five && `${T.five} ${f.five}`, f.seven && `${T.seven} ${f.seven}`, f.fable && `Fable ${f.fable}`].filter(Boolean).join(" · ");

// How far the chain is and when it should end. jobs: this run's jobs in order, each
// { ok, ended, workMs, remaining }, where remaining is its report's "**Remaining:**" count
// (null without the line). The last count, less the jobs finished well since, is what is
// left; a running job is one of them. The estimate adds the jobs left at this run's mean
// working time, the running one only for its rest, from now or from the end of a limit wait.
export function chainProgress(jobs, { now = new Date(), waitUntil = null } = {}) {
  const k = jobs.findLastIndex((j) => j.ended && j.remaining != null);
  const good = jobs.filter((j) => j.ended && j.ok);
  // Before any report has counted what remains: only the jobs done, once there is one.
  if (k < 0) return good.length ? { done: good.length, total: null, left: null, eta: null } : null;
  const running = jobs.findLast((j) => !j.ended);
  const left = Math.max(running ? 1 : 0, jobs[k].remaining - jobs.slice(k + 1).filter((j) => j.ended && j.ok).length);
  const mean = good.length ? good.reduce((a, j) => a + j.workMs, 0) / good.length : null;
  let eta = null;
  if (left && mean != null) {
    const base = Math.max(now.getTime(), waitUntil ? waitUntil.getTime() : 0);
    const rest = running ? Math.max(0, mean - running.workMs) : mean;
    eta = new Date(base + rest + (left - 1) * mean);
  }
  return { done: good.length, total: good.length + left, left, eta };
}

const FIVE_MIN = 5 * 60_000;
export function progressText(p, now = new Date(), T = strings()) {
  if (!p) return null;
  const head = T.jobsDone(p.done, p.total);
  if (!p.eta) return head;
  const eta = new Date(Math.round(p.eta.getTime() / FIVE_MIN) * FIVE_MIN);
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(eta) - day(now)) / 86_400_000);
  const clock = T.approxClock(eta.toLocaleTimeString("sv-SE").slice(0, 5));
  const label = days === 0 ? clock : days === 1 ? T.tomorrow(clock) : `${T.dayMonth(eta)} ${clock}`;
  return T.endsAt(head, label);
}

export function sessionCard(f, T = strings()) {
  const title = f.title || f.commits?.[0]?.replace(/^\S+\s/, "");
  return card([
    `${mark(f.ok)} <b>#${f.nn}${title ? ` · ${esc(title)}` : ""}</b>`,
    numbers(f, T),
    f.progress && `📊 ${esc(f.progress)}`,
    f.next && `➡️ ${esc(f.next)}`,
    ...(f.problems || []).map((p) => `⚠️ ${esc(p)}`),
  ], [
    { name: T.waitsHead, count: true, lines: (f.waits || []).map((w) => `• ${w}`), extra: f.older ? T.olderMore(f.older) : null },
  ]);
}

// Which events make no sound; the text of each is the table's.
const SILENT = { start: true, limit: true, resume: true, error: true, retry: false, quiet: false, died: false, effort: false };
export function eventLine(kind, d = {}, T = strings()) {
  const e = { ...d, project: esc(d.project), until: esc(d.until), progress: d.progress ? esc(d.progress) : "", step: esc(d.step || "?"), got: esc(d.got), want: esc(d.want) };
  return { text: T.ev[kind](e), silent: SILENT[kind] };
}

export function chainCard(f, T = strings()) {
  return card([
    `🏁 <b>${T.chainEnded} · ${esc(f.project)}</b>`,
    esc(String(f.reason ?? "").replace(/^STOP:\s*/i, "")),
    [T.jobCount(f.jobs.length), f.took, f.cost, f.seven && `${T.seven} ${f.seven}`, f.fable && `Fable ${f.fable}`].filter(Boolean).join(" · "),
    f.waits ? `🙋 ${T.waitsLine(f.waits)}` : null,
  ], [
    { name: T.waitsHead, count: true, lines: (f.waitList || []).map((w) => `• ${w}`) },
    { name: T.jobsHead, lines: f.jobs.map((j) => `${mark(j.ok)} #${j.nn}${j.title ? ` ${j.title}` : ""}${j.took ? ` · ${j.took}` : ""}`) },
    { name: T.problemsHead, count: true, lines: f.problems || [] },
  ]);
}

// /rapor (/report): the run at a glance, shown open (the user asked for it). Problems arrive HTML-safe.
const REPORT_JOBS = 12;
export function reportCard(f, T = strings()) {
  const jobs = f.jobs || [];
  const line = (j) => (j.running
    ? `⏳ #${j.nn} ${T.jobRunning} · ${j.took}${j.step ? ` · ${T.lastStep}: ${esc(j.step)}` : ""}`
    : `${mark(j.ok)} #${j.nn}${j.title ? ` ${esc(j.title)}` : ""} · ${j.took}`);
  const parts = [
    [`🌙 <b>${esc(f.project)}</b> · ${esc(f.state)} · ${f.at}`, f.progress && `📊 ${esc(f.progress)}`,
      [f.five && `${T.five} ${f.five}`, f.seven && `${T.seven} ${f.seven}`, f.fable && `Fable ${f.fable}`, f.cost].filter(Boolean).join(" · ")].filter(Boolean).join("\n"),
    jobs.length && [`<b>${T.jobsHead}</b>`, ...(jobs.length > REPORT_JOBS ? [T.moreJobs(jobs.length - REPORT_JOBS)] : []), ...jobs.slice(-REPORT_JOBS).map(line)].join("\n"),
    f.problems?.length && [`<b>${T.problemsHead}</b>`, ...f.problems].join("\n"),
    f.waits?.length && [`<b>${T.waitsHead}</b> · ${f.waits.length}`, ...f.waits.map((w) => `• ${esc(w)}`)].join("\n"),
  ].filter(Boolean);
  let text = parts.join("\n\n");
  if (text.length > LIMIT) text = `${text.slice(0, text.lastIndexOf("\n", LIMIT - 2))}\n…`;
  return { text, silent: true };
}

// "**Next:**" keeps its first clause, without code spans, commit hashes or a bracket left open.
function shortNext(s) {
  let t = String(s).replace(/`[^`]*`/g, "").replace(/\*\*/g, "")
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b(\.\.\S+)?/g, "").replace(/\s{2,}/g, " ").trim();
  t = t.split(/,\s|\.\s|\.$/)[0].trim();
  const open = t.lastIndexOf("(");
  if (open >= 0 && t.indexOf(")", open) < 0) t = t.slice(0, open).trim();
  return t;
}

export function statusCard(f, T = strings()) {
  return card([
    `🌙 <b>${esc(f.project)}</b> · ${f.running ? T.stateRunning : esc(f.state || T.stateStopped)}`,
    f.running && f.nn && `#${f.nn} · ${f.took}${f.effort ? ` · ${esc(f.effort)}` : ""}${f.step ? ` · ${T.lastStep}: ${esc(f.step)}` : ""}`,
    f.progress && `📊 ${esc(f.progress)}`,
    f.five && `${T.five} ${f.five}${f.fiveReset ? ` (${T.resetsAt(f.fiveReset)})` : ""} · ${T.seven} ${f.seven}${f.fable ? ` · Fable ${f.fable}` : ""}`,
    f.last && `${T.lastDone}: ${mark(f.last.ok)} #${f.last.nn}${f.last.title ? ` ${esc(f.last.title)}` : ""}`,
    f.next && `➡️ ${esc(f.next)}`,
  ], [], true);
}

// The night report's section for one job: its heading names the session number and the
// time it started (run 1 and run 2 both have a "session 7"), "**Next:**" what follows.
export function reportSection(text, nn, hhmm) {
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const near = (a, b) => { const d = Math.abs(toMin(a) - toMin(b)); return Math.min(d, 1440 - d) <= 15; };
  const lines = String(text).split(/\r?\n/);
  let found = null;
  lines.forEach((l, i) => {
    const m = /^## .*?\bsession (\d+) \((\d{2}:\d{2})[^)]*\) · (.+)$/.exec(l);
    if (m && Number(m[1]) === Number(nn) && near(m[2], hhmm)) found = { i, title: plain(m[3]) };
  });
  if (!found) return null;
  const end = lines.findIndex((l, i) => i > found.i && l.startsWith("## "));
  const body = lines.slice(found.i + 1, end < 0 ? lines.length : end);
  const nextLine = body.find((l) => l.startsWith("**Next:**"));
  const left = body.map((l) => /^\*\*Remaining(?::\*\*|\*\*:)\s*~?\s*(\d+)/.exec(l)).find(Boolean);
  // Run 2's sections group what waits under "- New" and "- Still waiting …", the second carried
  // over from every earlier session, either as a heading over indented items ("- New:", then
  // "  - a") or one item a line ("- New: a"); "- New: none" is no item. Without the groups,
  // every item is this job's.
  const cut = (s) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);
  const items = [];
  const at = body.findIndex((l) => /^\*\*Waits for you(?::\*\*|\*\*:?)/.test(l));
  for (const l of at < 0 ? [] : body.slice(at + 1)) {
    if (l.startsWith("**")) break;
    const m = /^(\s*)(?:[-*] |\d+\. )(.*)$/.exec(l);
    if (!m) continue;
    const full = plain(m[2]).replace(/[;.]$/, "");
    if (m[1]) { items.at(-1)?.children.push(cut(full)); continue; }
    // A heading's word may carry "(…)", ", …" or "from …" before its colon; "New icon set: x" is an item.
    let g = /^(new|still waiting)\b([^:]*)(?::\s*|$)/i.exec(full);
    if (g && g[2].trim() && !/^\s*(?:\(|,|from\b)/i.test(g[2])) g = null;
    const rest = g ? full.slice(g[0].length) : "";
    items.push({ group: g?.[1].toLowerCase(), text: cut(full), children: rest && !/^none\b/i.test(rest) ? [cut(rest)] : [] });
  }
  const fresh = items.filter((i) => i.group === "new");
  const carried = items.filter((i) => i.group === "still waiting");
  return {
    title: found.title,
    next: nextLine ? shortNext(nextLine.slice(9)) : null,
    remaining: left ? Number(left[1]) : null,
    waits: fresh.length ? fresh.flatMap((i) => i.children) : carried.length ? [] : items.map((i) => i.text),
    older: carried.reduce((a, i) => a + i.children.length, 0),
  };
}
