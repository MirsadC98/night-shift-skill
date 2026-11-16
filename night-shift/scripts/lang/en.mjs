// What the user reads, in English: the Telegram cards, the report that `show` and /report print, and
// the lines of `status` and `wait`. Same keys as tr.mjs, which holds the text the tool had first.
// The code around them (HTML tags, emoji, separators) is the same in both languages; a function
// takes already-escaped values.
const s = (n) => (n === 1 ? "" : "s");

export default {
  // units and number formats
  five: "5h", seven: "7d",
  pct: (n) => `${n}%`,
  minutes: (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`),
  ago: (t) => `${t} ago`,
  dayMonth: (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
  approxClock: (hhmm) => `~${hhmm}`,
  tomorrow: (clock) => `tomorrow ${clock}`,

  // progress line
  jobsDone: (done, total) => (total == null ? `${done} job${s(done)} done` : `${done}/${total} jobs done`),
  endsAt: (head, label) => `${head} · estimated end ${label}`,

  // headings and labels shared by the cards and the report
  waitsHead: "Waits for you",
  jobsHead: "Jobs",
  problemsHead: "Problems",
  noProblems: "No problems",
  noJobs: "no jobs yet",
  olderMore: (n) => `+ ${n} older item${s(n)}`,
  jobCount: (n) => `${n} job${s(n)}`,
  waitsLine: (n) => `${n} item${s(n)} waiting for you`,
  moreJobs: (n) => `… ${n} more job${s(n)}`,
  chainEnded: "Chain ended",
  jobRunning: "running",
  lastStep: "last step",
  lastDone: "Last finished",
  resetsAt: (t) => `resets at ${t}`,
  stopped: "Stopped",
  stateRunning: "running",
  stateStopped: "stopped",
  stateEnded: (why) => `ended: ${why}`,

  // one-line events
  ev: {
    start: (e) => `🌙 Night shift started · ${e.project}`,
    limit: (e) => `⏳ Usage limit reached · resumes at ${e.until}${e.progress ? ` · ${e.progress}` : ""}`,
    resume: (e) => `▶️ #${e.nn} is going on where it left off`,
    error: (e) => `🔌 #${e.nn} connection or API error · retrying at ${e.until}`,
    retry: (e) => `🔁 #${e.nn} left no continuation prompt, retrying`,
    quiet: (e) => `⚠️ #${e.nn} quiet for ${e.minutes} minutes · last step: ${e.step}`,
    died: () => "🛑 The chain stopped unexpectedly (the runner is gone)",
    effort: (e) => `⚠️ #${e.nn} is running at ${e.got} (should be ${e.want})`,
  },

  // problems, in the report and on the cards
  failed: "ended with an error",
  noResult: "ended without a result line",
  denied: (n) => `guard refused ${n} time${s(n)}`,
  quietFor: (t) => `quiet for ${t}`,
  limitWaited: (until) => `usage limit reached, waited until ${until}`,
  retriedTransient: (nn) => `#${nn} connection or API error, retried`,
  retriedNoPrompt: (nn) => `#${nn} wrote no continuation prompt, retried`,
  runnerGone: "The runner is not running and the chain did not say it ended (the window may have been closed or restarted)",
  effortOff: (got, want) => `level ${got} (should be ${want})`,
  // what the runner said about a session's model or handover
  note: {
    fableAsked: (why) => `asked for Fable, ran on Opus at max (${why})`,
    fableUntil: (t) => `Fable's share is used up until ${t}`,
    fableAt: (share, ceiling) => `Fable's share is ${share}, at the ${ceiling} ceiling`,
    fableCount: (n) => `the chain already ran ${n} Fable session${s(n)}, the share is unknown`,
    fableCut: "cut off because Fable's share ran out; the rest goes on Opus at max",
    fableNot: (why) => `did not run on Fable: ${why}`,
    bigPrompt: (kb) => `continuation prompt is ${kb} KB (over 30 KB; every call reads it again)`,
    badModel: (m) => `MODEL: ${m} not recognised, ran on Opus`,
  },

  // the full report (`show`, `status`, /report's source)
  reportTitle: "Night shift",
  ended: (what) => `Ended: ${what}`,
  runningLine: (r) => `Running · job ${r.nn}${r.max ? `/${r.max}` : ""}${r.until ? ` · until ${r.until}` : ""}${r.progress ? ` · ${r.progress}` : ""}`,
  gap: (t) => `+${t} idle`,
  nextUp: (next) => `Next: ${next}`,
  calls: (n) => `${n} call${s(n)}`,
  agents: (n) => `${n} agent${s(n)}`,
  tokenRow: (i, r, w, o) => `in ${i} read ${r} write ${w} out ${o}`,
  tokenHead: "Tokens",
  kinds: { ana: "main", alt: "sub", wf: "wf" },
  costWhenDone: "when the job ends",
  compactions: (n) => `compactions ${n}`,
  thinking: (t) => `thinking ${t}`,
  toolErrors: (n) => `tool errors ${n}`,
  workflows: (list) => `workflow: ${list}`,
  agentLater: "agent output completes when the job ends",
  otherLabel: "other",
  totalLabel: "total",
  limitLabel: "limit",
  nightTotal: (n) => `Night total · ${n} job${s(n)}`,
  atStart: "start",
  atEnd: "end  ",
  atNow: "now  ",
  resets: "resets",
  timelineHead: "Limit timeline",
  timelineNote: "(whole account)",
  commitsHead: "Commits",
  unpushed: (n) => `${n} not pushed`,
  moreCommits: (n) => `… ${n} more`,
  reportLabel: "Report",
  olderInReport: (n, nn) => `and ${n} older item${s(n)} (in #${nn}'s report)`,

  // Telegram commands: the name shown in the bot's menu and what it does
  cmdStatus: "status", cmdStatusDesc: "What is running now",
  cmdReport: "report", cmdReportDesc: "The full report",
  preview: "preview",
  silent: "silent",

  // `status` and `wait`
  cli: {
    noRun: "no night-shift run recorded for this repository",
    statusRunning: (pid, since) => `running (pid ${pid}) since ${since}`,
    statusFinished: (at, reason) => `finished ${at}: ${reason}`,
    statusScheduled: (at) => `scheduled ${at}, not running`,
    statusState: (state) => `state: ${state}`,
    notStartedYet: "the runner has not started yet; waiting",
    waiting: (pid, state) => `waiting: runner pid ${pid} (${state})`,
    handedOver: (from, to) => `runner handed over: pid ${from} → ${to}`,
    userWaits: (lines) => (lines.length ? `Waiting for the user:\n${lines.join("\n")}` : "Waiting for the user: no items listed"),
    reportLine: (report, cmd) => `Report: ${report} · full status: ${cmd}`,
    crashed: (why) => `the chain crashed: ${why}`,
    logTail: "end of chain.log:",
    resumeHint: (cmd) => `To go on if you want (without a prompt; the unfinished session continues in its own conversation): ${cmd}`,
    neverStarted: (min) => `the runner did not start in ${min} minutes (the Task Scheduler task did not run)`,
    handoverLost: (pid, min) => `runner ${pid} handed over but no new runner started in ${min} minutes`,
    diedNoEnd: (pid) => `runner (pid ${pid}) closed without writing an end line`,
  },
};
