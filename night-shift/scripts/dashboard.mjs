// The dashboard: a run's state folder turned into one data object (dashboard.json), a page that shows it (dashboard.html,
// from assets/dashboard.html) and a script-wrapped copy of the data the page reloads while the run is live
// (dashboard-data.js). No model call: everything is read from the files the runner and the sessions already write.
// The watcher (night-report.mjs) and the runner (night-chain.mjs) load this module with import(); both end in a
// top-level await when they are the entry module, so this module and everything it imports stay clear of both
// (run-read.mjs holds the readers they share).
import { when, LOG } from "./run-read.mjs";

const cut = (s, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const cents = (x) => Math.round(x * 100) / 100;
const stampOf = (at) => when(at).getTime();
// "5h 10%→20%" in a session's limits line (session-outcome.mjs, windowSpan); "?" for a window the stream did not report.
const span = (key, text) => {
  const m = new RegExp(`(?:^|· )${key} (\\?|\\d+)%?→(\\?|\\d+)%?`).exec(text);
  const num = (v) => (v === "?" ? null : Number(v));
  return m ? [num(m[1]), num(m[2])] : null;
};
const RESUME_WHY = [[/where the last runner stopped/, "stopped"], [/after the error/, "error"], [/after the usage limit/, "limit"]];

// ---------------------------------------------------------------- the log
// chain.log as sessions and their attempts, one pass. events: chainEvents' list ({ at, text }); since: epoch ms, the
// chain's start (run.json's chainStartedAt), before which no line is read. Each try of a session number is an attempt:
// start, resume (after a usage limit, an error or a runner that stopped) or retry (the number started again). An attempt
// that a new runner's "chain starts" finds open was cut off: its end is not known from the log.
export function readChain(events, { since = null } = {}) {
  const sessions = new Map(), out = [], limits = [];
  let started = null, firstLine = null, lastLine = null, endLine = null, wait = null, open = null;
  const session = (n) => {
    if (!sessions.has(n)) sessions.set(n, { n, title: null, model: null, effort: null, attempts: [] });
    return sessions.get(n);
  };
  const event = (t, kind, text) => out.push({ t, kind, text: cut(text) });
  const close = () => { if (open) Object.assign(open, { outcome: "cut", endKnown: false, end: null, usd: null }); open = null; };
  const attempt = (s, kind, t, why = null) => {
    close();
    open = { kind, why, start: t, end: null, endKnown: true, outcome: null, limitType: null, turns: null, usd: null, h5: null, d7: null, usdCum: null };
    s.attempts.push(open);
    return open;
  };
  for (const e of events) {
    const t = stampOf(e.at);
    if (!Number.isFinite(t) || (since != null && t < since)) continue;
    firstLine ??= t;
    lastLine = t;
    const text = e.text;
    let m;
    if (text.startsWith(LOG.chainStarts)) {
      close();
      started ??= t;
      endLine = null;
      event(t, /\(runner reloaded\)/.test(text) ? "reload" : "start", text);
    } else if ((m = LOG.starts.exec(text))) {
      const s = session(Number(m[1]));
      s.title ??= m[2];
      attempt(s, s.attempts.length ? "retry" : "start", t);
      wait = null;
    } else if ((m = LOG.resumes.exec(text))) {
      const s = session(Number(m[1]));
      attempt(s, "resume", t, RESUME_WHY.find(([re]) => re.test(text))?.[1] ?? null);
      wait = null;
      event(t, "resume", text);
    } else if ((m = /^session (\d+) runs (\S+)(?: \([^)]*\))? at (\w+)/.exec(text))) {
      const s = session(Number(m[1]));
      s.model = m[2];
      s.effort = m[3];
    } else if ((m = LOG.ends.exec(text)) && sessions.get(Number(m[1]))?.attempts.length) {
      const s = sessions.get(Number(m[1])), a = s.attempts.at(-1);
      const money = /, (\d+) turns?, \$([\d.]+)/.exec(m[2]);
      a.end = t;
      a.endKnown = true;
      // "success (error)" is a session the CLI ended in an error: not a success.
      a.outcome = /^success(?! \(error\))/.test(m[2]) ? "success" : "error";
      if (money) { a.turns = Number(money[1]); a.usdCum = Number(money[2]); }
      // A result's total carries the conversation's earlier parts, so a resume's dollars are the step up from the last
      // part that has a total; a number started again is a new conversation, whose total is its own.
      let before = 0;
      for (let j = s.attempts.length - 2; a.kind === "resume" && j >= 0; j--) {
        if (s.attempts[j].usdCum != null) { before = s.attempts[j].usdCum; break; }
        if (s.attempts[j].kind !== "resume") break;
      }
      a.usd = a.usdCum == null ? null : cents(a.usdCum - before);
      if (a === open) open = null;
    } else if ((m = /^session (\d+) limits: (.*?); it ran on \S+$/.exec(text)) && sessions.get(Number(m[1]))?.attempts.length) {
      const a = sessions.get(Number(m[1])).attempts.at(-1);
      a.h5 = span("5h", m[2]);
      a.d7 = span("7d", m[2]);
      if (a.h5 || a.d7) {
        limits.push({ t: a.start, h5: a.h5?.[0] ?? null, d7: a.d7?.[0] ?? null });
        limits.push({ t: a.end ?? t, h5: a.h5?.[1] ?? null, d7: a.d7?.[1] ?? null });
      }
    } else if ((m = /^session (\d+): (\w+) cut it off; limit record/.exec(text)) || (m = /^session (\d+): (\w+)'s allowance is used up/.exec(text))) {
      const a = sessions.get(Number(m[1]))?.attempts.at(-1);
      if (a) Object.assign(a, { outcome: "limit", limitType: /cut it off/.test(text) ? m[2] : m[2].toLowerCase() });
      event(t, "limit", text);
    } else if ((m = /^usage limit: waiting until (\S+ \S+)/.exec(text)) || (m = /^five-hour window at .*: the next session starts when it resets (\S+ \S+)/.exec(text))) {
      wait = { until: stampOf(m[1]), text };
      event(t, "limit", text);
    } else if (text.startsWith("runner reloads")) event(t, "reload", text);
    else if (text.startsWith(LOG.chainEnds)) {
      endLine = { t, reason: text.slice(LOG.chainEnds.length) };
      event(t, "end", text);
    } else event(t, "other", text);
  }
  return {
    started: started ?? since ?? firstLine,
    endLine,
    sessions: [...sessions.values()].sort((a, b) => a.n - b.n),
    events: out,
    limits,
    wait,
    lastLine,
  };
}
