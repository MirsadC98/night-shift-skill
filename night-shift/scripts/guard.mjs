#!/usr/bin/env node
// night-shift guard: a PreToolUse hook for unattended runs. It denies the
// mechanical cases of what no one may approve at night (history rewrites,
// merges, publishing, deleting outside the repo and temp, touching the live
// system, editing the run's own rules). Everything else falls through to the
// session's permission mode. It is loaded only through the settings file the
// runner passes with --settings, so daytime sessions never see it.
//
// Input: the hook JSON on stdin. Output: a deny decision, or nothing.
// Self-test: node guard.mjs --self-test; tests: node --test guard.test.mjs

import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readProjectConfig, stateDirProblem, tempRoot, isMain, mcpToolName } from "./config.mjs";
import { platform as live, platformFor } from "./platform.mjs";

// The system whose path rules a call is judged by (platform.mjs): the live one, or the one a test hands decide() in
// opts.platform. decide() sets it for the call and puts it back after; it runs synchronously, so no other call sees it.
let P = live;
const norm = (p) => P.norm(p);
const isAbsolute = (t) => P.isAbsolute(t);

const under = (p, root) => root && (p === root || p.startsWith(root + "/"));

// What the runner keeps in the state folder: the settings file that loads this guard, the file
// that names the program each session starts, its own logs and marks, the caps' count (limits.json),
// what the user's waiter has reported (wait.json) and the user's stop (STOP-REQUEST). In any case: Windows and macOS
// fold the path, and on Linux the runner's STOP-REQUEST and RELOAD-REQUEST keep their capitals.
const RUNNER_FILES = /^(night-settings\.json|run\.json|launch\.cmd|runner\.err|resume\.json|chain\.log|reload-request|watch\.pid|notified\.json|fable\.json|limits\.json|wait\.json|stop-request|session-\d+\.(jsonl|err))$/i;

// ~/.claude may be a link (a junction to a folder elsewhere): a shell write can then name the files the
// guard protects there by the link's target, a spelling norm() cannot know (on 2026-11-18 `echo x >
// <target>/settings.json` passed). Each spelling of the folder, the home one first.
// The home as the file system resolves it (platform.mjs: on Windows an MSYS drive is a drive path), not norm()'s.
const fsHome = (h) => P.fsHome(h);
// A folder named by CLAUDE_CONFIG_DIR is where Claude Code keeps them instead: one more spelling (with its own
// link's target), so it is protected as ~/.claude is, and ~/.claude stays protected too.
function claudeSpellings(home, configDir) {
  const c = `${norm(home)}/.claude`;
  const out = [c];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  const real = (dir) => { try { add(norm(P.realpath(dir))); } catch { /* no such folder */ } };
  real(P.path.join(fsHome(home), ".claude"));
  if (configDir) { add(norm(P.path.resolve(configDir))); real(P.path.resolve(configDir)); }
  return out;
}
// p, and p under each other spelling of ~/.claude when it lies under one of them.
const spellings = (p, r) => {
  const out = [p];
  for (const from of r.claude) if (under(p, from)) for (const to of r.claude) if (to !== from) out.push(to + p.slice(from.length));
  return out;
};

// A folder an environment variable names, in each spelling: as given (a relative one from the hook's folder) and as the
// file system resolves a link. None when it is a drive, or is or holds one of the places in wide (the home, a temp
// root, the repository, the state folder): protecting it would make that whole place unwritable, as a state folder
// that wide is no writable root (roots below).
function namedFolder(value, wide) {
  if (!value) return [];
  // A drive-relative D:x is relative too (to that drive's folder), as resolve() reads it; off Windows only / starts a path.
  const raw = String(value).trim().replace(/^["']|["']$/g, ""), given = norm(raw);
  const out = [(P.name === "win32" ? /^([a-z]:(\/|$)|\/)/.test(given) : given.startsWith("/")) ? given : norm(P.path.resolve(raw))];
  try { const real = norm(P.realpath(P.path.resolve(fsHome(raw)))); if (!out.includes(real)) out.push(real); } catch { /* no such folder */ }
  const drive = (d) => !d.replace(/^\/\/[^/]*(\/[^/]*)?|^[a-z]:/, "").split("/").some(Boolean);
  return out.some((d) => drive(d) || wide.some((w) => under(w, d))) ? [] : out;
}
// What Claude Code keeps of its installed plugins in a plugins folder: their copies, the marketplaces' clones and the
// two lists of what is installed. Their hooks and servers run in the user's own sessions; data/ is the plugins' own.
const PLUGIN_PARTS = ["cache", "marketplaces", "installed_plugins.json", "known_marketplaces.json"];

function roots(env) {
  const home = norm(P.home(env));
  const repo = norm(env.NIGHT_SHIFT_REPO || "");
  // A state folder that is a drive, the home folder or the like (a typo in stateDir) would make
  // all of it writable: it adds nothing, and the runner refuses to start with one.
  const state = env.NIGHT_SHIFT_STATE && !stateDirProblem(env.NIGHT_SHIFT_STATE, { home, repo, temp: P.tempRoot(), env, platform: P }) ? norm(env.NIGHT_SHIFT_STATE) : "";
  const wide = [home, ...P.tempRoots(home), repo, state].filter(Boolean);
  // The copy of the skill the run started from (the runner puts NIGHT_SHIFT_SKILL into every session's environment),
  // wherever it is, unless the repository holds it: a chain may develop the skill in its own clone.
  const skill = namedFolder(env.NIGHT_SHIFT_SKILL, wide);
  return {
    repo,
    state,
    // Besides these, the system's temp folders (platform.mjs).
    writable: [repo, state, ...P.tempRoots(home)].filter(Boolean),
    home,
    claude: claudeSpellings(P.home(env), env.CLAUDE_CONFIG_DIR),
    skill: repo && skill.some((d) => under(d, repo)) ? [] : skill,
    // Claude Code's plugins folders: ~/.claude's under each of its spellings (spellings() maps them to the home's one),
    // and the one CLAUDE_CODE_PLUGIN_CACHE_DIR names, which adds to it.
    plugins: [`${home}/.claude/plugins`, ...namedFolder(env.CLAUDE_CODE_PLUGIN_CACHE_DIR, wide)],
  };
}

// A path that names a file the rules below never named, by a stream or a short name (platform.mjs), is refused
// outright rather than resolved. p is already normalized.
export const oddPath = (p) => P.oddPath(p);
// PowerShell's own drives (Env:FOO, Alias:ll) are no files: the colon after their name is not a stream.
const PS_DRIVE = /^(env|alias|variable|function):(?!:)/i;
const oddReason = (p, shown) => {
  const drive = PS_DRIVE.exec(String(shown));
  const what = drive ? oddPath(norm(String(shown).slice(drive[0].length))) : oddPath(p);
  return what && `refusing a path with ${what} (${shown}): the guard cannot tell which file it is`;
};

// Paths a night session may never write, even inside writable roots, under any spelling of ~/.claude.
function protectedPath(p, r) {
  for (const s of spellings(p, r)) { const why = protectedSpelling(s, r); if (why) return why; }
  return null;
}
function protectedSpelling(p, r) {
  if (under(p, `${r.home}/.claude/skills/night-shift`) || r.skill.some((s) => under(p, s))) return "the night-shift skill itself";
  if (r.plugins.some((root) => PLUGIN_PARTS.some((f) => under(p, `${root}/${f}`)))) return "Claude Code's installed plugins";
  if (/^.*\/\.claude\/settings(\.local)?\.json$/.test(p)) return "Claude settings";
  if (p === norm(`${r.home}/.claude/CLAUDE.md`)) return "the user's global CLAUDE.md";
  // Config, rules and run state the user steers the night with. Before the repo roots: with the repo at ~/.claude they sit inside a writable root.
  if (under(p, `${r.home}/.claude/night-shift`)) return "the user's night-shift settings and rules";
  if (r.repo && (p === `${r.repo}/.claude/night-shift.json` || p === `${r.repo}/.claude/night-shift-rules.md`)) return "the project's night-shift rules";
  if (r.repo && under(p, `${r.repo}/.git`)) return "the .git directory";
  if (r.state && under(p, r.state) && RUNNER_FILES.test(p.slice(r.state.length + 1))) return "the runner's own files in the state folder";
  return null;
}

function checkWrite(file, env) {
  const p = norm(file);
  const r = roots(env);
  const odd = oddReason(p, file);
  if (odd) return odd;
  const prot = protectedPath(p, r);
  if (prot) return `writing ${prot} is not allowed during a night run`;
  // Only the user's own memory folders: a `.claude/projects/x/memory` anywhere else is not one.
  const mem = `${r.home}/.claude/projects/`;
  if (p.startsWith(mem) && /^[^/]+\/memory(\/|$)/.test(p.slice(mem.length))) return null;
  if (!r.writable.some((root) => under(p, root)))
    return `writes are limited to the repository, ${P.name === "win32" ? "C:\\temp" : "/tmp"} and the temp folder (got ${file})`;
  return null;
}

const GENERIC = [
  [/\bgh\s+(pr\s+merge|release\s+(create|delete|upload|edit)|repo\s+(delete|edit|rename|archive|create)|secret\b|variable\b)/i, "publishing or changing the GitHub repository needs the user"],
  [/\bgh\s+api\b[^\n]*(-X|--method)[\s=]*(DELETE|PUT|PATCH|POST)\b/i, "writing through the GitHub API needs the user"],
  // A field or an input file makes gh api send a POST unless the method is GET; a GraphQL query is one too, and only reads.
  [/\bgh\s+api\b(?!\s+graphql\b)(?![^\n]*(-X|--method)[\s=]*GET\b)[^\n]*\s(-f|--field|--raw-field|--input)[\s=]/i, "gh api with fields or an input file sends a POST: writing through the GitHub API needs the user"],
  [/\bgh\s+api\s+graphql\b[^\n]*\bmutation\b/i, "writing through the GitHub API needs the user"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\bsteamcmd\b|\bbutler\s+push\b|\bvsce\s+publish\b/i, "publishing needs the user"],
  [/\b(shutdown(\.exe)?\s|Restart-Computer|Stop-Computer|diskpart|bcdedit|vssadmin|cipher\s+\/w|format(\.com)?\s+[a-z]:)/i, "system-level commands are not allowed"],
  [/\breg(\.exe)?\s+(add|delete|import|restore|load)\b|\b(Set|New|Remove|Rename)-ItemProperty\b|\bRemove-Item\b[^\n]*\bHK(CU|LM):/i, "registry writes change the live system"],
  [/\b(taskkill|Stop-Process|pkill|killall)\b[^\n]*\b(node|claude|powershell|pwsh|explorer|code|bash)(\.exe)?\b/i, "that process may be the run itself or the user's"],
  [/\[(System\.)?IO\.(Directory|File)\]::Delete\b|::DeleteDirectory\b/i, "deletes through .NET cannot be checked"],
  [/\bSystemParametersInfo\b/i, "changing system parameters touches the live desktop"],
];

// PowerShell takes any prefix of -Recurse (-r, -rec) and has aliases for Remove-Item.
const RECURSIVE_DELETE = /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|\b(Remove-Item|ri|rm|del|erase|rd|rmdir)\b[^\n]*\s-r(e(c(u(r(se?)?)?)?)?)?\b|\b(rmdir|rd)\s+\/s\b|\bdel\s+\/s\b|\brimraf\b/i;
const DELETE_WORD = /^(?:.*[\\/])?(rm|del|erase|remove-item|ri|rd|rmdir|unlink|rimraf|shred|find)(\.exe)?$/i;
const ANY_DELETE = /\b(rm|del|erase|Remove-Item|ri|rd|rmdir|unlink|rimraf|shred)\b|\s-delete\b/i;
const CD_WORD = /^(cd|chdir|pushd|set-location|sl|push-location)$/i;
const POP_WORD = /^(popd|pop-location)$/i;

const SHELL = String.raw`(?:\S*[\\/])?(?:bash|sh|zsh|dash|ksh|mksh|ash|fish|pwsh|powershell|cmd)(?:\.exe)?`;

// Drops here-document bodies: text for cat, git commit -F, node and the like is data,
// not commands (session 08's note "318 files / 3434 tests" read as `rm -rf /`).
// A body fed to a shell (`bash <<EOF`, `cat <<EOF | sh`) stays, since it is commands. So do the
// $( ) and backtick spans of a body whose delimiter is unquoted: bash runs those whatever reads the text.
function dropHeredocs(cmd) {
  const out = [], pending = [];
  const flush = (h) => { for (const span of h.body ? bodySpans(h.body.join("\n")) : []) out.push(`(${span})`); };
  for (const line of cmd.split("\n")) {
    if (pending.length) {
      const h = pending[0];
      const end = line.replace(/\r$/, "");
      if ((h.dash ? end.replace(/^\t+/, "") : end) === h.delim) { pending.shift(); flush(h); }
      else h.body?.push(line);
      if (h.keep) out.push(line);
      continue;
    }
    out.push(line);
    // `<<` inside quoted text ("a <<X") starts no here-document; the quoted delimiter of one (<<'EOF') stays.
    const bare = line.replace(/(?<!<<-?\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')/g, (s) => "_".repeat(s.length));
    for (const m of bare.matchAll(/(?<!<)<<(-?)\s*(["']?)([A-Za-z_][\w.-]*)\2/g)) {
      const words = bare.slice(0, m.index).split(/[;&|()]/).pop().trim().split(/\s+/);
      const word = words.find((w) => !/^[A-Za-z_]\w*\+?=/.test(w)) || "";
      const keep = new RegExp(`^${SHELL}$`, "i").test(word) || new RegExp(String.raw`\|\s*${SHELL}(\s|$)`, "i").test(bare.slice(m.index));
      pending.push({ delim: m[3], dash: m[1] === "-", keep, body: keep || m[2] ? null : [] });
    }
  }
  pending.forEach(flush); // a body the text ends inside of
  return out.join("\n");
}
// The commands an unquoted here-document body runs: $( ) and backtick spans, not \$ or \` and not $(( )) arithmetic.
function bodySpans(body) {
  const spans = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") i++;
    else if (body[i] === "$" && body[i + 1] === "(" && body[i + 2] !== "(") { const e = closeParen(body, i + 1); spans.push(body.slice(i + 2, e)); i = e; }
    else if (body[i] === "`") { const e = body.indexOf("`", i + 1); if (e < 0) break; spans.push(body.slice(i + 1, e)); i = e; }
  }
  return spans;
}

// Splits a command line into simple commands at unquoted ; & | ( ) ` and newlines. Each has
//   words  its words with their quotes removed. A literal $ (inside single quotes, or \$ inside double
//          quotes) is kept as \0 and a literal backtick as \x01, so only a live $(...) or backtick pair
//          is a command substitution; unmark() puts them back.
//   bare   per word, whether it began outside quotes: `> x` is a redirect, `">x"` is text
//   sep    the separators before it as written, without ( ) ` and line breaks: "" for the first, "|" for a pipe
//   pre    the separators before it exactly as written, ( ) and ` included
//   lvl    how many ( are open, so that a cd inside ( ) can end at the )
// An unquoted < or > starts a word of its own (`echo x>f` writes f); `2>f` and `>|f` stay one word.
const unmark = (s) => s.replace(/\0/g, "$").replace(/\x01/g, "`");
// bash drops an unquoted backslash before an ordinary character (`r\m` is rm, `--for\ce` is --force). The pair
// stays in the word as written, and the result is marked soft; with soft set the line is read the way bash
// reads it. A word with a live $ keeps its pairs, and so does a Windows path (C:\temp\x), which sessions
// write under Bash as well.
const WINDOWS_WORD = /(^|[=:,])(?:[a-z]:\\|\\\\|\.{1,2}\\|~\\)/i;
export function simpleCommands(text, ps = false, soft = false) {
  const cmds = [];
  let words = [], bare = [], word = null, wb = false, q = null, run = "", lvl = 0, esc = [];
  const endWord = () => {
    if (word !== null) {
      if (esc.length) {
        cmds.soft = true;
        if (soft && !/[$`]/.test(word) && !WINDOWS_WORD.test(word)) word = word.split("").filter((_, k) => !esc.includes(k)).join("");
      }
      words.push(word); bare.push(wb);
    }
    word = null; esc = [];
  };
  const endCmd = () => {
    endWord();
    if (words.length) { cmds.push({ words, bare, sep: run.replace(/[()`\n]/g, "") || run, pre: run, lvl }); run = ""; }
    words = []; bare = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === "'") { if (c === "'") q = null; else word += c === "$" ? "\0" : c === "`" ? "\x01" : c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && /["\\$`]/.test(text[i + 1] || "")) { const n = text[++i]; word += n === "$" ? "\0" : n === "`" ? "\x01" : n; }
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; if (word === null) { word = ""; wb = false; } continue; }
    if (c === "|" && wb && /^\d*>$/.test(word ?? "")) { word += c; continue; }
    // bash: a backslash escapes the next character, so `\;` is a literal semicolon (`find -exec ... \; -delete`
    // is one command) and the second `\` of `\\;` leaves the `;` a separator. The pair stays in the word as
    // written ($ and ` keep their live meaning, which only makes the guard refuse more). PowerShell has no such escape.
    if (!ps && c === "\\" && i + 1 < text.length) {
      if (word === null) wb = true;
      if (/[\w-]/.test(text[i + 1])) esc.push((word ?? "").length);
      word = (word ?? "") + c + text[++i];
      continue;
    }
    if (/[;&|()`\n]/.test(c)) {
      endCmd(); run += c;
      if (c === "(") lvl++; else if (c === ")") lvl = Math.max(0, lvl - 1);
      continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    if ((c === "<" || c === ">") && word !== null && !/^\d*[<>]*$/.test(word)) endWord();
    if (word === null) wb = true;
    word = (word ?? "") + c;
  }
  endCmd();
  return cmds;
}

// Expands $NAME and ${NAME} from the command's own earlier assignments, then the
// session's environment. Returns null when anything stays unresolved: an unknown
// name, $(...), a backtick substitution inside double quotes, $1, $env:, %NAME%.
function expand(word, vars, env) {
  if (/\$env:|%[A-Za-z_]\w*%/i.test(word)) return null;
  let unresolved = false;
  const out = word.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, braced, bare) => {
    const name = braced ?? bare;
    const value = vars.has(name) ? vars.get(name) : env[name];
    if (value == null) { unresolved = true; return m; }
    return value;
  });
  if (unresolved || out.includes("$") || out.includes("`")) return null;
  return unmark(out);
}

const ASSIGN = /^[A-Za-z_]\w*\+?=/;
// What `$(mktemp -d)` makes lives under the temp root, unless an option or a template word could put
// it elsewhere (-p DIR, --tmpdir, a template without -t is made in the current folder). A template that
// is a full path (/tmp/build.XXXXXX) names the folder itself, wherever that is.
const MKTEMP_FLAG = /^-[dqtu]+$|^--(directory|quiet|dry-run)$/;
function mktempFolder(args) {
  const flags = args.filter((a) => /^-/.test(a)), names = args.filter((a) => !/^-/.test(a));
  if (!flags.every((a) => MKTEMP_FLAG.test(a))) return null;
  const t = flags.some((a) => /^-\w*t/.test(a));
  if (names.length === 1 && !t && isAbsolute(names[0]) && /^[\w.:\\/-]+XXX$/.test(names[0])) return norm(names[0]);
  if (!names.every((a) => /^[\w.]+$/.test(a))) return null;
  return names.length && !t ? null : `${norm(P.tempRoot())}/mktemp.XXXX`;
}
const mktempValue = (v) => {
  const m = /^(?:\$\(|`)\s*mktemp((?:\s+[^\s()`]+)*)\s*(?:\)|`)$/.exec(v);
  return m && mktempFolder(m[1].split(/\s+/).filter(Boolean));
};
// The splitter cuts an unquoted `D=$(mktemp -d)` into `D=$` and `mktemp -d`. It is that substitution when
// the next command is a mktemp opened right there and the one after it (if any) starts with the closing
// mark and a separator: `)/x` or `)$(cat y)` would add to the folder, `) rm` would not even set D.
// Returns the folder it makes, or null.
function mktempAfter(cmds, i) {
  const [a, n, z] = [cmds[i], cmds[i + 1], cmds[i + 2]];
  if (!n || n.words[0] !== "mktemp" || !/=\$?$/.test(a.words.at(-1))) return null;
  const close = n.pre === "(" ? "\\)" : n.pre === "`" ? "`" : null;
  return close !== null && (!z || new RegExp(`^${close}[;&|\\n)]`).test(z.pre)) ? mktempFolder(n.words.slice(1)) : null;
}

// A command made only of assignments (`D=C:/temp/x`, `export D=...`) sets them for the
// commands after it. A prefix assignment (`D=x rm -rf $D`) does not: bash expands the
// arguments first. `D+=x` appends to what D held (unknown when D is not known). `declare -x D=...` sets it
// as well: the options of export, declare and the like are passed over. tmp is the folder of the mktemp
// that the splitter cut off the last assignment.
function recordAssignments(words, vars, env, tmp) {
  const rest = /^(export|declare|local|readonly|typeset)$/.test(words[0]) ? words.slice(1).filter((w) => !/^[-+][A-Za-z]+$/.test(w)) : words;
  if (!rest.length || !rest.every((w) => ASSIGN.test(w))) return;
  rest.forEach((w, k) => {
    const [, name, plus, text] = /^([A-Za-z_]\w*)(\+?)=(.*)$/s.exec(w);
    let v = mktempValue(text) ?? (tmp && k === rest.length - 1 && /^\$?$/.test(text) ? tmp : expand(text, vars, env));
    if (plus) { const old = vars.has(name) ? vars.get(name) : env[name]; v = old == null || v == null ? null : old + v; }
    vars.set(name, v);
  });
}

// A wildcard target is not known until the shell expands it, so it is compared segment by segment
// with what a night session must not lose: if it can be that folder or file, inside it, or a folder
// above it (`C:/temp/x-night/run.*`, `.cl*/settings.json`, `<repo>/*`), it is refused.
const GLOB = /[*?[]/;
const segMatch = (pat, seg) => {
  if (!GLOB.test(pat)) return pat === seg;
  // A [set] counts as any one character: more than it matches, so a refusal errs on the safe side.
  const re = pat.replace(/\[[^\]]*\]?|[*?]|[\\^$.+(){}|\]]/g, (m) => (m === "*" ? "[^/]*" : m === "?" || m[0] === "[" ? "[^/]" : "\\" + m));
  return new RegExp(`^${re}$`).test(seg);
};
const overlaps = (g, c) => {
  const a = g.split("/"), b = c.split("/");
  return a.slice(0, b.length).every((s, i) => segMatch(s, b[i]));
};
function protectedTargets(r) {
  return [
    [r.state, "the run's state folder"],
    [r.repo && `${r.repo}/.git`, "the .git directory"],
    [r.repo && `${r.repo}/.claude`, "the project's .claude folder"],
    [`${r.home}/.claude/skills/night-shift`, "the night-shift skill itself"],
    ...r.skill.map((s) => [s, "the night-shift skill itself"]),
    ...r.plugins.flatMap((root) => PLUGIN_PARTS.map((f) => [`${root}/${f}`, "Claude Code's installed plugins"])),
    [`${r.home}/.claude/night-shift`, "the user's night-shift settings and rules"],
    [`${r.home}/.claude/settings.json`, "Claude settings"],
    [`${r.home}/.claude/settings.local.json`, "Claude settings"],
    [norm(`${r.home}/.claude/CLAUDE.md`), "the user's global CLAUDE.md"],
  ].filter(([c]) => c).flatMap(([c, why]) => spellings(c, r).map((s) => [s, why]));
}

// Words a command's own name can hide behind: `sudo`, `env X=1`, `builtin`, and the keywords that
// open a branch or a loop (`if cd x; then rm y`). Skipped, with NAME=value words, to reach the name.
export const PREFIX_WORDS = /^(sudo|command|exec|time|env|nohup|builtin|if|then|else|elif|do|while|until|!|\{)$/;
// Launchers run the command that follows them: [options that take a value, positional words of their own, what an option looks like].
const LAUNCHERS = {
  timeout: [/^-[ks]$|^--(kill-after|signal)$/, 1], nice: [/^-n$|^--adjustment$/, 0], ionice: [/^-[cnpPu]$/, 0],
  setsid: [/^$/, 0], stdbuf: [/^-[ioe]$/, 0], watch: [/^-n$|^--interval$/, 0], start: [/^$/, 0, /^\//],
  busybox: [/^$/, 0], wsl: [/^(-d|--distribution|-u|--user|--cd)$/, 0], doas: [/^-[Cu]$/, 0],
};
function nameIndex(words) {
  for (let i = 0; i < words.length; i++) {
    if (ASSIGN.test(words[i])) continue;
    // hasOwn: a command named `constructor` or `__proto__` is no launcher (and no throw).
    const launcher = Object.hasOwn(LAUNCHERS, base(words[i])) ? LAUNCHERS[base(words[i])] : null;
    if (launcher) {
      const [value, positional, option = /^-/] = launcher;
      while (option.test(words[i + 1] ?? "")) { i++; if (value.test(words[i])) i++; }
      i += positional;
      continue;
    }
    if (!PREFIX_WORDS.test(words[i])) return i;
    // env, sudo and the like take options of their own, some with a value (env -u NAME, sudo -u user).
    if (/^(sudo|env|command|exec|time|nohup)$/.test(words[i])) {
      while (/^-/.test(words[i + 1] ?? "")) { i++; if (/^-[ugCDRTaS]$/.test(words[i])) i++; }
    }
  }
  return -1;
}

const NESTED = "commands nested this deep cannot be read";
// Commands that print or search text: the words they are given are data, not commands.
const PRINTS = /^(grep|egrep|fgrep|rg|findstr|select-string|sls|echo|printf|write-output|write-host|cat|type|head|tail|jq|wc)$/;
const SHELL_NAME = /^(bash|sh|zsh|dash|ksh|mksh|ash|fish|pwsh|powershell|cmd)$/;
const base = (w) => w.replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
const txt = unmark;
const isPipe = (sep) => /\|&?$/.test(sep) && !/\|\|$/.test(sep);
// A script word as the shell that runs it will see it: this shell's own $NAMEs filled in where
// they are known, the single-quoted $ left for the inner shell to read.
const scriptText = (s, vars, env) => expand(s, vars, env) ?? txt(s);

// Git's words, read as git reads them. Global options come before the subcommand: -C and -c take the
// next word, a few long ones take it too (or `=value`), the rest are flags. Returns the subcommand's
// index, the config keys given on the command line and the -C folders. The delete check shares this
// reader, so both see the same subcommand.
function gitGlobals(args) {
  let i = 0;
  const keys = [], dirs = [];
  // [key, value] of a -c: the value is true when none is given, and null for --config-env (it is in a variable).
  const set = (w, known) => { const k = w.indexOf("="); keys.push([k < 0 ? w : w.slice(0, k), !known ? null : k < 0 ? "true" : w.slice(k + 1)]); };
  for (; i < args.length && args[i].startsWith("-"); i++) {
    const a = args[i];
    if (a === "-C") dirs.push(args[++i]);
    else if (a === "-c") set(args[++i] ?? "", true);
    else if (a === "--config-env") set(args[++i] ?? "", false);
    else if (a.startsWith("--config-env=")) set(a.slice(13), false);
    else if (/^--(git-dir|work-tree|namespace|super-prefix|attr-source)$/.test(a)) i++;
  }
  return { sub: i, keys, dirs };
}
// Config that makes git run something the guard cannot read: an alias, a file that can define one
// (include), or a command git calls (editor, pager, hooks, helpers, drivers). Reading a key is fine.
const CONFIG_ALIAS = /^(alias|include|includeif)\./i;
const CONFIG_RUNS = /^(core\.(fsmonitor|sshcommand|hookspath|editor|pager|askpass|gitproxy|alternaterefscommand)|sequence\.editor|credential\.(.+\.)?helper|diff\.external|diff\..+\.(textconv|command)|filter\..+\.(clean|smudge|process)|merge\..+\.driver|gpg\.(.+\.)?program|help\.autocorrect|pager\..+|uploadpack\.packobjectshook|remote\..+\.(uploadpack|receivepack)|(difftool|mergetool)\..+\.cmd|trailer\..+\.command|protocol\.(.+\.)?allow)$/i;
// Keys that move where a fetch or push goes: the change `git remote set-url` makes, written as config.
const CONFIG_REMOTE = /^(remote\..+\.(url|pushurl)|url\..+\.(insteadof|pushinsteadof))$/i;
const REMOTES = "changing remotes needs the user";
const configReason = (key) => CONFIG_ALIAS.test(key) ? "git aliases are not read during a night run" : CONFIG_RUNS.test(key) ? "git settings that run commands are not changed during a night run" : CONFIG_REMOTE.test(key) ? REMOTES : null;
// Of those, the keys whose value is a command line: given for one command with -c, the value is read as
// the command it is (`-c core.pager=cat`), the way GIT_PAGER and GIT_EDITOR are.
const CONFIG_COMMAND = /^(core\.(editor|pager|sshcommand)|sequence\.editor|pager\..+)$/i;
// Sections whose keys make git run something: a section renamed into one of them brings its keys along.
const CONFIG_SECTION = /^(alias|include|includeif|core|sequence|credential|diff|filter|merge|gpg|help|pager|uploadpack|remote|difftool|mergetool|trailer|protocol)(\.|$)/i;
// Options stop at a bare `--`. A long option may be cut short as long as it stays unambiguous
// (`--forc`, even `--f` for clean), so any prefix of the name counts; short ones may be clustered (-uf).
const upToDashes = (a) => { const k = a.indexOf("--"); return k < 0 ? a : a.slice(0, k); };
const long = (a, name) => upToDashes(a).some((w) => { const m = /^--([a-z][a-z-]*)(=|$)/.exec(w); return m && name.startsWith(m[1]); });
const short = (a, letter) => upToDashes(a).some((w) => /^-[A-Za-z]+$/.test(w) && w.includes(letter));
const anyLong = (a, ...names) => names.some((n) => long(a, n));
const anyShort = (a, letters) => [...letters].some((l) => short(a, l));
// The whole tree as a pathspec: `.`, `./`, `:/`, and the glob `*` (`./*`, `:/*`) that names every file in it.
const wholeTree = (a) => a.some((w) => /^(\.\/?|:\/\.?|(\.\/|:\/)?\*)$/.test(w));
const firstArg = (a) => a.find((w) => !w.startsWith("-"));
// The remote's program (--upload-pack, --receive-pack, --exec; clone's -u is --upload-pack) runs as a command line.
// In a cluster the letters after one that takes a value (clone's -b name, -o name, -c key=value, -j n) are that value.
const cloneU = (a) => upToDashes(a).some((w) => {
  if (!/^-[A-Za-z]/.test(w)) return false;
  for (const l of w.slice(1)) { if (l === "u") return true; if ("bocj".includes(l)) return false; }
  return false;
});
const transport = (a, clone) => (anyLong(a, "upload-pack", "receive-pack", "exec") || (clone && cloneU(a))) && "git options that name a program to run are not used during a night run";
// git config: reading a value changes nothing (--get, --list, get, or a key alone). A write is refused when it
// goes to the user's own config, sets a key that makes git run something, or renames a section into one that does.
function configRule(a) {
  const pos = upToDashes(a).filter((w) => !w.startsWith("-"));
  const writes = anyLong(a, "add", "unset", "unset-all", "replace-all", "rename-section", "remove-section", "edit") || short(a, "e");
  const reads = anyLong(a, "get", "get-all", "get-regexp", "get-urlmatch", "get-color", "get-colorbool", "list") || short(a, "l") || /^(get|list)$/.test(pos[0] ?? "") || pos.length === 1;
  if (reads && !writes) return null;
  if (anyLong(a, "global", "system")) return "global git config is the user's";
  const renames = long(a, "rename-section") || pos[0] === "rename-section";
  const removes = long(a, "remove-section") || pos[0] === "remove-section";
  if ((renames || removes) && pos.some((w) => /^(remote|url)(\.|$)/i.test(w))) return REMOTES;
  if (renames && pos.some((w) => CONFIG_SECTION.test(w))) return "git settings that run commands are not changed during a night run";
  // A key followed by its value is set. A remote's key is refused when unset too: --unset pushurl sends pushes to url.
  const unsets = anyLong(a, "unset", "unset-all") || pos[0] === "unset";
  return a.map((w, i) => i + 1 < a.length && configReason(w)).find(Boolean) || (unsets && a.some((w) => CONFIG_REMOTE.test(w)) ? REMOTES : null);
}
// Where a push goes: --repo's value, else its first word that is neither an option nor an option's value (-o takes one).
function pushRepos(a) {
  const out = [];
  let dashes = false, positional = 0;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (!dashes && w === "--") { dashes = true; continue; }
    if (!dashes && w.startsWith("-")) {
      const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(w);
      const repo = Boolean(m) && m[1].length >= 3 && "repo".startsWith(m[1]);
      if (repo && m[2] != null) out.push(m[2]);
      else if (repo) out.push(a[++i] ?? "");
      // -o takes the next word as its value, also at the end of a cluster (-uo ci:skip); -uoci:skip holds its own.
      else if (/^-[^-o]*o$/.test(w) || (m && m[2] == null && m[1].length >= 6 && "push-option".startsWith(m[1]))) i++;
      continue;
    }
    if (positional++ === 0) out.push(w);
  }
  return out;
}
// A URL (scheme:…) or scp's [user@]host:path is no remote's name; a drive path (C:/x) is a local repository.
const URL_REPO = /^(?![a-z]:([\\/]|$))[^/:]+:/i;
const GIT_RULES = {
  push: (a) => transport(a) || ((anyLong(a, "force", "force-with-lease", "force-if-includes", "delete", "mirror", "prune") || anyShort(a, "fd") || a.some((w) => /^[+:]/.test(w))) && "force or deleting pushes rewrite shared history")
    || (pushRepos(a).some((w) => URL_REPO.test(w)) && "a push to a URL instead of a remote is a change to the remotes, which needs the user"),
  fetch: (a) => transport(a),
  "ls-remote": (a) => transport(a),
  clone: (a) => transport(a, true),
  archive: (a) => transport(a),
  reset: (a) => anyLong(a, "hard", "merge") && "git reset --hard discards work",
  checkout: (a) => (long(a, "force") || anyShort(a, "fB") || wholeTree(a)) && "checking out over the whole tree discards work",
  switch: (a) => (anyLong(a, "force", "discard-changes", "force-create") || anyShort(a, "fC")) && "switching by force discards work",
  // --staged alone (-S) touches the index only, nothing is lost; -s is --source, so these two stay case-sensitive.
  restore: (a) => wholeTree(a) && !((long(a, "staged") || short(a, "S")) && !long(a, "worktree") && !short(a, "W")) && "restoring the whole tree discards work",
  rebase: () => "history rewrites need the user",
  "filter-branch": () => "history rewrites need the user",
  "filter-repo": () => "history rewrites need the user",
  merge: () => "merges need the user",
  "update-ref": () => "changing refs by hand needs the user",
  commit: (a) => long(a, "amend") && "amending rewrites history",
  branch: (a) => (anyLong(a, "delete", "force") || anyShort(a, "dDfMC")) && "deleting or force-moving branches needs the user",
  reflog: (a) => /^(expire|delete)$/.test(a[0]) && "expiring the reflog discards the way back",
  clean: (a) => (long(a, "force") || short(a, "f")) && "git clean deletes untracked work",
  pull: (a) => transport(a) || (!a.includes("--ff-only") && "only git pull --ff-only is allowed"),
  stash: (a) => /^(drop|clear)$/.test(a[0]) && "dropping stashes discards work",
  // `git remote -v add x url` works: the options come first.
  remote: (a) => /^(add|remove|rm|set-url|rename)$/.test(firstArg(a)) && REMOTES,
  config: configRule,
  tag: (a) => (long(a, "delete") || short(a, "d")) && "deleting tags needs the user",
  worktree: (a) => firstArg(a) === "remove" && (long(a, "force") || short(a, "f")) && "removing a worktree by force discards the work in it",
  // --prune=<date> drops the unreachable objects younger than git's two weeks: the way back from a mistake.
  gc: (a) => upToDashes(a).some((w) => { const m = /^--([a-z]+)=/.exec(w); return m && "prune".startsWith(m[1]); }) && "pruning objects by date discards the way back",
  prune: () => "pruning objects discards the way back",
  replay: () => "history rewrites need the user",
  history: () => "history rewrites need the user",
};
// Git's own commands the guard has no rule for: an alias cannot replace them, so nothing is looked up.
const GIT_PLAIN = new Set(`status add log diff show rev-parse ls-files describe blame grep tag mv rm init worktree cherry-pick revert apply
  bisect shortlog cat-file ls-tree rev-list for-each-ref show-ref symbolic-ref check-ignore merge-base name-rev submodule notes format-patch am gc help version`.split(/\s+/));
// Variables that point git at other config or another repository, as prefix words or an earlier assignment.
// Outside Git Bash, git finds the user's config through USERPROFILE or HOMEDRIVE and HOMEPATH.
const GIT_ENV_VAR = /^(\$env:|set:)?(GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_CONFIG_HOME|GIT_DIR|GIT_COMMON_DIR)(=|$)/i;
// The twins of the config keys that run a command: git takes these from the environment as a command line,
// and these name a program outright (the exec path holds git's own helpers, GIT_SSH is run as the transport).
const GIT_ENV_RUNS = /^(?:\$env:|set:)?GIT_(?:SSH_COMMAND|PAGER|EDITOR|ASKPASS|EXTERNAL_DIFF|PROXY_COMMAND)$/i;
const GIT_ENV_PROG = /^(?:\$env:|set:)?GIT_(?:EXEC_PATH|SSH)$/i;
// prefix: the words before git's name (`GIT_PAGER=x git log`); vars: what the command line set before it.
// A prefix value is read as written where a variable in it is not known (`ssh -i $KEY`): the shell git
// starts fills it in, and a command that is itself a variable is refused there.
function gitEnvReason(prefix, vars, env, where, opts, depth) {
  const given = prefix.map((w) => /^([A-Za-z_]\w*)\+?=(.*)$/s.exec(w)).filter(Boolean).map(([, k, v]) => [k, scriptText(v, vars, env)]);
  for (const [k, v] of [...given, ...vars]) {
    if (GIT_ENV_PROG.test(k)) return "git is not pointed at another program during a night run";
    if (!GIT_ENV_RUNS.test(k)) continue;
    if (v == null) return `${k.replace(/^(\$env:|set:)/i, "")} is a command line git runs, and its value cannot be read`;
    const why = checkCommand(v, env, { ...where }, { ...opts, vars: new Map(), ps: false }, depth + 1);
    if (why) return why;
  }
  return null;
}
// git's words with the $NAMEs the walker knows filled in, so `F=--force; git push $F` is read as the push it is.
// An unquoted word that is only a variable is as many words as its value has; a quoted one ("$M") stays one word.
const gitWords = (words, vars, env, bare = []) => words.flatMap((w, i) => {
  const v = w.includes("$") ? expand(w, vars, env) : null;
  return v === null ? [w] : bare[i] !== false && /^\$\{?\w+\}?$/.test(w) ? v.split(/\s+/).filter(Boolean) : [v];
});
const quoteArg = (w) => `"${w.replace(/(["\\$`])/g, "\\$1")}"`;
const configuredAlias = (name, cwd) => {
  try {
    const r = spawnSync("git", ["config", "--get", `alias.${name}`], { cwd, timeout: 3000, encoding: "utf8", windowsHide: true });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch { return null; }
};

// What a git subcommand runs besides itself: [{ shell }] for a command line it hands to a shell,
// [{ git }] for git words it runs again. The shell joins the words after foreach / run with spaces.
function gitRuns(cmd, a) {
  const first = firstArg(a), after = first === undefined ? [] : a.slice(a.indexOf(first) + 1);
  const out = [];
  const shell = (words) => { const rest = [...words]; while (rest[0]?.startsWith("-")) rest.shift(); if (rest.length) out.push({ shell: rest.join(" ") }); };
  if (cmd === "submodule" && first === "foreach") shell(after);
  else if (cmd === "bisect" && first === "run") out.push({ shell: after.join(" ") });
  else if (cmd === "for-each-repo") {
    // --config=<key> names the repositories; the rest are git's own words, run in each.
    const k = a.findIndex((w, i) => !w.startsWith("-") && a[i - 1] !== "--config");
    if (k >= 0) out.push({ git: a.slice(k) });
  } else if (cmd === "difftool") {
    // -x <cmd>, -x<cmd>, --extcmd=<cmd>, --extcmd <cmd>
    const w = upToDashes(a);
    w.forEach((x, i) => {
      const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(x);
      if (m && "extcmd".startsWith(m[1])) out.push({ shell: m[2] ?? w[i + 1] ?? "" });
      else if (!m && x.startsWith("-x")) out.push({ shell: x.length > 2 ? x.slice(2) : w[i + 1] ?? "" });
    });
  } else if (cmd === "grep") {
    // -O<pager>, --open-files-in-pager=<pager>
    for (const x of upToDashes(a)) {
      const m = /^--([a-z][a-z-]*)=(.*)$/.exec(x);
      if (m && "open-files-in-pager".startsWith(m[1])) out.push({ shell: m[2] });
      else if (/^-O./.test(x)) out.push({ shell: x.slice(2) });
    }
  }
  return out;
}

// The reason a git command (the words after `git`) is refused, or null. An alias is read as what it
// stands for: `!cmd` runs as a shell command with the arguments appended, any other value is git's own
// words again. Git never lets an alias replace one of its commands, so those are not looked up.
export function gitRule(args, ctx) {
  const { env, where, opts, depth } = ctx;
  if (depth > 4) return NESTED;
  args = args.map(unmark);
  const { sub, keys, dirs } = gitGlobals(args);
  for (const [k, v] of keys) {
    const why = configReason(k);
    if (!why) continue;
    if (v === null || !CONFIG_COMMAND.test(k)) return why;
    const run = v.trim() ? checkCommand(v, env, { ...where }, { ...opts, vars: new Map(), ps: false }, depth + 1) : null;
    if (run) return run;
  }
  if (sub >= args.length) return null;
  const name = args[sub], a = args.slice(sub + 1), cmd = name.toLowerCase();
  if (Object.hasOwn(GIT_RULES, cmd)) return GIT_RULES[cmd](a) || null;
  let cwd = ctx.cwd ?? (where.at && !where.lost ? where.at : env.NIGHT_SHIFT_REPO);
  for (const d of dirs) cwd = !cwd || isAbsolute(d) ? norm(d) : norm(`${cwd}/${d}`);
  const inner = { ...opts, vars: new Map() };
  // The command a subcommand hands to a shell, or the git it runs, is read like any other.
  for (const { shell, git } of gitRuns(cmd, a)) {
    const why = shell != null ? checkCommand(shell, env, { ...where }, inner, depth + 1) : gitRule(git, { env, where, opts: inner, depth: depth + 1, cwd });
    if (why) return why;
  }
  if (GIT_PLAIN.has(cmd)) return null;
  // The alias is read in the folder git will run in: the -C folders on top of where the command
  // stands (or the repository when that is not known).
  const value = (opts.gitAlias ?? configuredAlias)(name, cwd || undefined);
  if (!value) return null;
  if (value.startsWith("!")) return checkCommand([value.slice(1), ...a.map(quoteArg)].join(" "), env, { ...where }, inner, depth + 1);
  return gitRule([...simpleCommands(value).flatMap((c) => c.words), ...a], { env, where, opts: inner, depth: depth + 1, cwd });
}

// The commands inside "$(...)" and "`...`": the splitter cannot see them in a quoted word.
function substitutions(word) {
  const out = [];
  for (let i = word.indexOf("$("); i !== -1; i = word.indexOf("$(", i + 1)) out.push(word.slice(i + 2, closeParen(word, i + 1)));
  const parts = word.split("`");
  for (let k = 1; k < parts.length; k += 2) out.push(parts[k]);
  return out;
}
// Where the ( at s[i] closes (the end of s when it does not).
function closeParen(s, i) {
  let depth = 0, j = i;
  for (; j < s.length; j++) { if (s[j] === "(") depth++; else if (s[j] === ")" && --depth === 0) break; }
  return j;
}
// `eval "$(fnm env)"` runs what a tool prints, which no one can read beforehand; the tool's own
// command is checked as a substitution. Only when the substitution is the whole script.
const isSubstitution = (s) => (s.startsWith("$(") ? closeParen(s, 1) === s.length - 1 : /^`[^`]*`$/.test(s));

// `eval "$(echo 'rm -rf x')"`: the words of the echo or printf inside are what eval runs.
function checkEchoed(s, env, where, opts, depth) {
  const body = s.startsWith("$(") ? s.slice(2, -1) : s.slice(1, -1);
  for (const c of simpleCommands(body, opts.ps)) {
    const k = nameIndex(c.words);
    if (k < 0 || !/^(echo|printf)$/.test(base(c.words[k]))) continue;
    const words = c.words.slice(k + 1).filter((w) => !/^-[neE]+$/.test(w));
    const why = checkCommand(words.map(unmark).join(" "), env, where, { ...opts, vars: new Map() }, depth + 1);
    if (why) return why;
  }
  return null;
}

// Redirections are files written or read, not arguments: `> f`, `>>f`, `2>f`, `< f`, `<<EOF`, `<<< text`.
function splitRedirects(c) {
  const args = [], argBare = [], writes = [], here = [];
  let input = false;
  for (let i = 0; i < c.words.length; i++) {
    const w = c.words[i];
    let m;
    if (c.bare[i] && (m = /^(?:\d+|\*)?>{1,2}\|?(.*)$/s.exec(w))) {
      const t = m[1] || c.words[++i];
      if (t != null) writes.push(t);
    } else if (c.bare[i] && (m = /^<<<(.*)$/s.exec(w))) {
      input = true;
      const t = m[1] || c.words[++i];
      if (t != null) here.push(t);
    } else if (c.bare[i] && (m = /^<<-?(.*)$/s.exec(w) || /^\d*<(.*)$/s.exec(w))) {
      input = true;
      if (!m[1]) i++;
    } else { args.push(w); argBare.push(c.bare[i]); }
  }
  return { args, argBare, writes, here, input };
}

// What a shell is asked to run: { script } after -c, -Command or /c; { file } for a script file;
// { encoded } for a PowerShell command in base64; nothing when it reads its commands from its input.
function shellArgs(sh, a) {
  if (sh === "cmd") {
    const k = a.findIndex((w) => /^[\/\\]{1,2}[ck]$/i.test(w));
    return k < 0 ? {} : { script: a.slice(k + 1).join(" ") };
  }
  if (sh === "pwsh" || sh === "powershell") {
    for (let k = 0; k < a.length; k++) {
      const n = /^[-\/]([a-z]+)$/i.exec(a[k])?.[1].toLowerCase();
      // The first word that is no option is the command (-Command is PowerShell's default parameter).
      if (!n) return { script: a.slice(k).join(" ") };
      if (n === "ec" || "encodedcommand".startsWith(n)) return { encoded: true };
      if ("command".startsWith(n)) return { script: a.slice(k + 1).join(" ") };
      if ("file".startsWith(n)) return { file: true };
      if (/^(ep|wd|if|of)$/.test(n) || ["executionpolicy", "windowstyle", "workingdirectory", "version", "inputformat", "outputformat", "configurationname", "configurationfile", "settingsfile", "custompipename"].some((f) => f.startsWith(n))) k++;
    }
    return {};
  }
  let stdin = false; // -s reads the script from the input; the words after it are its arguments, not a file
  for (let k = 0; k < a.length; k++) {
    const w = a[k];
    if (/^[-+][oO]$|^--(rcfile|init-file)$/.test(w)) { k++; continue; }
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w)) return { script: a[k + 1] };
    if (/^-[A-Za-z]*s[A-Za-z]*$/.test(w)) stdin = true;
    if (w === "--") return stdin ? {} : { file: a[k + 1] != null };
    if (/^[-+]/.test(w) || w === "-") continue;
    return stdin ? {} : { file: true };
  }
  return {};
}

// Paths a command writes (a redirection's target is handled apart). cp-like commands write their
// destination, mv-like ones also take their sources away; a PowerShell -Path:x names its value.
const WRITE_ALL = /^(tee|mv|move|move-item|mi|truncate|touch)$/;
const WRITE_LAST = /^(cp|copy|copy-item|cpi|ln|install|rsync|scp)$/;
// PowerShell commands whose -Path, or else first word, is the file they write, make, empty or rename;
// the words after it are content, a new name or a type.
const WRITE_FIRST = /^(set-content|sc|add-content|ac|out-file|new-item|ni|clear-content|clc|rename-item|rni|ren)$/;
// Options of these that take a value, which is no file they write.
const WRITE_SKIP = { touch: /^(-[dtr]|--date|--reference)$/, truncate: /^(-[sr]|--size|--reference)$/, install: /^(-[mogS]|--mode|--owner|--group|--suffix)$/ };
// sed and perl write the files they are given only with -i (sed -i.bak, perl -pi -e); the value of -e or -f,
// or else the first word, is their script.
const IN_PLACE = { sed: [/^(-[nErszu]*i|--in-place(=|$))/, /^(-[nrszuE]*[ef]|--expression|--file)$/], perl: [/^-[0acdlnpsStTuUwWxX]*i/, /^-[0-9A-Za-z]*[eE]$/] };
const FILE_PARAM = (n) => PATH_PARAM(n) || (n.length > 1 && "filepath".startsWith(n.toLowerCase()));
function writeTargets(nm, a) {
  if (nm === "dd") return a.map((w) => /^of=(.+)$/s.exec(w)?.[1]).filter(Boolean);
  if (nm === "curl" || nm === "wget") {
    const [opt, eq] = nm === "curl" ? [/^(-[A-Za-z#]*o|--output)$/, /^--output=(.+)$/s] : [/^(-[A-Za-z]*O|--output-document)$/, /^--output-document=(.+)$/s];
    return a.flatMap((w, i) => (opt.test(w) ? [a[i + 1]] : [eq.exec(w)?.[1]])).filter((t) => t != null);
  }
  if (Object.hasOwn(IN_PLACE, nm)) {
    const [inPlace, takes] = IN_PLACE[nm];
    if (!a.some((w) => inPlace.test(w))) return [];
    const files = [];
    let script = false;
    for (let i = 0; i < a.length; i++) {
      if (takes.test(a[i])) { script = true; i++; }
      else if (/^--(expression|file)=/.test(a[i])) script = true;
      else if (a[i] && !/^-/.test(a[i])) files.push(a[i]);
    }
    return script ? files : files.slice(1);
  }
  // xcopy and robocopy: source, destination, then file names and /options.
  if (nm === "xcopy" || nm === "robocopy") return a.filter((w) => !/^\/[A-Za-z]/.test(w) || /^\/[a-z]\//i.test(w)).slice(1, 2);
  const first = WRITE_FIRST.test(nm);
  if (!first && !WRITE_ALL.test(nm) && !WRITE_LAST.test(nm) && nm !== "mklink") return [];
  const pos = [], named = [];
  let name = null;
  for (let i = 0; i < a.length; i++) {
    const w = a[i];
    if (first) {
      const p = /^-([A-Za-z]+)(?:[:=](.+))?$/s.exec(w);
      if (!p) pos.push(w);
      else if (FILE_PARAM(p[1])) { const v = p[2] ?? a[++i]; if (v != null) named.push(v); }
      else if (/^na/i.test(p[1]) && "name".startsWith(p[1].toLowerCase())) name = p[2] ?? a[++i] ?? null;
      else if (p[2] == null && (valueParam(w) || /^-(it|ty|va|ne|en|inp)/i.test(w))) i++;
      continue;
    }
    if (WRITE_SKIP[nm]?.test(w)) { i++; continue; }
    const pv = /^--?[A-Za-z][\w-]*[:=](.+)$/s.exec(w);
    if (pv) { if (!Object.hasOwn(WRITE_SKIP, nm)) named.push(pv[1]); }
    else if (/^(-t|--target-directory|-des\w*)$/i.test(w)) { if (a[i + 1] != null) named.push(a[++i]); }
    else if (!/^-/.test(w) && !/^\/[a-z]$/i.test(w)) pos.push(w);
  }
  if (first) {
    // New-Item -Path dir -Name file makes dir/file.
    if (name != null && /^(new-item|ni)$/.test(nm)) return [`${named[0] ?? pos[0] ?? "."}/${name}`];
    return named.length ? named : pos.slice(0, 1);
  }
  // host:path is on another machine.
  if (nm === "rsync" || nm === "scp") return [...named, ...pos.slice(-1)].filter((t) => !/^[^\\/:]{2,}:/.test(t));
  if (WRITE_LAST.test(nm)) return [...named, ...pos.slice(-1)];
  if (nm === "mklink") return pos.slice(0, 1);
  return [...named, ...pos];
}
// A move takes its sources away: every word but the last, or every word when the destination is named
// (-t dir, -Destination dir); PowerShell's -Path names them outright.
const MOVERS = /^(mv|move|move-item|mi)$/;
function moveSources(a) {
  const pos = [], named = [];
  let dest = false;
  for (let i = 0; i < a.length; i++) {
    const w = a[i], p = /^-([A-Za-z]+)(?:[:=](.+))?$/s.exec(w);
    if (/^--target-directory=/.test(w)) dest = true;
    else if (/^(-t|--target-directory)$/.test(w) || (p && /^d/i.test(p[1]) && "destination".startsWith(p[1].toLowerCase()))) { dest = true; if (p?.[2] == null) i++; }
    else if (p && p[1].length > 1 && PATH_PARAM(p[1])) { const v = p[2] ?? a[++i]; if (v != null) named.push(v); }
    else if (!/^-/.test(w) && !/^\/[a-z]$/i.test(w)) pos.push(w);
  }
  return named.length ? named : dest ? pos : pos.slice(0, -1);
}
function writeDenial(t, env, where, vars, r) {
  const v = expand(t, vars, env);
  if (v === null) return null; // not known until the shell expands it
  const home = v.replace(/^~(?=[\\/]|$)/, r.home);
  const abs = isAbsolute(home);
  if (!abs && where.lost) return null;
  const p = norm(abs || !where.at ? home : `${where.at}/${home}`);
  const odd = oddReason(p, t);
  if (odd) return odd;
  const prot = protectedPath(p, r);
  return prot ? `writing ${prot} is not allowed during a night run` : null;
}

// {a,b} lists, which the shell expands before the command runs (${x} is a variable, not a list). Each
// round opens one list in every word; a word that still holds a list after the last round is refused.
const BRACE = /(?<!\$)\{([^{}]*,[^{}]*)\}/;
const braces = (w) => {
  let out = [w];
  for (let round = 0; round < 6 && out.length <= 64 && out.some((x) => BRACE.test(x)); round++) {
    out = out.flatMap((x) => { const m = BRACE.exec(x); return m ? m[1].split(",").map((a) => x.slice(0, m.index) + a + x.slice(m.index + m[0].length)) : [x]; });
  }
  return out;
};
// PowerShell parameters whose value is not a path. Names match case-insensitively by unique prefix, so at
// least two letters (bash's `rm -r -f x` must keep x as a target).
const VALUE_PARAMS = ["include", "exclude", "filter", "stream", "credential", "erroraction", "warningaction", "informationaction", "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable"];
const VALUE_ALIASES = /^(ea|wa|infa|ev|wv|iv|ov|ob|pv)$/;
const valueParam = (t) => { const n = /^-([a-z]{2,})$/i.exec(t)?.[1].toLowerCase(); return Boolean(n) && (VALUE_ALIASES.test(n) || VALUE_PARAMS.some((p) => p.startsWith(n))); };
const PATH_PARAM = (n) => { n = n.toLowerCase(); return "path".startsWith(n) || "literalpath".startsWith(n) || n === "pspath" || n === "lp"; };
const XARGS_VALUE = /^(-[aEdILnPs]|--(arg-file|delimiter|max-lines|max-args|max-procs|max-chars|process-slot-var))$/;
// git commands xargs may feed names to: those that only read, and those that take paths after a closing `--`.
const XARGS_GIT_READS = /^(add|diff|log|show|blame|grep|ls-files|check-ignore|cat-file|rev-parse)$/;
const XARGS_GIT_PATHS = /^(checkout|restore|reset|status|commit)$/;

// The commands a find runs (-exec ... ; or +), one word list each.
const FIND_EXEC = /^-(exec|execdir|ok|okdir)$/;
function execGroups(words) {
  const groups = [];
  for (let k = 0; k < words.length; k++) {
    if (!FIND_EXEC.test(words[k])) continue;
    let e = k + 1;
    while (e < words.length && !/^(\\?;|\\|\+)$/.test(words[e])) e++;
    groups.push(words.slice(k + 1, e));
    k = e;
  }
  return groups;
}
// A find whose -exec deletes makes find a delete, so its paths are checked: the command itself, or
// a shell or cmd it starts (bash -c 'rm "$0"'), whose script holds a delete word.
const DELETING = /^(rm|unlink|del|erase|remove-item|ri|rd|rmdir|shred|rimraf)$/;
const execDeletes = (g) => {
  const k = nameIndex(g);
  if (k < 0) return false;
  const cmd = base(g[k]);
  return DELETING.test(cmd) || (SHELL_NAME.test(cmd) && g.slice(k + 1).join(" ").split(/[\s;&|()`"'{}]+/).some((w) => DELETING.test(base(w))));
};
const findExecDeletes = (words) => execGroups(words).some(execDeletes);
// Names found inside .git and the project's .claude folder, in lower case. A name test that can match one
// of them does not keep a find, or a PowerShell listing, out of those folders. Of branches only main and
// master are known.
const INSIDE = `.git .claude night-shift.json night-shift-rules.md settings.json settings.local.json head orig_head fetch_head merge_head config description index
  packed-refs commit_editmsg hooks info exclude objects pack refs heads tags remotes origin main master logs pre-commit.sample 0a
  0123456789abcdef0123456789abcdef012345 pack-0123456789abcdef0123456789abcdef01234567.pack pack-0123456789abcdef0123456789abcdef01234567.idx
  pack-0123456789abcdef0123456789abcdef01234567.rev`.split(/\s+/);
// What the user's ~/.claude/night-shift folder holds (config, rules, the runs the runner keeps, the Telegram token): names a find
// or a listing must also steer clear of, but only when its start path covers that folder, so no other find reads them as inside.
const NS_NAMES = ["night-shift", "rules.md", "config.json", "runs", "telegram.json"];
const nsNames = (q, r) => r.claude.some((c) => under(`${c}/night-shift`, q)) ? NS_NAMES : [];
const meetsInside = (pat, extra = []) => [...INSIDE, ...extra].some((n) => segMatch(pat, n));
// A -path test keeps a find out of .git when it stays below one folder of the start path (./dist/*), or
// needs a folder on the way that .git and .claude do not hold (*/node_modules/*). start: the start path's own folders.
function pathNarrows(pat, start, extra = []) {
  if (/\.git|\.claude/.test(pat)) return false;
  if (!/[\\/]/.test(pat)) return !meetsInside(pat, extra);
  const segs = pat.split(/[\\/]/).filter(Boolean);
  // Before the one-folder shortcut: ./night-shift/* stays inside the folder the extra names guard (a segment like night-* can be it).
  if (segs.some((s) => extra.some((n) => s === n || (GLOB.test(s) && !/^\*+$/.test(s) && segMatch(s, n))))) return false;
  if (segs[0] === "." && segs[1] && !GLOB.test(segs[1])) return true;
  const fixed = segs.filter((s) => s !== "." && !GLOB.test(s) && !start.includes(s));
  return fixed.length > 0 && !fixed.some((s) => INSIDE.includes(s) || extra.includes(s));
}
// find . -delete takes .git with it. A find from the repository (or its .claude folder) up is safe only
// when every delete in it (-delete, an -exec that deletes) stands behind a name, path or regex test that
// cannot match inside .git, or behind one that leaves .git out (-not -path '*/.git/*', -path ./.git -prune).
// The expression is read as find reads it: -o starts a new alternative with no test yet, ( ) groups.
const NAME_TEST = /^-(i?name|i?lname|i?path|i?wholename|i?regex)$/;
const FIND_END = /^(\\?;|\\|\+)$/;
function findNarrowed(words, q = "", extra = []) {
  // In lower case on every system, the start path too: INSIDE holds git's names in lower case (HEAD is head), and a
  // pattern's folder that is one of the start path's own must be known as such whatever the case.
  const w = words.map(unmark).map((x) => x.toLowerCase()), start = q.toLowerCase().split("/");
  let k = 0, acted = false, pruned = false, any = false;
  const narrows = (test, pat, not) => {
    const path = /path|whole/.test(test), regex = /regex/.test(test);
    // A negated test narrows only when it leaves out what is inside .git: -not -name .git still walks into it.
    if (not) return (path || regex) && pat.includes(".git") && /\*$/.test(pat);
    if (regex) return !pat.includes(".git") && !/^[*?./\\]*$/.test(pat);
    return path ? pathNarrows(pat, start, extra) : !meetsInside(pat, extra);
  };
  // One ( ) group, or the whole expression. given: a test before it already narrowed. Returns whether every
  // delete in it stands behind a test, and whether every alternative of it narrows.
  const group = (given) => {
    let safe = true, all = true, alt = given || pruned, prunes = false, names = false, not = false;
    const close = () => { all &&= alt; if (prunes && names) pruned = true; alt = given || pruned; prunes = names = false; };
    for (; k < w.length && !/^\\?\)$/.test(w[k]); k++) {
      const x = w[k];
      if (/^(-o|-or|,)$/.test(x)) { close(); continue; }
      if (/^(-not|\\?!)$/.test(x)) { not = true; continue; }
      if (/^\\?\($/.test(x)) { k++; const [s, a] = group(alt); safe &&= s; if (a && !not) alt = true; }
      else if (NAME_TEST.test(x) && w[k + 1] != null) {
        const pat = w[++k];
        if (!not && (pat.includes(".git") || segMatch(pat, ".git"))) names = true;
        if (narrows(x, pat, not)) alt = any = true;
      } else if (x === "-prune") prunes = true;
      else if (x === "-delete") { acted = true; safe &&= alt; }
      else if (FIND_EXEC.test(x)) {
        let e = k + 1;
        while (e < w.length && !FIND_END.test(w[e])) e++;
        if (execDeletes(w.slice(k + 1, e))) { acted = true; safe &&= alt; }
        k = e;
      }
      not = false;
    }
    close();
    return [safe, all];
  };
  const [safe] = group(false);
  return acted ? safe : any;
}

const wideFind = (q, r) => (Boolean(r.repo) && (under(r.repo, q) || under(`${r.repo}/.claude`, q))) || nsNames(q, r).length > 0;
const wideFindReason = (t) => `refusing a find delete from the repository or its .claude folder (${t}) without a name, path or regex test that leaves .git and the user's night-shift settings and rules out: it would take them with it`;

// One target of a delete or a move, as the shell hands it over (variables filled in). o.recursive: it takes
// a whole tree; o.noun: what the reason calls it ("move"); o.find: the target is a find's word ({ expr: its
// tests have begun, narrowed(q): they keep it out of .git }).
function targetReason(t, o, where, r) {
  const { recursive = false, find = null } = o;
  const noun = o.noun ?? (recursive ? "recursive delete" : "delete"), act = o.noun ?? "delete";
  // ~name is that user's home folder.
  if (/^~[\w.-]*([\\/]|$)/.test(t)) return `refusing a ${noun} in the home folder ("${t}")`;
  // A .* can match .. and the dot folders (.git).
  if (recursive && (/^(\.|\.\/|\*|\.\/\*|\/|\.git|\.git\/.*)$/.test(t) || /(^|[\\/])\.\.([\\/]|$)/.test(t) || /(^|[\\/])\.\*$/.test(t))) return `refusing a recursive delete of "${t}"`;
  // A {a,b} list left after the rounds of braces() is any paths the shell makes of it.
  if (BRACE.test(t)) return `refusing a ${noun} of "${t}"`;
  const abs = isAbsolute(t);
  if (!abs && where.lost) return o.noun ? null : `refusing a delete after a cd the guard cannot follow: it cannot tell which folder "${t}" is in`;
  if (!abs && !where.at) return oddReason(norm(t), t);
  const p = norm(abs ? t : `${where.at}/${t}`);
  const odd = oddReason(p, t);
  if (odd) return odd;
  // dir/* empties dir: the folders and roots are compared as dir (the wildcard check below keeps p).
  const q = p.replace(/\/\*$/, "");
  if (r.repo && under(q, `${r.repo}/.git`)) return `refusing a ${act} inside .git (${t})`;
  if ((recursive || o.noun) && r.repo && q === r.repo) return `refusing a ${noun} of the repository (${t})`;
  const prot = protectedPath(q, r);
  if (prot) return `refusing a ${act} of ${prot} (${t})`;
  // The state folder itself, or a folder above it, takes the runner's files and the handover with it.
  if (r.state && under(r.state, q)) return `refusing a ${act} of the run's state folder (${t})`;
  if (!find?.expr && GLOB.test(p)) {
    const hit = protectedTargets(r).find(([c]) => overlaps(p, c));
    if (hit) return `refusing a ${act} of ${hit[1]} through a wildcard (${t})`;
  }
  // A recursive delete or a move of a folder takes what is inside along: one that is, or holds, another protected place
  // (the skill's copy, the installed plugins, the project's .claude) is refused too. A find, and a listing a PowerShell
  // pipeline filters, are read by their tests instead (below): from the repository they would meet .git every time.
  const holds = (recursive || o.noun) && !find && protectedTargets(r).find(([c]) => under(c, q));
  if (holds) return `refusing a ${act} of ${holds[0] === q ? "" : "a folder that holds "}${holds[1]} (${t})`;
  if (find && !find.expr && wideFind(q, r) && !find.narrowed(q)) return wideFindReason(t);
  // A find from a temp root itself empties the folder every program shares.
  if (find && !find.expr && q !== r.repo && r.writable.includes(q) && !find.narrowed(q)) return `refusing a find delete from the temp folder itself (${t}) without a name, path or regex test`;
  if (!r.writable.some((root) => under(q, root) && !(recursive && q === root))) return `${noun}s are limited to the repository and temp folders (got ${t})`;
  return null;
}

// PowerShell hands a delete its targets through the pipeline: `gci x | Remove-Item`, `gci x | % { Remove-Item $_.FullName }`.
// The listing at the head of the line says which they are: the paths it names, whether it goes down the tree,
// and the name patterns it keeps. Any other head (a variable, Get-Content) is not known: null.
const LISTER = /^(get-childitem|gci|ls|dir|get-item|gi|resolve-path|rvpa)$/;
const PS_FILTER = /^(where-object|where|\?|sort-object|sort|select-object|select|get-unique|gu)$/;
function listed(line, vars, env) {
  const head = line[0]?.words ?? [], k = nameIndex(head);
  if (k < 0 || !LISTER.test(base(head[k])) || !line.slice(1).every((c) => PS_FILTER.test(base(c.words[0] ?? "")))) return null;
  // `a, b` and `a,b` are one list.
  const a = [];
  for (const w of head.slice(k + 1)) { if (a.length && (/,$/.test(a.at(-1)) || /^,/.test(w))) a[a.length - 1] += w; else a.push(w); }
  const paths = [], pats = [], items = (v) => String(v ?? "").split(",").filter(Boolean);
  let recurse = false, pos = 0;
  for (let i = 0; i < a.length; i++) {
    const m = /^-([A-Za-z]+)(?:[:=](.*))?$/s.exec(a[i]);
    if (!m) { (pos++ === 0 ? paths : pats).push(...items(a[i])); continue; }
    const n = m[1].toLowerCase(), value = () => m[2] ?? a[++i];
    if (PATH_PARAM(n)) paths.push(...items(value()));
    else if ((n.length > 3 && "filter".startsWith(n)) || (n.length > 2 && "include".startsWith(n))) pats.push(...items(value()));
    else if ("recurse".startsWith(n) || n === "s") recurse = true;
    else if (n.length > 1 && "depth".startsWith(n)) { recurse = true; if (m[2] == null) i++; }
    else if (m[2] == null && (valueParam(a[i]) || (n.length > 1 && "attributes".startsWith(n)))) i++;
  }
  const real = (paths.length ? paths : ["."]).map((p) => expand(p, vars, env));
  if (real.includes(null)) return null;
  return {
    paths: real, pats: pats.map(unmark), recurse,
    where: line.slice(1).some((c) => /^(where-object|where|\?)$/.test(base(c.words[0]))),
    item: /^(get-item|gi|resolve-path|rvpa)$/.test(base(head[k])),
  };
}
// The delete at the end of such a line, judged by what the listing can hand it. A Where-Object is a test the
// guard does not read: it counts as narrowing, like a -Filter that cannot match inside .git.
function listedReason(src, recursive, where, r) {
  for (const p of src.paths) {
    const q0 = isAbsolute(p) ? norm(p) : where.at && !where.lost ? norm(`${where.at}/${p}`) : null;
    const extra = q0 ? nsNames(q0, r) : [];
    const narrowed = src.where || (src.pats.length > 0 && src.pats.every((x) => !/[$`]/.test(x) && !meetsInside(x.toLowerCase(), extra)));
    let targets = [p], rec = recursive;
    if (src.item) targets = [p];
    else if (src.recurse && !narrowed) {
      // Everything below the path, like `find path -delete`.
      const q = isAbsolute(p) ? norm(p) : where.at && !where.lost ? norm(`${where.at}/${p}`) : null;
      if (q && wideFind(q, r)) return `refusing a delete of everything listed below the repository or its .claude folder (${p}) without a -Filter or -Include that leaves .git out: it would take .git with it`;
      rec = true;
    } else if (src.pats.length) { targets = src.pats.map((x) => `${p}/${x}`); if (src.recurse) rec = false; }
    else if (src.where || src.recurse) rec = false;
    else targets = [`${p}/*`];
    for (const t of targets) { const why = targetReason(t, { recursive: rec }, where, r); if (why) return why; }
  }
  return null;
}

// Deletes: a recursive one anywhere in a simple command, and a plain one (rm, del, Remove-Item,
// unlink, find -delete) where it is the command. where.at is the folder the command stands in
// (the hook's cwd, moved by each cd before it), so a relative target is read from where the delete
// stands (`cd /c/Users/u && rm -rf Documents` passed until 2026-11-15).
function checkDelete(words, ni, env, where, vars, r, line) {
  const text = words.join(" ");
  if (!RECURSIVE_DELETE.test(text) && !ANY_DELETE.test(text)) return null;
  const name = words[ni];
  // find's own tests (-name "*.tmp") follow its first -option: patterns, not targets.
  const isFind = /find(\.exe)?$/i.test(name);
  // What a find -exec runs is read as a command of its own: its `rm -rf {}` takes what the find matched,
  // so the find's start paths are held to its tests and not counted as trees deleted whole.
  const cut = isFind ? words.findIndex((w) => FIND_EXEC.test(w)) : -1;
  const recursive = RECURSIVE_DELETE.test(cut < 0 ? text : words.slice(0, cut).join(" "));
  const plain = !recursive && DELETE_WORD.test(name) && (!isFind || words.includes("-delete") || findExecDeletes(words));
  if (!recursive && !plain) return null;
  const find = () => ({ expr, narrowed: (q) => findNarrowed(words, q, nsNames(q, r)) });
  let expr = false, dNext = false, seen = 0, skip = false, starts = 0, prev = "";
  // Its targets come after the delete's own word, a {a,b} list as the paths it stands for.
  const list = words.slice(words.findIndex((w) => DELETE_WORD.test(w)) + 1);
  for (let raw of list.flatMap((w) => braces(w))) {
    if (isFind && FIND_EXEC.test(raw)) break;
    const before = prev;
    prev = raw;
    // PowerShell's -Path:x and -LiteralPath=x name their target in the same word; any other -Name:value
    // (-Confirm:$false) is a switch with its value, no target.
    const pv = /^-(\w+)[:=](.+)$/s.exec(raw);
    if (pv && !PATH_PARAM(pv[1])) continue;
    if (pv) raw = pv[2];
    const t = expand(raw, vars, env);
    if (t === null) {
      // `for f in *.tmp; do rm "$f"; done` is everyday work; a tree deleted through an unknown path is not.
      if (!recursive) continue;
      return `refusing a recursive delete through a variable path that cannot be resolved (${unmark(raw)})`;
    }
    if (isFind && !expr) {
      // find's leading options (-H -L -P -Olevel -D opts) come before its paths: the paths are still targets.
      if (dNext) { dNext = false; continue; }
      if (t === "-D") dNext = true;
      else if (!/^-([HLP]|O\d*|D\S+)$/.test(t) && /^([-(!]|\\[(!])/.test(t)) expr = true;
    }
    // find's own ( ) and ! are no paths, written bare or with the backslash bash needs.
    if (isFind && expr && /^\\?[()!]$/.test(t)) continue;
    if (/^-/.test(t) || /^\/[sqfa]$/i.test(t) || /^(\/dev\/null|nul)$/i.test(t)) { skip = valueParam(t); continue; }
    // The pattern of a name, path or regex test is no target (-not -path './.git/*').
    if (isFind && expr && NAME_TEST.test(before)) continue;
    // The value of -Include or -ErrorAction is no folder to delete, so it does not count as a target.
    if (!skip) seen++;
    skip = false;
    if (isFind && !expr) starts++;
    const why = targetReason(t, { recursive, find: isFind ? find() : null }, where, r);
    if (why) return why;
  }
  // find's start path defaults to the folder it stands in.
  if (isFind && !starts) return targetReason(".", { recursive, find: { expr: false, narrowed: find().narrowed } }, where, r);
  if (!isFind && !seen) {
    // `gci x | ri -Recurse` takes its targets from the listing before it; a backtick substitution, or a
    // variable at the head of the line, from where the command does not show them.
    const src = line ? listed(line, vars, env) : null;
    if (src) return listedReason(src, recursive, where, r);
    if (recursive) return "refusing a recursive delete whose target the guard cannot see";
  }
  return null;
}

// Every Bash/PowerShell rule for one simple command. A wrapper (bash -c, powershell -c, cmd /c,
// eval, find -exec) hands its inner command to checkCommand again, so the rules read what is run
// and not the wrapper's words.
function readCommand(c, pipe, sawPipe, prev, env, where, opts, depth, r, tmp, line) {
  const { vars } = opts;
  // The splitter cannot see "$(...)" inside quotes; each one is a command of its own.
  for (const w of c.words) for (const body of substitutions(w)) {
    const why = checkCommand(body, env, { ...where }, opts, depth + 1);
    if (why) return why;
  }
  recordAssignments(c.words, vars, env, tmp);
  // PowerShell's `$env:NAME = x` and cmd's `set NAME=x` change the environment of the git after them;
  // kept apart from the shell variables (a key no $NAME can match) and read by the git check below.
  const pe = /^\$env:(\w+)/i.exec(c.words[0]) ?? (/^set$/i.test(c.words[0]) ? /^(\w+)=/.exec(c.words[1] ?? "") : null);
  if (pe) {
    // The value is kept for the git check: some variables are command lines.
    const set = /^set$/i.test(c.words[0]), w0 = c.words[0];
    vars.set(`${set ? "set:" : "$env:"}${pe[1]}`, set ? c.words.slice(1).join(" ").replace(/^\w+=/, "") : w0.includes("=") ? w0.replace(/^[^=]*=/, "") : c.words[1] === "=" ? c.words.slice(2).join(" ") : "");
  }
  const { args, argBare, writes, here, input } = splitRedirects(c);
  for (const t of writes) { const why = writeDenial(t, env, where, vars, r); if (why) return why; }
  let ni = nameIndex(args);
  if (ni < 0) return null;
  // A name that is a variable can be any command; a PowerShell $x alone is an expression, only `& $x` runs it.
  // A variable in the folder part ($HOME/bin/tool) leaves the command itself in view.
  if (args[ni].includes("$") && !(opts.ps && !/&$/.test(c.sep))) {
    const v = expand(args[ni], vars, env);
    if (v === null) { if (base(args[ni]).includes("$")) return "a command named by a variable cannot be read"; }
    else {
      const parts = v.split(/\s+/).filter(Boolean);
      args.splice(ni, 1, ...parts);
      argBare.splice(ni, 1, ...parts.map(() => true));
      if (ni >= args.length) return null;
    }
  }
  const nm = base(args[ni]), rest = args.slice(ni + 1), restBare = argBare.slice(ni + 1);
  if (POP_WORD.test(nm)) { where.lost = true; return null; }
  if (CD_WORD.test(nm)) {
    const arg = rest.find((w) => !/^-/.test(w) && !/^\/d$/i.test(w));
    const to = arg == null ? null : expand(arg, vars, env);
    if (!to || /^[~-]/.test(to)) where.lost = true;
    else if (isAbsolute(to)) { where.at = norm(to); where.lost = false; }
    else if (where.at) where.at = norm(`${where.at}/${to}`);
    return null;
  }
  if (SHELL_NAME.test(nm)) {
    const s = shellArgs(nm, rest);
    if (s.encoded) return "an encoded command cannot be read";
    const scripts = [...(s.script != null && s.script !== "-" ? [s.script] : []), ...here];
    for (const sc of scripts) {
      // A new shell starts with the session's environment only, not this command's variables.
      const why = checkCommand(scriptText(sc, vars, env), env, { ...where }, { ...opts, vars: new Map(), ps: nm === "pwsh" || nm === "powershell" }, depth + 1);
      if (why) return why;
    }
    if (scripts.length) return null;
    if (!s.file && !input) {
      // No script word and no file: it reads commands from its input. A pipe's here-document body is already read.
      const fed = pipe ? !(prev && prev.words.some((w, k) => prev.bare[k] && /^<<(?!<)/.test(w))) : sawPipe;
      if (fed) return "a shell fed through a pipe cannot be read";
    }
  }
  // su and runuser hand their -c word to the user's shell.
  if (/^(su|runuser)$/.test(nm)) {
    const k = rest.findIndex((w) => /^(-c|--command|--session-command)$/.test(w));
    const sc = k >= 0 ? rest[k + 1] : rest.map((w) => /^--(?:session-)?command=(.*)$/s.exec(w)?.[1]).find((v) => v != null);
    const why = sc == null ? null : checkCommand(scriptText(sc, vars, env), env, { ...where }, { ...opts, vars: new Map(), ps: false }, depth + 1);
    if (why) return why;
  }
  // eval runs its words in this shell, so what it cd's and sets carries on.
  if (/^(eval|iex|invoke-expression)$/.test(nm)) {
    const script = rest.join(" ").trim();
    if (!script) return null;
    // A substitution that only echoes is the script itself; what any other tool prints cannot be read beforehand.
    return isSubstitution(script) ? checkEchoed(script, env, where, opts, depth) : checkCommand(scriptText(script, vars, env), env, where, opts, depth + 1);
  }
  if (nm === "find") {
    for (let k = 0; k < rest.length; k++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(rest[k])) continue;
      let e = k + 1;
      while (e < rest.length && !/^(\\?;|\\|\+)$/.test(rest[e])) e++;
      const inner = rest.slice(k + 1, e);
      const why = walk([{ words: inner, bare: inner.map(() => false), sep: "", lvl: 0 }], env, { ...where }, { ...opts, vars: new Map() }, depth + 1);
      if (why) return why;
      k = e;
    }
  }
  if (nm === "xargs") {
    let j = 0;
    while (j < rest.length && /^-/.test(rest[j]) && rest[j] !== "--") j += XARGS_VALUE.test(rest[j]) ? 2 : 1;
    if (rest[j] === "--") j++;
    const k = nameIndex(rest.slice(j));
    const cmd = k < 0 ? "" : rest[j + k];
    if (cmd && base(cmd) === "git") {
      // xargs puts the names it reads after the words it is given. That is fine for a git command that only
      // reads, and for one that takes them as paths after a closing `--`; with -I they go anywhere.
      const gw = rest.slice(j + k + 1), sub = gw[gitGlobals(gw).sub] ?? "";
      const anywhere = rest.slice(0, j).some((w) => /^(-[iI]|--replace)/.test(w));
      const fits = XARGS_GIT_READS.test(sub) || (!anywhere && gw.at(-1) === "--" && XARGS_GIT_PATHS.test(sub));
      if (k > 0 || !fits || gitRule(gitWords(gw, vars, env), { env, where, opts, depth })) return "xargs builds a command the guard cannot read";
    } else if (cmd && (DELETE_WORD.test(cmd) || base(cmd) === "xargs" || SHELL_NAME.test(base(cmd)))) return "xargs builds a command the guard cannot read";
  }
  // Git reads GIT_CONFIG_* the way it reads -c: a variable can define an alias too. `git-push` and the
  // like are the same commands under their dashed names.
  if (nm === "git" || nm.startsWith("git-")) {
    if (args.slice(0, ni).some((w) => GIT_ENV_VAR.test(w)) || [...vars.keys()].some((k) => GIT_ENV_VAR.test(k))) return "git is not pointed at other config or another repository during a night run";
    const env2 = gitEnvReason(args.slice(0, ni), vars, env, where, opts, depth);
    if (env2) return env2;
    const why = gitRule(gitWords(nm === "git" ? rest : [nm.slice(4), ...rest], vars, env, nm === "git" ? restBare : [true, ...restBare]), { env, where, opts, depth });
    if (why) return why;
  }
  if (nm !== "git" && !PRINTS.test(nm)) {
    const joined = args.map(txt).join(" ");
    for (const [re, reason] of GENERIC) if (re.test(joined)) return reason;
  }
  for (const t of writeTargets(nm, rest)) { const why = writeDenial(t, env, where, vars, r); if (why) return why; }
  if (MOVERS.test(nm)) {
    // A source that is a variable is not known until the shell fills it in (`mv "$f" "$f.bak"` in a loop).
    for (const s of moveSources(rest).flatMap((w) => braces(w))) {
      const t = expand(s, vars, env);
      const why = t === null ? null : targetReason(t, { noun: "move" }, where, r);
      if (why) return why;
    }
  }
  if (PRINTS.test(nm)) return null;
  // A launcher the walker does not read (wsl, ssh, docker exec, call, flock, a PowerShell block):
  // wherever a word is git, the words after it are git's.
  if (nm !== "git" && !nm.startsWith("git-")) {
    for (let k = ni + 1; k < args.length; k++) {
      if (base(args[k]) !== "git") continue;
      if (args.slice(ni + 1, k).some((w) => w.includes("=") && GIT_ENV_VAR.test(w))) return "git is not pointed at other config or another repository during a night run";
      const why = gitRule(gitWords(args.slice(k + 1), vars, env, argBare.slice(k + 1)), { env, where, opts, depth });
      if (why) return why;
    }
  }
  // `gci x | % { Remove-Item $_.FullName }`: the block deletes what the listing hands it.
  if (line?.length && /^(%|foreach|foreach-object)$/.test(nm) && rest.some((w) => DELETING.test(base(w)) || /^\$(_|psitem)\.delete$/i.test(w))) {
    const src = listed(line, vars, env);
    const why = src && listedReason(src, RECURSIVE_DELETE.test(args.join(" ")), where, r);
    if (why) return why;
  }
  // Of git only `git rm` deletes; a commit message that mentions `rm -rf` is text.
  if (nm === "git") {
    if (rest[gitGlobals(rest).sub] !== "rm") return null;
  }
  return checkDelete(nm === "node" ? withoutInlineScript(args, ni) : args, ni, env, where, vars, r, line);
}
// node's inline script (-e, -p, --eval, --print, or -pe) is one word of JavaScript: text in it such as
// `'rm -rf a:b'` names no delete target. The shell still runs a $(...) in it first (read above), and the
// redirects, pipes and words around it are read as usual. node's options come before its script, so the
// first word that is no option (a script file, or an option's value) ends the search; the words after the
// inline script are its argv, still read.
const NODE_INLINE = /^(-[ep]|-pe|-ep|--eval|--print)$/;
function withoutInlineScript(args, ni) {
  for (let k = ni + 1; k < args.length; k++) {
    const w = args[k];
    if (/^--(eval|print)=/.test(w)) return [...args.slice(0, k), ...args.slice(k + 1)];
    if (NODE_INLINE.test(w)) return [...args.slice(0, k + 1), ...args.slice(k + 2)];
    if (!w.startsWith("-")) return args;
  }
  return args;
}

// where is put back to a copy of it (keys a later cd added are dropped too).
const setWhere = (where, to) => { for (const k of Object.keys(where)) delete where[k]; Object.assign(where, to); };
// bash runs a command before a lone & in the background, and each part of a pipeline in a subshell of its own:
// a cd there does not move the commands after it. PowerShell's & is the call operator and its pipeline shares the session.
const background = (sep) => /(^|[^&|])&$/.test(sep);
const continues = (sep) => /(&&|\|\|)$/.test(sep) || isPipe(sep);
// A { } group, an if, a loop or a case is one command for the & or the pipeline around it. How many of them a
// simple command opens: the keywords before its own name (`else if x`, `then {`).
const GROUP_OPEN = /^(\{|if|while|until|for|case|select)$/, GROUP_CLOSE = /^(\}|fi|done|esac)$/;
function opens(c) {
  let n = 0;
  for (let k = 0; k < c.words.length && c.bare[k]; k++) {
    if (GROUP_OPEN.test(c.words[k])) { n++; if (/^(for|case|select)$/.test(c.words[k])) break; }
    else if (!/^(then|else|elif|do|!|time)$/.test(c.words[k])) break;
  }
  return n;
}

function walk(cmds, env, where, opts, depth) {
  if (depth > 4) return NESTED;
  const r = roots(env), saved = [], groups = [];
  // line: the commands of the pipeline so far (PowerShell hands a delete its targets through it).
  let lvl = 0, sawPipe = false, prev = null, listStart = { ...where }, line = [];
  for (const [i, c] of cmds.entries()) {
    // A cd inside ( ) lasts until the ), so the folder it left is put back there.
    while (lvl < c.lvl) { saved.push({ ...where }); lvl++; }
    while (lvl > c.lvl) { setWhere(where, saved.pop()); lvl--; }
    // The whole && / || list before a lone & ran in the background: back to where it started.
    if (!opts.ps && background(c.sep)) setWhere(where, listStart);
    if (!continues(c.sep)) listStart = { ...where };
    const pipe = isPipe(c.sep);
    if (!pipe) line = [];
    // The splitter cuts `(Get-Item x).Delete($true)` at its (: a .Delete method given $true removes a folder and what it holds.
    const nx = cmds[i + 1];
    if (/\.Delete$/i.test(c.words.at(-1)) && !PRINTS.test(base(c.words[0])) && nx?.pre === "(" && /^\$true$/i.test(nx.words[0])) return "deletes through .NET cannot be checked";
    const before = { ...where };
    // What a group cd's lasts for the commands inside it, whatever feeds it. At its end the folder goes back
    // when the group was a part of a pipeline (a subshell), and the list around it starts where it did before
    // the group (a lone & after it puts the whole of it in the background).
    const opened = opts.ps ? 0 : opens(c);
    for (let n = 0; n < opened; n++) groups.push({ at: before, list: { ...listStart }, sub: pipe });
    const why = readCommand(c, pipe, sawPipe, prev, env, where, opts, depth, r, mktempAfter(cmds, i), opts.ps ? line : null);
    if (why) return why;
    if (!opts.ps && ((pipe && !opened) || isPipe(nx?.sep ?? ""))) setWhere(where, before);
    if (!opts.ps && c.bare[0] && GROUP_CLOSE.test(c.words[0]) && groups.length) {
      const g = groups.pop();
      listStart = g.list;
      if (g.sub || isPipe(nx?.sep ?? "")) setWhere(where, g.at);
    }
    sawPipe ||= pipe; prev = c; line.push(c);
  }
  return null;
}

// Every Bash/PowerShell rule for one command string; where is the folder it starts in ({ at, lost }:
// lost once a cd could not be followed). decide calls it once, a wrapper calls it for the command it runs.
export function checkCommand(cmd, env, where, opts = {}, depth = 0) {
  if (depth > 4) return NESTED;
  // A line continued on the next (a trailing backslash, or PowerShell's backtick) is one line. This runs
  // after the here-documents are cut, so a body line ending in a backslash cannot swallow its delimiter.
  const text = dropHeredocs(String(cmd)).replace(/[\\`]\r?\n/g, " ");
  const cmds = simpleCommands(text, opts.ps);
  // A line with a backslash before an ordinary character is read twice: as written, and as bash reads it.
  const again = cmds.soft ? [{ ...where }, new Map(opts.vars ?? [])] : null;
  const why = walk(cmds, env, where, { ...opts, vars: opts.vars ?? new Map() }, depth);
  if (why || !again) return why;
  return walk(simpleCommands(text, opts.ps, true), env, again[0], { ...opts, vars: again[1] }, depth);
}

// The project's deny rules. A file that does not validate yields an error instead: a rule that
// cannot be read must not silently stop refusing, so decide refuses every shell command.
function projectRules(env) {
  if (!env.NIGHT_SHIFT_REPO) return { rules: [] };
  const { config, errors } = readProjectConfig(env.NIGHT_SHIFT_REPO);
  if (errors.length) return { error: errors[0] };
  return { rules: (config.deny || []).map((d) => [new RegExp(d.pattern, d.flags ?? "i"), d.reason ?? `refused by a project rule (${d.pattern})`]) };
}

// opts.platform: the system whose path rules judge the call (platform.mjs), the live one when none is given.
export function decide(input, env = process.env, opts = {}) {
  const outer = P;
  P = opts.platform || live;
  try { return decideOn(input, env, opts); } finally { P = outer; }
}

function decideOn(input, env, opts) {
  const tool = input.tool_name;
  // Empty or unrecognisable input is not a call the guard may wave through.
  if (typeof tool !== "string" || !tool) return "the hook input names no tool, so the guard cannot check the call";
  const ti = input.tool_input || {};
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = ti.file_path || ti.notebook_path;
    const { rules, error } = projectRules(env);
    if (error) return `.claude/night-shift.json is invalid (${error}); the user must fix it`;
    // The project's rules read the path with forward slashes, as given and as the system resolves it (norm, in
    // lower case where it folds), each from the repository down too. An MSYS /c/ is read as c:/ to line it up with the repository.
    const given = String(file ?? "").replace(/\\/g, "/"), p = norm(given), repo = roots(env).repo;
    const lined = given.replace(/^\/([a-z])(?=\/)/i, "$1:"), forms = [given, p];
    if (repo && p.startsWith(repo + "/")) {
      forms.push(p.slice(repo.length + 1));
      if (P.fold(lined).startsWith(repo + "/")) forms.push(lined.slice(repo.length + 1));
    }
    // lastIndex goes back to 0 for each form: a rule with the g or y flag keeps its place between tests.
    for (const [re, reason] of rules) if (forms.some((f) => { re.lastIndex = 0; return re.test(f); })) return reason;
    return checkWrite(file, env);
  }
  if (typeof tool === "string" && tool.startsWith("mcp__")) {
    // A server the project did not name may do anything its tools do, outside every rule here.
    const { config, errors } = env.NIGHT_SHIFT_REPO ? readProjectConfig(env.NIGHT_SHIFT_REPO) : { config: {}, errors: [] };
    if (errors.length) return `.claude/night-shift.json is invalid (${errors[0]}); the user must fix it`;
    const mode = config.mcp ?? "none", server = tool.slice(5, Math.max(5, tool.lastIndexOf("__")));
    // A listed name in the tools' spelling: "plugin:x:y", as `claude mcp list` shows a plugin's server, names tools mcp__plugin_x_y__….
    if (mode === "inherit" || (Array.isArray(mode) && mode.some((s) => mcpToolName(s) === server))) return null;
    return `MCP tools are off in a night run (server "${server}"); the user allows one with "mcp": ["${server}"] in .claude/night-shift.json`;
  }
  if (tool === "Bash" || tool === "PowerShell") {
    const raw = String(ti.command || "");
    const { rules, error } = projectRules(env);
    if (error) return `.claude/night-shift.json is invalid (${error}); the user must fix it`;
    // The project's own rules read the whole command as written (a line continued on the next is one line).
    const cmd = raw.replace(/[\\`]\r?\n/g, " ");
    for (const [re, reason] of rules) if (re.test(cmd)) return reason;
    // cwd is where the hook says the command starts; without one it starts in the repository.
    return checkCommand(raw, env, { at: norm(input.cwd || "") || roots(env).repo, lost: false }, { ...opts, ps: tool === "PowerShell" });
  }
  return null;
}

// The self-test's cases for a home whose .claude is a link: a home in the temp folder with a junction
// to the folder lt, and the files the guard protects named by lt. The folder goes even when a case throws.
// They make a real link, so they run under the live system, with the home in HOME beside USERPROFILE.
function linkedCases(env, bash, write) {
  const base = mkdtempSync(join(tempRoot(), "night-guard-self-test-"));
  try {
    mkdirSync(join(base, "home"));
    mkdirSync(join(base, "folder"));
    symlinkSync(join(base, "folder"), join(base, "home", ".claude"), "junction");
    const lt = join(base, "folder").replace(/\\/g, "/");
    const linked = { ...env, USERPROFILE: join(base, "home"), HOME: join(base, "home") }, linkedRepo = { ...linked, NIGHT_SHIFT_REPO: lt };
    // The home known only by HOME: on Windows Git Bash's (/c/Users/u), with no USERPROFILE.
    const msys = { ...env, USERPROFILE: undefined, HOME: join(base, "home").replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`) };
    return [
      [bash(`echo x > "${lt}/settings.json"`, msys), true],
      [bash(`echo x > "${lt}/settings.json"`, linked), true], [bash(`echo x >> "${lt}/CLAUDE.md"`, linked), true],
      [bash(`cp a.mjs "${lt}/skills/night-shift/scripts/guard.mjs"`, linked), true], [bash(`echo x > "${lt}/notes.md"`, linked), false],
      [write(`${lt}/night-shift/rules.md`, linkedRepo), true], [write(`${lt}/notes.md`, linkedRepo), false],
      [bash(`rm -f "${lt}"/settings.*`, linkedRepo), true], [bash("find . -name rules.md -delete", linkedRepo), true],
      [bash(`cp a.mjs "${lt}/plugins/cache/m/x.mjs"`, linked), true], [bash(`echo x > "${lt}/plugins/data/p/x.json"`, linked), false],
    ];
  } finally { rmSync(base, { recursive: true, force: true }); }
}

function selfTest() {
  // The Windows-shaped cases are judged by Windows' path rules on every system: a win32 object with a Windows home and
  // temp folder and no links. A few cases follow under Linux's rules (penv), and the linked-home ones under the live system.
  const noLink = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
  const WIN = platformFor("win32", { tmpdir: () => "C:\\Users\\u\\AppData\\Local\\Temp", homedir: () => "C:\\Users\\u", realpath: noLink });
  const LINUX = platformFor("linux", { tmpdir: () => "/tmp", homedir: () => "/home/u", realpath: noLink });
  const env = { NIGHT_SHIFT_REPO: "C:/work/repo", NIGHT_SHIFT_STATE: "C:/temp/x-night", USERPROFILE: "C:\\Users\\u" };
  const penv = { NIGHT_SHIFT_REPO: "/work/repo", NIGHT_SHIFT_STATE: "/tmp/x-night", HOME: "/home/u" };
  // inHome: the run's repository is the user's own .claude folder.
  const inHome = { ...env, NIGHT_SHIFT_REPO: "C:/Users/u/.claude" };
  const call = (tool_name, tool_input, e, platform) => decide({ tool_name, tool_input }, e, { platform });
  const bash = (command, e = env, platform = WIN) => call("Bash", { command }, e, platform);
  const ps = (command, e = env) => call("PowerShell", { command }, e, WIN);
  const write = (file_path, e = env, platform = WIN) => call("Write", { file_path }, e, platform);
  const mcp = (tool_name) => call(tool_name, {}, env, WIN);
  const skill = (dir) => ({ ...env, NIGHT_SHIFT_SKILL: dir });
  const lbash = (command) => bash(command, penv, LINUX), lwrite = (file_path) => write(file_path, penv, LINUX);
  const cases = [
    [mcp("mcp__blender__execute_blender_code"), true],
    [bash("git push --force origin master"), true], [bash("git push -f"), true], [bash("git push origin :old"), true],
    [bash("git push origin master"), false], [bash("git push"), false],
    [bash("git reset --hard HEAD~1"), true], [bash("git reset HEAD file"), false],
    [bash("git rebase -i HEAD~3"), true], [bash("git commit --amend -m x"), true], [bash("git commit -m 'amend docs'"), false],
    [bash("git branch -D night"), true], [bash("git branch --show-current"), false],
    [bash("git merge cloud/min-window"), true], [bash("git merge-base HEAD origin/master"), false],
    [bash("git pull"), true], [bash("git pull --ff-only"), false], [bash("git clean -fdx"), true],
    [bash(`git commit -m "ui: merge pets tab, pull fix"`), false], [bash(`git add -A && git commit -m 'docs: reset --hard note'`), false],
    [bash("gh pr merge 3"), true], [bash("gh pr list"), false], [bash("npm publish"), true], [bash("npm run build"), false],
    [bash("reg add HKCU\\Control\\ Panel\\Cursors /v Arrow"), true], [bash("reg query HKCU\\Software"), false],
    [bash("taskkill /IM node.exe /F"), true], [bash("Stop-Process -Name explorer"), true],
    [bash("rm -rf /c/Users/u/Documents"), true], [bash("rm -rf C:/temp/demo-app-shots-1"), false],
    [bash("rm -rf C:/temp"), true], [bash("rm -rf ."), true], [bash("rm -rf dist"), false], [bash("rm -rf ~/x"), true],
    [bash("rm -rf C:/work/repo/.superpowers/sdd/old"), false], [bash("rm -rf C:/work/repo"), true],
    [bash("Remove-Item -Recurse -Force $env:APPDATA\\x"), true], [bash("rm file.txt"), false],
    [write("C:/work/repo/src/a.ts"), false], [write("C:\\temp\\x\\a.md"), false], [write("/c/temp/x-night/next-prompt.md"), false],
    [write("C:/Users/u/.claude/projects/p/memory/a.md"), false], [write("C:/Users/u/.claude/CLAUDE.md"), true],
    [write("C:/Users/u/.claude/skills/night-shift/SKILL.md"), true], [write("C:/work/repo/.claude/settings.json"), true],
    [write("C:/work/repo/.claude/night-shift.json"), true], [write("C:/Users/u/Desktop/a.txt"), true],
    [write("C:/work/repo/.git/config"), true],
    // The 2026-11-15 review: the runner's own files, a path through .., a delete after a cd, quoted and joined flags.
    [write("C:/temp/x-night/night-settings.json"), true], [write("C:/temp/x-night/run.json"), true],
    [write("C:/temp/x-night/limits.json"), true], [bash("echo {} > C:/temp/x-night/wait.json"), true], [bash("rm -f C:/temp/x-night/STOP-REQUEST"), true],
    [write("C:/temp/x-night/questions.md"), false], [bash("git push -uo ci:skip origin night"), false],
    [write("C:/temp/../Users/u/.claude/skills/night-shift/scripts/guard.mjs"), true], [write("C:/work/repo/.claude/settings.json."), true],
    [bash("cd /c/Users/u && rm -rf Documents"), true], [bash("cd app && rm -rf dist"), false],
    [bash(`cd "/c/Users/u/R\u00e9sum\u00e9s/My Game/.." && rm -rf Documents`), true], [bash(`cd "/c/temp/R\u00e9sum\u00e9s/My Game/.." && rm -rf old`), false],
    [bash("Remove-Item -r -fo C:\\Users\\u\\Documents"), true], [bash("Remove-Item -Recurse ~\\Documents"), true],
    [bash("rm -f /c/Users/u/Documents/a.docx"), true], [bash("rm -f src/old.ts"), false],
    [bash(`git push "--force" origin main`), true], [bash("git push -uf origin main"), true], [bash("git push -u origin night"), false],
    [bash("git checkout -- ."), true], [bash("git checkout -- src/a.ts"), false], [bash("git restore ."), true],
    // Stream and short names, the state folder, the memory exception.
    [write("C:/work/repo/src/a.ts:hidden"), true], [write("C:/work/repo/.claude/SETTIN~1.JSO"), true], [write("C:/work/repo/src/a~b.ts"), false],
    [bash("rm -rf C:/temp/x-night"), true], [bash("rm -f C:/temp/x-night/run.json"), true], [bash("rm -f C:/temp/x-night/scratch.txt"), false],
    [write("C:/Users/u/Documents/.claude/projects/p/memory/a.txt"), true],
    [bash("rm -f C:/temp/x-night/run.*"), true], [bash("rm -f C:/work/repo/.cl*/settings.json"), true], [bash("rm -rf dist/*"), false],
    [bash("gh api --method=DELETE repos/o/r"), true], [bash("gh api repos/o/r/issues -f title=x"), true], [bash("gh api repos/o/r/pulls"), false],
    // The command a wrapper runs, a shell fed by a pipe, a write by redirect.
    [bash("bash -c 'git push --force origin main'"), true], [bash("powershell -c \"Remove-Item -Recurse C:\\Users\\u\\Documents\""), true],
    [bash("echo x | bash"), true], [bash("echo x | xargs rm -rf"), true], [bash("echo hi > C:/temp/x-night/run.json"), true],
    [bash("rm -rf src/.*"), true], [bash("rm -rf {/c/Users/u/Documents,x}"), true], [bash("rm -rf /c/temp/*"), true], [bash("rm -rf `cat list.txt`"), true],
    [bash(`D=$(mktemp -d) && rm -rf "$D"`), false], [bash(String.raw`find . -name '*.tmp' -exec rm {} \;`), false],
    [bash("bash -c 'npm run build'"), false], [bash("echo hi > notes.md"), false], [bash("grep -n taskkill probe.ps1"), false],
    // Abbreviated git options, a ref moved by plumbing, dot globs, a delete behind an if, a stream path, a quoted word that only names a command.
    [bash("git push --dele side"), true], [bash("git reset --har HEAD~1"), true], [bash("git clean -d --force"), true],
    [bash("git update-ref refs/heads/x 0000000000000000000000000000000000000000"), true],
    [bash("rm -rf .*"), true], [bash("rm -rf C:/work/repo/*"), true], [bash("if cd /c/Users/u; then rm -rf Documents; fi"), true],
    [write("C:/work/repo/.git::$INDEX_ALLOCATION/config"), true], [mcp("mcp__x__y"), true],
    [bash('grep -n "taskkill|reg import" a.ps1'), false],
    // The final review: find from the repository root, a delete inside -exec, .NET deletes, the hook's empty input, a PowerShell drive.
    [bash("find . -delete"), true], [bash("find . -name '*' -delete"), true], [bash("find . -type f -delete"), true], [bash("find . -name '*.tmp' -delete"), false],
    [bash("find . -not -path './.git/*' -delete"), false],
    [bash(String.raw`find /c/Users/u/Documents -exec bash -c 'rm "$0"' {} \;`), true], [bash(String.raw`find /c/Users/u/Documents -exec rmdir {} \;`), true],
    [bash(String.raw`find /c/Users/u/Documents -exec shred {} \;`), true],
    [decide({ tool_name: "PowerShell", tool_input: { command: "(Get-Item C:\\Users\\u\\Documents).Delete($true)" } }, env), true],
    [decide({ tool_name: "PowerShell", tool_input: { command: "Remove-Item Env:FOO" } }, env), false],
    [decide({}, env), true],
    // The second fix wave: eval of an echo, a cd in a subshell, here-document substitutions, git's env twins, config keys, transport options, glob pathspecs, option variables.
    [bash(`eval "$(echo 'rm -rf /c/Users/u/Documents')"`), true], [bash(`eval "$(fnm env)"`), false],
    [decide({ tool_name: "Bash", cwd: "C:\\Users\\u", tool_input: { command: "cd C:/temp & rm -rf Documents" } }, env), true],
    [decide({ tool_name: "Bash", cwd: "C:\\Users\\u", tool_input: { command: "cd C:/temp | cat; rm -rf Documents" } }, env), true],
    [bash("cat <<EOF\n$(rm -rf /c/Users/u/Documents)\nEOF"), true], [bash("cat <<'EOF'\n$(rm -rf /c/Users/u/Documents)\nEOF"), false],
    [bash(`GIT_SSH_COMMAND='rm -rf /c/Users/u/Documents' git fetch`), true], [bash("GIT_PAGER=cat git log"), false], [bash("GIT_EXEC_PATH=/c/temp git status"), true],
    [bash("git -c protocol.ext.allow=always fetch origin"), true], [bash("git config pager.log x"), true],
    [bash(`git fetch --upload-pack='rm -rf /c/Users/u/Documents;' origin`), true], [bash("git clone -u x url"), true], [bash("git fetch origin"), false],
    [bash("git checkout -- '*'"), true], [bash("git restore ':/*'"), true], [bash("git checkout -- src/*.ts"), false],
    [bash("F=--force; git push $F origin main"), true], [bash("B=night; git push origin $B"), false],
    // The deferred findings: find alternatives and names, a cd in a group, pipeline deletes, in-place writes, moves, more shells, an escaped letter, git's quieter deletes.
    [bash("find . -name x -o -delete"), true], [bash("find . -name HEAD -delete"), true], [bash("find /tmp -delete"), true],
    [bash(String.raw`find . \( -name '*.pyc' -o -name __pycache__ \) -exec rm -rf {} +`), false], [bash("find . -name node_modules -prune -exec rm -rf {} +"), false],
    [decide({ tool_name: "Bash", cwd: "C:\\Users\\u", tool_input: { command: "{ cd C:/temp; } & rm -rf Documents" } }, env), true],
    [decide({ tool_name: "Bash", cwd: "C:\\Users\\u", tool_input: { command: "if true; then cd C:/temp; fi | cat; rm -rf Documents" } }, env), true],
    [ps("gci C:\\Users\\u -Recurse | Remove-Item -Force"), true], [ps("gci C:\\Users\\u\\Documents | % { Remove-Item $_.FullName }"), true],
    [ps("Get-ChildItem dist | Remove-Item -Recurse -Force"), false], [ps("Remove-Item dist -Recurse -Force -Confirm:$false"), false],
    [bash("sed -i s/a/b/ C:/temp/x-night/run.json"), true], [bash("sed -i s/a:b/c/ src/a.txt"), false], [bash("truncate -s 0 C:/temp/x-night/chain.log"), true],
    [bash("dd if=a of=C:/temp/x-night/run.json"), true], [ps("Clear-Content .claude\\night-shift.json"), true], [ps(`Set-Content notes.txt "time: 12:30"`), false],
    [bash("mv C:/Users/u/Documents C:/temp/gone"), true], [bash("mv dist/a.js dist/b.js"), false], [bash("shred -u C:/Users/u/Documents/a.txt"), true],
    [bash("ksh -c 'rm -rf ~/Documents'"), true], [bash("busybox sh -c 'rm -rf ~/Documents'"), true], [bash("su -c 'git push -f'"), true], [bash("fish -c 'npm test'"), false],
    [bash(String.raw`r\m -rf ~/Documents`), true], [bash(String.raw`git push --for\ce origin main`), true], [bash(String.raw`git commit -m fix\ typo`), false],
    [bash("rm -rf ~u/Documents"), true], [bash("rm -rf dist/{a,b}"), false], [bash("D=$(mktemp -d /tmp/x.XXXXXX); rm -rf $D"), false],
    [bash("git tag -d v1"), true], [bash("git tag -l"), false], [bash("git worktree remove --force ../wt"), true], [bash("git worktree list"), false],
    [bash("git gc --prune=now"), true], [bash("git gc --quiet"), false], [bash("git prune"), true], [bash("git replay --onto main a..b"), true],
    [bash("git config --rename-section zz core"), true], [bash("git config --get core.editor --local"), false], [bash("git -c core.pager=cat log"), false],
    [bash("USERPROFILE=C:/temp/x git status"), true], [bash("declare -x HOME=C:/temp/x; git status"), true],
    [bash(`M='fix --amend docs'; git commit -m "$M"`), false], [bash("git clone -bfeature https://github.com/a/b dir"), false],
    [bash(`GIT_SSH_COMMAND="ssh -i $KEY" git fetch`), false], [bash("git ls-files -m | xargs git add"), false], [bash("git ls-files | xargs git push -f"), true],
    [write("C:/work/repo/.claude/night-shift-rules.md"), true], [bash("echo 'push is fine' >> .claude/night-shift-rules.md"), true],
    [bash("rm .claude/night-shift-rules.md"), true], [bash("rm -f C:/work/repo/.claude/night-shift-*"), true],
    [ps("Set-Content .claude\\night-shift-rules.md 'x'"), true], [bash("cat .claude/night-shift-rules.md"), false],
    [write("C:/Users/u/.claude/night-shift/rules.md", inHome), true], [write("C:/Users/u/.claude/night-shift/config.json", inHome), true],
    // the user's language tables are code the runner and the watcher run (lang/index.mjs)
    [write("C:/Users/u/.claude/night-shift/lang/tr.mjs", inHome), true], [bash("echo 'export default {}' > C:/Users/u/.claude/night-shift/lang/xx.mjs", inHome), true],
    [bash("rm night-shift/rules.md", inHome), true], [write("C:/Users/u/.claude/notes.md", inHome), false],
    [bash("find . -name rules.md -delete", inHome), true], [bash("find . -name config.json -delete", inHome), true],
    [bash("find . -path '*/night-shift/*' -delete", inHome), true], [bash("find . -name rules.md -exec rm {} +", inHome), true],
    [ps("Get-ChildItem . -Recurse -Filter config.json | Remove-Item", inHome), true], [bash("find . -name notes.md -delete", inHome), false],
    [bash("find . -path './night-shift/*' -delete", inHome), true], [bash("find . -path './night-shift/rules.md' -delete", inHome), true],
    [bash("find . -path './skills/*' -delete", inHome), false],
    // Where a push goes is changed through config or a URL too; node's inline script names no delete target.
    [bash("git config remote.origin.url https://example.com/x.git"), true], [bash("git config url.https://example.com/.insteadOf https://github.com/"), true],
    [bash("git -c remote.origin.pushurl=x push origin main"), true], [bash("git config --unset remote.origin.pushurl"), true], [bash("git config --get remote.origin.url"), false],
    [bash("git push https://example.com/o/r.git HEAD:main"), true], [bash("git push git@example.com:o/r.git main"), true], [bash("git push origin HEAD:refs/heads/night"), false],
    [bash(`node -e "f('rm -rf C:/Users/u/x')"`), false], [bash(`node -p "process.env.A + ':' + 'rm -rf x'"`), false],
    [bash(`node -e "x" > C:/temp/x-night/run.json`), true], [bash(`node -e "x" && rm -rf C:/Users/u/Documents`), true], [bash(`node -e "$(rm -rf /c/Users/u/Documents)"`), true],
    // The C4 follow-up: Claude Code's installed plugins; the run's skill folder wherever it is, apart from inside the repository; a variable too wide to protect.
    [bash("cp a.mjs C:/Users/u/.claude/plugins/cache/m/p/1.0.0/hooks/x.mjs"), true], [bash("echo {} > C:/Users/u/.claude/plugins/installed_plugins.json"), true],
    [bash("rm -rf C:/Users/u/.claude/plugins/marketplaces/m"), true], [bash("echo x > C:/Users/u/.claude/plugins/data/p/x.json"), false],
    [bash("cp a.mjs D:/tools/night-shift/scripts/guard.mjs", skill("D:/tools/night-shift")), true], [bash("cp a.mjs D:/tools/night-shift/scripts/guard.mjs"), false],
    [write("C:/temp/copy/night-shift/SKILL.md", skill("C:/temp/copy/night-shift")), true], [bash("rm -rf C:/temp/copy/*", skill("C:/temp/copy/night-shift")), true],
    [bash("rm -rf C:/temp/copy", skill("C:/temp/copy/night-shift")), true], [bash("rm -rf .claude"), true], [bash("rm -rf .claude/worktrees/x"), false],
    [bash("echo x > C:/work/repo/night-shift/SKILL.md", skill("C:/work/repo/night-shift")), false], [write("C:/work/repo/src/a.ts", skill("C:/work")), false],
    [bash("echo x > C:/temp/a.txt", skill("C:/temp")), false], [write("C:/temp/x-night/notes.md", skill("C:/temp/x-night")), false],
    [bash("cp a D:/plugins/cache/m/x.mjs", { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: "D:/plugins" }), true],
    [write("C:/work/repo/cache/a.ts", { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: "C:/work/repo" }), false],
    // C5: Linux's rules. The case written counts, a backslash is part of a name, /tmp is a temp root, /proc is refused.
    [lbash("echo x > /home/u/.claude/settings.json"), true], [lbash("echo x > //home/u/.claude/settings.json"), true],
    [lwrite("/work/repo/src/a.ts"), false], [lwrite("/work/Repo/src/a.ts"), true], [lwrite("/work/repo\\x"), true],
    [lbash("rm -rf /tmp/build"), false], [lbash("rm -rf /home/u/Documents"), true], [lwrite("/tmp/x-night/run.json"), true],
    [lbash("echo x > /proc/self/cwd/a.ts"), true],
    ...linkedCases(live.name === "win32" ? env : penv, (c, e) => bash(c, e, live), (f, e) => write(f, e, live)),
  ];
  let failed = 0;
  cases.forEach(([got, deny], i) => {
    if (Boolean(got) !== deny) { failed++; console.log(`case ${i}: expected ${deny ? "deny" : "allow"}, got ${got ?? "allow"}`); }
  });
  console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} cases pass`);
  process.exit(failed ? 1 : 0);
}

// Only a real import (the tests import decide()) skips the hook: a hook that takes itself for imported allows every call.
if (!isMain(import.meta, process.argv[1], { unknown: true })) { /* imported */ }
else if (process.argv.includes("--self-test")) selfTest();
else {
  const deny = (reason) => process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `night-shift guard: ${reason}. Do not work around it; note it for the morning and take other work.`,
    },
  }));
  // A hook that crashes leaves the call to the permission mode, so unreadable input or a throw is a deny.
  try {
    const reason = decide(JSON.parse(readFileSync(0, "utf8") || "{}"));
    if (reason) deny(reason);
  } catch (e) {
    deny(`the guard could not check this call (${String((e && e.message) || e).split("\n")[0]})`);
  }
}
