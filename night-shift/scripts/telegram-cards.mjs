// Telegram messages for the night shift: a short card per event, with the details
// in one collapsed quote. The full report stays behind /rapor and `status`.
// Each function takes plain facts and returns { text, silent } (silent: no sound).

const LIMIT = 4096;
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const plain = (s) => String(s ?? "").replace(/\*\*|`/g, "").trim();
const mark = (ok) => (ok ? "✅" : "❌");

// Details as "<b>Name</b> · n" blocks inside one expandable quote, cut to fit the message.
function card(head, blocks, silent = false) {
  const top = head.filter(Boolean).join("\n");
  const body = blocks.filter((b) => b.lines.length)
    .map((b) => `<b>${b.name}</b>${b.count ? ` · ${b.lines.length}` : ""}\n${[...b.lines, ...(b.extra ? [b.extra] : [])].map(esc).join("\n")}`)
    .join("\n\n");
  if (!body) return { text: top, silent };
  const open = "\n<blockquote expandable>", close = "</blockquote>";
  let inner = body;
  if (top.length + open.length + inner.length + close.length > LIMIT) {
    inner = inner.slice(0, LIMIT - top.length - open.length - close.length - 2);
    inner = `${inner.slice(0, inner.lastIndexOf("\n"))}\n…`;
  }
  return { text: `${top}${open}${inner}${close}`, silent };
}

// Fable's share shows only once a Fable call of the night reported it.
const numbers = (f) => [f.took, f.cost, f.five && `5s ${f.five}`, f.seven && `7g ${f.seven}`, f.fable && `Fable ${f.fable}`].filter(Boolean).join(" · ");

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
export function progressText(p, now = new Date()) {
  if (!p) return null;
  const head = p.total == null ? `${p.done} iş bitti` : `${p.done}/${p.total} iş bitti`;
  if (!p.eta) return head;
  const eta = new Date(Math.round(p.eta.getTime() / FIVE_MIN) * FIVE_MIN);
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(eta) - day(now)) / 86_400_000);
  const clock = `~${eta.toLocaleTimeString("sv-SE").slice(0, 5)}`;
  const label = days === 0 ? clock : days === 1 ? `yarın ${clock}` : `${eta.toLocaleDateString("tr-TR").slice(0, 5)} ${clock}`;
  return `${head} · tahmini bitiş ${label}`;
}

export function sessionCard(f) {
  const title = f.title || f.commits?.[0]?.replace(/^\S+\s/, "");
  return card([
    `${mark(f.ok)} <b>#${f.nn}${title ? ` · ${esc(title)}` : ""}</b>`,
    numbers(f),
    f.progress && `📊 ${esc(f.progress)}`,
    f.next && `➡️ ${esc(f.next)}`,
    ...(f.problems || []).map((p) => `⚠️ ${esc(p)}`),
  ], [
    { name: "Seni bekleyen", count: true, lines: (f.waits || []).map((w) => `• ${w}`), extra: f.older ? `+ ${f.older} eski madde` : null },
  ]);
}

export function eventLine(kind, d = {}) {
  const lines = {
    start: [`🌙 Gece vardiyası başladı · ${esc(d.project)}`, true],
    limit: [`⏳ Limit doldu · ${esc(d.until)}'de sürer${d.progress ? ` · ${esc(d.progress)}` : ""}`, true],
    resume: [`▶️ #${d.nn} kaldığı yerden sürüyor`, true],
    retry: [`🔁 #${d.nn} devam istemi bırakmadı, yeniden deneniyor`, false],
    quiet: [`⚠️ #${d.nn} ${d.minutes} dakikadır sessiz · son adım: ${esc(d.step || "?")}`, false],
    died: ["🛑 Zincir beklenmedik şekilde durdu (runner kapandı)", false],
    effort: [`⚠️ #${d.nn} ${esc(d.got)} düzeyde çalışıyor (${esc(d.want)} olmalı)`, false],
  };
  const [text, silent] = lines[kind];
  return { text, silent };
}

export function chainCard(f) {
  return card([
    `🏁 <b>Zincir bitti · ${esc(f.project)}</b>`,
    esc(String(f.reason ?? "").replace(/^STOP:\s*/i, "")),
    [`${f.jobs.length} iş`, f.took, f.cost, f.seven && `7g ${f.seven}`, f.fable && `Fable ${f.fable}`].filter(Boolean).join(" · "),
    f.waits ? `🙋 Seni bekleyen ${f.waits} madde` : null,
  ], [
    { name: "Seni bekleyen", count: true, lines: (f.waitList || []).map((w) => `• ${w}`) },
    { name: "İşler", lines: f.jobs.map((j) => `${mark(j.ok)} #${j.nn}${j.title ? ` ${j.title}` : ""}${j.took ? ` · ${j.took}` : ""}`) },
    { name: "Sorunlar", count: true, lines: f.problems || [] },
  ]);
}

// /rapor: the run at a glance, shown open (the user asked for it). Problems arrive HTML-safe.
const REPORT_JOBS = 12;
export function reportCard(f) {
  const jobs = f.jobs || [];
  const line = (j) => (j.running
    ? `⏳ #${j.nn} sürüyor · ${j.took}${j.step ? ` · son adım: ${esc(j.step)}` : ""}`
    : `${mark(j.ok)} #${j.nn}${j.title ? ` ${esc(j.title)}` : ""} · ${j.took}`);
  const parts = [
    [`🌙 <b>${esc(f.project)}</b> · ${esc(f.state)} · ${f.at}`, f.progress && `📊 ${esc(f.progress)}`,
      [f.five && `5s ${f.five}`, f.seven && `7g ${f.seven}`, f.fable && `Fable ${f.fable}`, f.cost].filter(Boolean).join(" · ")].filter(Boolean).join("\n"),
    jobs.length && ["<b>İşler</b>", ...(jobs.length > REPORT_JOBS ? [`… ${jobs.length - REPORT_JOBS} iş daha`] : []), ...jobs.slice(-REPORT_JOBS).map(line)].join("\n"),
    f.problems?.length && ["<b>Sorunlar</b>", ...f.problems].join("\n"),
    f.waits?.length && [`<b>Seni bekleyen</b> · ${f.waits.length}`, ...f.waits.map((w) => `• ${esc(w)}`)].join("\n"),
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

export function statusCard(f) {
  return card([
    `🌙 <b>${esc(f.project)}</b> · ${f.running ? "çalışıyor" : esc(f.state || "durdu")}`,
    f.running && f.nn && `#${f.nn} · ${f.took}${f.effort ? ` · ${esc(f.effort)}` : ""}${f.step ? ` · son adım: ${esc(f.step)}` : ""}`,
    f.progress && `📊 ${esc(f.progress)}`,
    f.five && `5s ${f.five}${f.fiveReset ? ` (${f.fiveReset}'de sıfırlanır)` : ""} · 7g ${f.seven}${f.fable ? ` · Fable ${f.fable}` : ""}`,
    f.last &&`Son biten: ${mark(f.last.ok)} #${f.last.nn}${f.last.title ? ` ${esc(f.last.title)}` : ""}`,
    f.next && `➡️ ${esc(f.next)}`,
  ], [], true);
}

// The night report's section for one job: its heading names the session number and the
// time it started (run 1 and run 2 both have a "session 7"), "**Next:**" what follows.
export function reportSection(text, nn, hhmm) {
  const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
  const near = (a, b) => { const d = Math.abs(toMin(a) - toMin(b)); return Math.min(d, 1440 - d) <= 15; };
  const lines = String(text).split("\n");
  let found = null;
  lines.forEach((l, i) => {
    const m = /^## .*?\bsession (\d+) \((\d{2}:\d{2})[^)]*\) · (.+)$/.exec(l);
    if (m && Number(m[1]) === Number(nn) && near(m[2], hhmm)) found = { i, title: plain(m[3]) };
  });
  if (!found) return null;
  const end = lines.findIndex((l, i) => i > found.i && l.startsWith("## "));
  const body = lines.slice(found.i + 1, end < 0 ? lines.length : end);
  const nextLine = body.find((l) => l.startsWith("**Next:**"));
  const left = /^\*\*Remaining:\*\*\s*(\d+)/.exec(body.find((l) => l.startsWith("**Remaining:**")) || "");
  // Run 2's sections group what waits under "- New" and "- Still waiting …", the second carried
  // over from every earlier session, either as a heading over indented items ("- New:", then
  // "  - a") or one item a line ("- New: a"); "- New: none" is no item. Without the groups,
  // every item is this job's.
  const cut = (s) => (s.length > 100 ? `${s.slice(0, 99)}…` : s);
  const items = [];
  const at = body.findIndex((l) => /^\*\*Waits for you\*\*/.test(l));
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
