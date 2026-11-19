#!/usr/bin/env node
// Waits for a real thing: a file to appear, a line in a log, or a process to exit. It returns as soon
// as that happens and refuses to wait for something nothing will produce, so it cannot stand in for
// `sleep`. Run 6 lost 166 minutes in 89 calls to a helper that waited on `C:/nonexistent` as a timer.
const USAGE = `node wait-for.mjs <condition> [--timeout <s>]
  --pid <pid>                         until the process exits
  --file <path> [--match <regex>]     until the file exists (and holds a line matching <regex>);
                                      a missing file needs --pid of its writer
  --log <file> --match <regex>        until a line of the log matches; a missing log needs --pid
    [--fail <regex>]                  end with 1 at once when a line matches this instead
    [--new]                           only lines written after the wait starts
  --pid with --file or --log          end with 1 when that process exits first
  --timeout <s>                       default 540; keep a foreground call under 590 (the Bash tool's
                                      10-minute limit), or run it with run_in_background
In Git Bash, a background job's Windows pid is $(cat /proc/$!/winpid).
Exit: 0 ready, 1 not ready (timeout, a --fail line, the writer ended), 2 refused.`;

import fs from "node:fs";
import path from "node:path";
import { platform } from "./platform.mjs";

const POLL_MS = 250;
const refuse = (msg) => { console.error(`wait-for: ${msg}`); process.exit(2); };

function parse(argv) {
  const o = { timeout: 540, new: false };
  const takes = new Set(["--pid", "--file", "--log", "--match", "--fail", "--timeout"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { console.log(USAGE); process.exit(0); }
    if (a === "--new") { o.new = true; continue; }
    if (!takes.has(a)) refuse(`unknown argument ${a}\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined) refuse(`${a} needs a value`);
    o[a.slice(2)] = v;
  }
  return o;
}

// A process it may not signal still runs: a wait must not end early on one.
const alive = (pid) => platform.alive(pid, { denied: true });
const regex = (src, flag) => { try { return new RegExp(src); } catch (e) { refuse(`${flag} is not a valid regex: ${e.message}`); } };
const clip = (s) => (s.length > 200 ? `${s.slice(0, 200)}…` : s);

const o = parse(process.argv.slice(2));
if (!o.pid && !o.file && !o.log) refuse(`name what to wait for\n${USAGE}`);
if (o.file && o.log) refuse("--file and --log do not go together");
if (o.log && !o.match) refuse("--log needs --match");
if (o.fail && !o.log) refuse("--fail goes with --log");
const timeout = Number(o.timeout);
if (!(timeout > 0)) refuse("--timeout must be a positive number of seconds");
const pid = o.pid ? Number(o.pid) : null;
if (o.pid && !(Number.isInteger(pid) && pid > 0)) refuse(`--pid ${o.pid} is not a process id`);
if (pid && !alive(pid)) refuse(`process ${pid} does not run (in Git Bash, use $(cat /proc/$!/winpid), not $!)`);
const target = o.file || o.log;
const match = o.match ? regex(o.match, "--match") : null;
const fail = o.fail ? regex(o.fail, "--fail") : null;
if (target && !fs.existsSync(target)) {
  if (!pid) refuse(`${target} does not exist and nothing named would write it: pass --pid of its writer`);
  if (!fs.existsSync(path.dirname(path.resolve(target)))) refuse(`the folder of ${target} does not exist`);
}

const t0 = Date.now();
const secs = () => Math.round((Date.now() - t0) / 1000);
let offset = 0, carry = "";
const seen = [];
if (o.new && target && fs.existsSync(target)) offset = fs.statSync(target).size;

// New complete lines of the target since the last look (the whole file for --file without --new).
function newLines() {
  if (!fs.existsSync(target)) return null;
  const size = fs.statSync(target).size;
  if (size < offset) { offset = 0; carry = ""; } // rewritten from the start
  if (size === offset) return [];
  const fd = fs.openSync(target, "r");
  const buf = Buffer.alloc(size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  offset = size;
  const parts = (carry + buf.toString("utf8")).split(/\r?\n/);
  carry = parts.pop();
  for (const l of parts) { seen.push(l); if (seen.length > 5) seen.shift(); }
  return parts;
}

// Returns an exit code once the condition is settled, or null to keep waiting.
function look(final) {
  if (!target) return alive(pid) ? null : (console.log(`ready after ${secs()} s: process ${pid} exited`), 0);
  const lines = newLines();
  if (lines === null) return null;
  if (final && carry) { lines.push(carry); carry = ""; }
  if (o.file && !match) return console.log(`ready after ${secs()} s: ${target} exists`), 0;
  // The line still being written counts too: a result file often has no final newline.
  for (const l of carry ? [...lines, carry] : lines) {
    if (fail?.test(l)) return console.log(`failed after ${secs()} s: ${clip(l)}`), 1;
    if (match.test(l)) return console.log(`ready after ${secs()} s: ${clip(l)}`), 0;
  }
  return null;
}

function notReady(why) {
  console.log(`not ready: ${why} after ${secs()} s`);
  if (target && seen.length) console.log(`last lines of ${target}:\n${seen.map(clip).join("\n")}`);
  process.exit(1);
}

(function tick() {
  const writerGone = target && pid && !alive(pid);
  const code = look(writerGone);
  if (code !== null) process.exit(code);
  if (writerGone) notReady(`process ${pid} ended first`);
  if (Date.now() - t0 > timeout * 1000) notReady("timed out");
  setTimeout(tick, POLL_MS);
})();
