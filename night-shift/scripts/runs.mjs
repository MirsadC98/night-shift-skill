// Each repository's last run, and the one stop. The pointer, <Claude folder>/night-shift/runs/<repo>-<hash>.json, is
// how start, run, status, wait and stop find a repository's chain; stopRun is what `night-chain.mjs stop` and the bot's
// /stop both do. A module of its own so that the watcher (night-report.mjs) can stop a chain without importing
// night-chain.mjs, which imports night-report.mjs: in the watcher that module's top-level await is still pending, and
// the import would never settle.
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeHome } from "./config.mjs";
import { platform } from "./platform.mjs";

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
const now = () => new Date().toLocaleString("sv-SE");
const { alive, samePath: same } = platform;

// Also the name of the repository's scheduled task (night-chain.mjs, scheduleRun).
export const slug = (repo) => `${path.basename(repo)}-${crypto.createHash("sha1").update(repo.toLowerCase()).digest("hex").slice(0, 8)}`;
export const pointerFile = (repo, home = os.homedir()) => path.join(claudeHome(home), "night-shift", "runs", `${slug(repo)}.json`);
export const readPointer = (repo) => { const t = read(pointerFile(repo)); return t ? JSON.parse(t) : null; };
export const writePointer = (repo, data) => {
  fs.mkdirSync(path.dirname(pointerFile(repo)), { recursive: true });
  fs.writeFileSync(pointerFile(repo), JSON.stringify(data, null, 2));
};

// The command line of a process: "" when it is gone, null when it could not be asked.
export const commandLine = (pid) => {
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true });
  } catch { return null; }
};

// A live pid may belong to another program once the runner died without an end line (Windows
// reuses numbers): a runner is a live process whose command line names night-chain.mjs. Not knowing counts as one.
export const isRunner = (pid) => { if (!alive(pid)) return false; const line = commandLine(pid); return line === null || /night-chain\.mjs/i.test(line); };

// The one stop. It asks the runner to end after the session in progress (STOP-REQUEST, which the runner also reads
// during a limit wait), marks a run whose runner is gone finished, and with now kills the runner's process tree, the
// session in progress included. state: only the run in that folder (the watcher's own). via: where the stop came from,
// for the pointer's reason. Returns { outcome, pid }, outcome one of: none (no active run), never (its runner never
// started), gone (its runner was already gone), unsure (what the pid is could not be checked, so nothing was killed),
// now (killed), failed (the runner outlived the kill), after (it stops after the session in progress).
// before(outcome) is awaited right before the kill. The runner starts the watcher, so the watcher is in the tree and
// dies at the kill: it answers there. For the same reason the pointer is marked finished before the kill (the runner's
// heal leaves the mark alone once STOP-REQUEST exists) and once more after it, for a caller that outlives the kill.
export async function stopRun(repo, { now: hard = false, state = null, via = "", before = async () => {} } = {}) {
  const ptr = repo ? readPointer(repo) : null;
  if (!ptr || ptr.finished || (state && !(ptr.state && same(ptr.state, state)))) return { outcome: "none" };
  fs.writeFileSync(path.join(ptr.state, "STOP-REQUEST"), now());
  if (!isRunner(ptr.pid)) {
    const reason = ptr.pid ? "its runner was already gone" : "its runner never started";
    writePointer(repo, { ...ptr, finished: true, finishedAt: now(), reason });
    return { outcome: ptr.pid ? "gone" : "never", pid: ptr.pid };
  }
  if (!hard) return { outcome: "after", pid: ptr.pid };
  // A runner that died without an end line leaves its pid in the pointer, and Windows gives
  // the number to another program: only a process that still is a runner is killed.
  // Not knowing is no reason to kill, nor to call a live chain finished: STOP-REQUEST still ends it.
  if (commandLine(ptr.pid) === null) return { outcome: "unsure", pid: ptr.pid };
  // An answer that fails must not keep the chain from stopping.
  try { await before("now"); } catch {}
  // A pointer that cannot be written (a lock, a denied file) must not keep the chain from stopping either.
  const put = (data) => { try { writePointer(repo, data); } catch {} };
  const mark = () => put({ ...ptr, finished: true, finishedAt: now(), reason: `stopped now by the user${via ? ` ${via}` : ""}` });
  mark();
  try { execFileSync("taskkill", ["/T", "/F", "/PID", String(ptr.pid)], { stdio: "ignore", windowsHide: true }); } catch {}
  // A runner that lives on keeps its pointer as it was, so `start` never runs a second chain beside it. A killed
  // process may take a moment to be gone.
  for (let i = 0; i < 20 && alive(ptr.pid); i++) await new Promise((r) => setTimeout(r, 100));
  if (alive(ptr.pid)) { put(ptr); return { outcome: "failed", pid: ptr.pid }; }
  mark();
  return { outcome: "now", pid: ptr.pid };
}
