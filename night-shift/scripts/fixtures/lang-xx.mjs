// A made-up language for the tests, "xx": a table the user owns, as the scripts load it from
// ~/.claude/night-shift/lang/xx.mjs (a test copies it into its throwaway home). Its strings are
// plainly not English, so a test can tell which table a line came from. It leaves most keys out
// (they read English), and `pct` has the wrong kind (a string where English has a function).
export default {
  name: "Xxish",
  reportCommit: "xx·report",
  pct: "xx",
  waitsHead: "xx·waits",
  stateRunning: "xx·running",
  stateEnded: (why) => `xx·ended: ${why}`,
  ev: {
    start: (e) => `🌙 xx·start · ${e.project}`,
    retry: (e) => `🔁 #${e.nn} xx·retry`,
  },
  reportTitle: "xx·title",
  ended: (what) => `xx·ended: ${what}`,
  cmdStatus: "xxstatus", cmdStatusDesc: "xx·status",
  cmdReport: "xxreport", cmdReportDesc: "xx·report",
  cli: {
    userWaits: (lines) => (lines.length ? `xx·waits:\n${lines.join("\n")}` : "xx·waits: none"),
    reportLine: (report, cmd) => `xx·report: ${report} · ${cmd}`,
  },
};
