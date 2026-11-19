// What the user reads, in English: the Telegram cards, the report that `show` and /report print, and
// the lines of `status` and `wait`. Every other language is a table the user owns, with these keys
// (lang/index.mjs); a key it lacks reads the text here. The code around the strings (HTML tags, emoji,
// separators) is the same in every language; a function takes already-escaped values.
const s = (n) => (n === 1 ? "" : "s");

export default {
  // the language's English name, for the header line "The user reads …" of every night session
  name: "English",
  // the phrase that marks a night-report commit (`docs: night report …`), left out of a job's commits
  reportCommit: "night report",

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
    rules: (e) => `⚠️ Rules file: ${e.text}`,
    // an attended run's question, the session's own line from questions.md (Q<n> · time · question · pick · otherwise)
    question: (e) => `❓ ${e.project} asks · ${e.text}`,
  },

  // problems, in the report and on the cards
  failed: "ended with an error",
  noResult: "ended without a result line",
  denied: (n) => `guard refused ${n} time${s(n)}`,
  // a finished job's night-report section the cards cannot read; `words` are the skill's fixed words, kept as they are
  noSection: "no night-report section names this job, so its card has no title, waits or count",
  sectionLacks: (words) => `its night-report section lacks ${words.join(" and ")}, so its card shows no waits or count from it`,
  quietFor: (t) => `quiet for ${t}`,
  limitWaited: (until) => `usage limit reached, waited until ${until}`,
  retriedTransient: (nn) => `#${nn} connection or API error, retried`,
  retriedNoPrompt: (nn) => `#${nn} wrote no continuation prompt, retried`,
  runnerGone: "The runner is not running and the chain did not say it ended (the window may have been closed or restarted)",
  effortOff: (got, want) => `level ${got} (should be ${want})`,
  // what the runner said about a session's model or handover. `model` is the name of the model in play
  // (Fable or Mythos, which share one weekly allowance): the one a session asked for or the run's main model.
  note: {
    fableAsked: (why, model) => `asked for ${model}, ran on Opus at max (${why})`,
    fableUntil: (t, model) => `${model}'s share is used up until ${t}`,
    fableAt: (share, ceiling, model) => `${model}'s share is ${share}, at the ${ceiling} ceiling`,
    fableCount: (n, model) => `the chain already ran ${n} session${s(n)} on ${model}'s allowance, the share is unknown`,
    cannotRunWhy: (model) => `this account cannot run ${model}, found earlier in this chain`,
    cannotRun: (model, family) => `this account cannot run ${model}; MODEL: ${family} runs on Opus at max for the rest of the chain`,
    fableCut: (model) => `cut off because ${model}'s share ran out; the rest goes on Opus at max`,
    mainFell: (why, level, model) => `${model} is the main model, but ran on Opus at ${level} (${why})`,
    mainCut: (model) => `cut off because ${model}'s share ran out; the rest goes on Opus at xhigh`,
    fableNot: (why, model) => `did not run on ${model}: ${why}`,
    bigPrompt: (kb, over = "30", tokens = null) => `continuation prompt is ${kb} KB (over ${over} KB; every call reads it again${tokens ? `, about ${tokens}k tokens each` : ""})`,
    fieldGone: (field) => `stream field ${field} stopped arriving (the CLI may have renamed it); chain.log says what it blinds`,
    ceilingBlind: "the CLI's stream has no seven-day window, so the weekly ceiling stops no session",
    badModel: (m) => `MODEL: ${m} not recognised, ran on Opus`,
    badModelFable: (m, model) => `MODEL: ${m} not recognised, ran on ${model}`,
    // ran: the model the session ran on, Opus when the gate moved it to the stand-in.
    sameModel: (asked, model, ran = model) => `MODEL: ${asked} is ${model} under another name, ran on ${ran}`,
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
  // the context a job's first call read, and the mean of the jobs that made one
  startTokens: (t) => `start ${t}`,
  meanStart: (t, n) => `mean start ${t} over ${n} job${s(n)}`,
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

  // Telegram commands: the name shown in the bot's menu and what it does; the bot answers that name
  // besides /status and /report
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
