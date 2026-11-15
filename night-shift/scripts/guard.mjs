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
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { norm, readProjectConfig, stateDirProblem } from "./config.mjs";

const under = (p, root) => root && (p === root || p.startsWith(root + "/"));

// What the runner keeps in the state folder: the settings file that loads this guard, the file
// that names the program each session starts, and its own logs and marks.
const RUNNER_FILES = /^(night-settings\.json|run\.json|launch\.cmd|resume\.json|chain\.log|reload-request|watch\.pid|notified\.json|fable\.json|session-\d+\.(jsonl|err))$/;

function roots(env) {
  const home = norm(env.USERPROFILE || env.HOME || homedir());
  const repo = norm(env.NIGHT_SHIFT_REPO || "");
  // A state folder that is a drive, the home folder or the like (a typo in stateDir) would make
  // all of it writable: it adds nothing, and the runner refuses to start with one.
  const state = env.NIGHT_SHIFT_STATE && !stateDirProblem(env.NIGHT_SHIFT_STATE, { home, repo, temp: tmpdir() }) ? norm(env.NIGHT_SHIFT_STATE) : "";
  return {
    repo,
    state,
    writable: [
      repo,
      "c:/temp",
      state,
      norm(tmpdir()),
      `${home}/appdata/local/temp`,
    ].filter(Boolean),
    home,
  };
}

// Windows opens a path through a stream name (a.ts:x, .git::$INDEX_ALLOCATION) or an 8.3 short
// name (SETTIN~1.JSO) as a file the rules below never named, so these are refused outright
// rather than resolved. p is already normalized.
export function oddPath(p) {
  if (p.replace(/^[a-z]:(?=\/|$)/, "").includes(":")) return "an NTFS stream name";
  if (p.split("/").some((s) => /~\d/.test(s))) return "a short (8.3) name";
  return null;
}
const oddReason = (p, shown) => {
  const what = oddPath(p);
  return what && `refusing a path with ${what} (${shown}): the guard cannot tell which file it is`;
};

// Paths a night session may never write, even inside writable roots.
function protectedPath(p, r) {
  if (under(p, `${r.home}/.claude/skills/night-shift`)) return "the night-shift skill itself";
  if (/^.*\/\.claude\/settings(\.local)?\.json$/.test(p)) return "Claude settings";
  if (p === `${r.home}/.claude/claude.md`) return "the user's global CLAUDE.md";
  if (r.repo && p === `${r.repo}/.claude/night-shift.json`) return "the project's night-shift rules";
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
    return `writes are limited to the repository, C:\\temp and the temp folder (got ${file})`;
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
  [/\bSystemParametersInfo\b/i, "changing system parameters touches the live desktop"],
];

// PowerShell takes any prefix of -Recurse (-r, -rec) and has aliases for Remove-Item.
const RECURSIVE_DELETE = /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|\b(Remove-Item|ri|rm|del|erase|rd|rmdir)\b[^\n]*\s-r(e(c(u(r(se?)?)?)?)?)?\b|\b(rmdir|rd)\s+\/s\b|\bdel\s+\/s\b|\brimraf\b/i;
const DELETE_WORD = /^(?:.*[\\/])?(rm|del|erase|remove-item|ri|rd|rmdir|unlink|rimraf|find)(\.exe)?$/i;
const ANY_DELETE = /\b(rm|del|erase|Remove-Item|ri|rd|rmdir|unlink|rimraf)\b|\s-delete\b/i;
const CD_WORD = /^(cd|chdir|pushd|set-location|sl|push-location)$/i;
const POP_WORD = /^(popd|pop-location)$/i;

const SHELL = String.raw`(?:\S*[\\/])?(?:bash|sh|zsh|dash|pwsh|powershell|cmd)(?:\.exe)?`;

// Drops here-document bodies: text for cat, git commit -F, node and the like is data,
// not commands (session 08's note "318 files / 3434 tests" read as `rm -rf /`).
// A body fed to a shell (`bash <<EOF`, `cat <<EOF | sh`) stays, since it is commands.
function dropHeredocs(cmd) {
  const out = [], pending = [];
  for (const line of cmd.split("\n")) {
    if (pending.length) {
      const h = pending[0];
      const end = line.replace(/\r$/, "");
      if ((h.dash ? end.replace(/^\t+/, "") : end) === h.delim) pending.shift();
      if (h.keep) out.push(line);
      continue;
    }
    out.push(line);
    // `<<` inside quoted text ("a <<X") starts no here-document; the quoted delimiter of one (<<'EOF') stays.
    const bare = line.replace(/(?<!<<-?\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')/g, (s) => "_".repeat(s.length));
    for (const m of bare.matchAll(/(?<!<)<<(-?)\s*(["']?)([A-Za-z_][\w.-]*)\2/g)) {
      const words = bare.slice(0, m.index).split(/[;&|()]/).pop().trim().split(/\s+/);
      const word = words.find((w) => !/^[A-Za-z_]\w*=/.test(w)) || "";
      const keep = new RegExp(`^${SHELL}$`, "i").test(word) || new RegExp(String.raw`\|\s*${SHELL}(\s|$)`, "i").test(bare.slice(m.index));
      pending.push({ delim: m[3], dash: m[1] === "-", keep });
    }
  }
  return out.join("\n");
}

// Splits a command line into simple commands at unquoted ; & | ( ) ` and newlines. Each has
//   words  its words with their quotes removed. A literal $ (inside single quotes, or \$ inside double
//          quotes) is kept as \0 and a literal backtick as \x01, so only a live $(...) or backtick pair
//          is a command substitution; unmark() puts them back.
//   bare   per word, whether it began outside quotes: `> x` is a redirect, `">x"` is text
//   sep    the separators before it as written, without ( ) ` and line breaks: "" for the first, "|" for a pipe
//   lvl    how many ( are open, so that a cd inside ( ) can end at the )
// An unquoted < or > starts a word of its own (`echo x>f` writes f); `2>f` and `>|f` stay one word.
const unmark = (s) => s.replace(/\0/g, "$").replace(/\x01/g, "`");
export function simpleCommands(text) {
  const cmds = [];
  let words = [], bare = [], word = null, wb = false, q = null, run = "", lvl = 0;
  const endWord = () => { if (word !== null) { words.push(word); bare.push(wb); } word = null; };
  const endCmd = () => {
    endWord();
    if (words.length) { cmds.push({ words, bare, sep: run.replace(/[()`\n]/g, "") || run, lvl }); run = ""; }
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
// name, $(...), $1, $env:, %NAME%.
function expand(word, vars, env) {
  if (/\$env:|%[A-Za-z_]\w*%/i.test(word)) return null;
  let unresolved = false;
  const out = word.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (m, braced, bare) => {
    const name = braced ?? bare;
    const value = vars.has(name) ? vars.get(name) : env[name];
    if (value == null) { unresolved = true; return m; }
    return value;
  });
  if (unresolved || out.includes("$")) return null;
  return unmark(out);
}

// A command made only of assignments (`D=C:/temp/x`, `export D=...`) sets them for the
// commands after it. A prefix assignment (`D=x rm -rf $D`) does not: bash expands the
// arguments first.
function recordAssignments(words, vars, env) {
  const rest = /^(export|declare|local|readonly|typeset)$/.test(words[0]) ? words.slice(1) : words;
  if (!rest.length || !rest.every((w) => /^[A-Za-z_]\w*=/.test(w))) return;
  for (const w of rest) {
    const at = w.indexOf("=");
    vars.set(w.slice(0, at), expand(w.slice(at + 1), vars, env));
  }
}

const isAbsolute = (t) => /^[a-z]:[\\/]/i.test(t) || /^[\\/]/.test(t);

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
    [`${r.home}/.claude/settings.json`, "Claude settings"],
    [`${r.home}/.claude/settings.local.json`, "Claude settings"],
    [`${r.home}/.claude/claude.md`, "the user's global CLAUDE.md"],
  ].filter(([c]) => c);
}

// Words a command's own name can hide behind: `sudo`, `env X=1`, `builtin`, and the keywords that
// open a branch or a loop (`if cd x; then rm y`). Skipped, with NAME=value words, to reach the name.
export const PREFIX_WORDS = /^(sudo|command|exec|time|env|nohup|builtin|if|then|else|elif|do|while|until|!|\{)$/;
// Launchers run the command that follows them: [options that take a value, positional words of their own, what an option looks like].
const LAUNCHERS = {
  timeout: [/^-[ks]$|^--(kill-after|signal)$/, 1], nice: [/^-n$|^--adjustment$/, 0], ionice: [/^-[cnpPu]$/, 0],
  setsid: [/^$/, 0], stdbuf: [/^-[ioe]$/, 0], watch: [/^-n$|^--interval$/, 0], start: [/^$/, 0, /^\//],
};
function nameIndex(words) {
  for (let i = 0; i < words.length; i++) {
    if (/^[A-Za-z_]\w*=/.test(words[i])) continue;
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
const SHELL_NAME = /^(bash|sh|zsh|dash|pwsh|powershell|cmd)$/;
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
  for (; i < args.length && args[i].startsWith("-"); i++) {
    const a = args[i];
    if (a === "-C") dirs.push(args[++i]);
    else if (a === "-c" || a === "--config-env") keys.push((args[++i] ?? "").split("=")[0]);
    else if (a.startsWith("--config-env=")) keys.push(a.slice(13).split("=")[0]);
    else if (/^--(git-dir|work-tree|namespace|super-prefix|attr-source)$/.test(a)) i++;
  }
  return { sub: i, keys, dirs };
}
// Config that makes git run something the guard cannot read: an alias, a file that can define one
// (include), or a command git calls (editor, pager, hooks, helpers, drivers). Reading a key is fine.
const CONFIG_ALIAS = /^(alias|include|includeif)\./i;
const CONFIG_RUNS = /^(core\.(fsmonitor|sshcommand|hookspath|editor|pager)|sequence\.editor|credential\.(.+\.)?helper|diff\.external|diff\..+\.textconv|filter\..+\.(clean|smudge|process)|merge\..+\.driver|gpg\.program|help\.autocorrect)$/i;
const configReason = (key) => CONFIG_ALIAS.test(key) ? "git aliases are not read during a night run" : CONFIG_RUNS.test(key) ? "git settings that run commands are not changed during a night run" : null;
// Options stop at a bare `--`. A long option may be cut short as long as it stays unambiguous
// (`--forc`, even `--f` for clean), so any prefix of the name counts; short ones may be clustered (-uf).
const upToDashes = (a) => { const k = a.indexOf("--"); return k < 0 ? a : a.slice(0, k); };
const long = (a, name) => upToDashes(a).some((w) => { const m = /^--([a-z][a-z-]*)(=|$)/.exec(w); return m && name.startsWith(m[1]); });
const short = (a, letter) => upToDashes(a).some((w) => /^-[A-Za-z]+$/.test(w) && w.includes(letter));
const anyLong = (a, ...names) => names.some((n) => long(a, n));
const anyShort = (a, letters) => [...letters].some((l) => short(a, l));
// The whole tree as a pathspec: `.`, `./`, `:/`.
const wholeTree = (a) => a.some((w) => /^(\.\/?|:\/\.?)$/.test(w));
const firstArg = (a) => a.find((w) => !w.startsWith("-"));
const GIT_RULES = {
  push: (a) => (anyLong(a, "force", "force-with-lease", "force-if-includes", "delete", "mirror", "prune") || anyShort(a, "fd") || a.some((w) => /^[+:]/.test(w))) && "force or deleting pushes rewrite shared history",
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
  pull: (a) => !a.includes("--ff-only") && "only git pull --ff-only is allowed",
  stash: (a) => /^(drop|clear)$/.test(a[0]) && "dropping stashes discards work",
  // `git remote -v add x url` works: the options come first.
  remote: (a) => /^(add|remove|rm|set-url|rename)$/.test(firstArg(a)) && "changing remotes needs the user",
  config: (a) => (anyLong(a, "global", "system") && "global git config is the user's") || a.map((w, i) => i + 1 < a.length && configReason(w)).find(Boolean) || null,
};
// Git's own commands the guard has no rule for: an alias cannot replace them, so nothing is looked up.
const GIT_PLAIN = new Set(`status add log diff show fetch rev-parse ls-files describe blame grep tag mv rm init worktree cherry-pick revert apply
  bisect shortlog cat-file ls-tree rev-list for-each-ref show-ref symbolic-ref check-ignore merge-base name-rev submodule notes format-patch am archive gc help version`.split(/\s+/));
// Variables that point git at other config or another repository, as prefix words or an earlier assignment.
const GIT_ENV_VAR = /^(\$env:|set:)?(GIT_CONFIG_(COUNT|PARAMETERS|KEY_\d+|VALUE_\d+|GLOBAL|SYSTEM)|HOME|XDG_CONFIG_HOME|GIT_DIR|GIT_COMMON_DIR)(=|$)/i;
const quoteArg = (w) => `"${w.replace(/(["\\$`])/g, "\\$1")}"`;
const configuredAlias = (name, cwd) => {
  try {
    const r = spawnSync("git", ["config", "--get", `alias.${name}`], { cwd, timeout: 3000, encoding: "utf8", windowsHide: true });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  } catch { return null; }
};

// The reason a git command (the words after `git`) is refused, or null. An alias is read as what it
// stands for: `!cmd` runs as a shell command with the arguments appended, any other value is git's own
// words again. Git never lets an alias replace one of its commands, so those are not looked up.
export function gitRule(args, ctx) {
  const { env, where, opts, depth } = ctx;
  if (depth > 4) return NESTED;
  args = args.map(unmark);
  const { sub, keys, dirs } = gitGlobals(args);
  for (const k of keys) { const why = configReason(k); if (why) return why; }
  if (sub >= args.length) return null;
  const name = args[sub], a = args.slice(sub + 1), cmd = name.toLowerCase();
  if (Object.hasOwn(GIT_RULES, cmd)) return GIT_RULES[cmd](a) || null;
  if (GIT_PLAIN.has(cmd)) return null;
  // The alias is read in the folder git will run in: the -C folders on top of where the command
  // stands (or the repository when that is not known).
  let cwd = ctx.cwd ?? (where.at && !where.lost ? where.at : env.NIGHT_SHIFT_REPO);
  for (const d of dirs) cwd = !cwd || isAbsolute(d) ? norm(d) : norm(`${cwd}/${d}`);
  const value = (opts.gitAlias ?? configuredAlias)(name, cwd || undefined);
  if (!value) return null;
  const inner = { ...opts, vars: new Map() };
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

// Redirections are files written or read, not arguments: `> f`, `>>f`, `2>f`, `< f`, `<<EOF`, `<<< text`.
function splitRedirects(c) {
  const args = [], writes = [], here = [];
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
    } else args.push(w);
  }
  return { args, writes, here, input };
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
const WRITERS = /^(tee|cp|copy|copy-item|ln|mklink|mv|move|move-item|set-content|add-content|out-file)$/;
function writeTargets(nm, a) {
  if (!WRITERS.test(nm)) return [];
  const pos = [], named = [];
  for (let i = 0; i < a.length; i++) {
    const w = a[i], pv = /^--?[A-Za-z][\w-]*[:=](.+)$/s.exec(w);
    if (pv) named.push(pv[1]);
    else if (/^(-t|--target-directory|-des\w*)$/i.test(w)) { if (a[i + 1] != null) named.push(a[++i]); }
    else if (!/^-/.test(w) && !/^\/[a-z]$/i.test(w)) pos.push(w);
  }
  if (/^(cp|copy|copy-item|ln)$/.test(nm)) return [...named, ...pos.slice(-1)];
  if (nm === "mklink") return pos.slice(0, 1);
  return [...named, ...pos];
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

const PATH_PARAM = (n) => { n = n.toLowerCase(); return "path".startsWith(n) || "literalpath".startsWith(n) || n === "pspath" || n === "lp"; };
const XARGS_VALUE = /^(-[aEdILnPs]|--(arg-file|delimiter|max-lines|max-args|max-procs|max-chars|process-slot-var))$/;

// Deletes: a recursive one anywhere in a simple command, and a plain one (rm, del, Remove-Item,
// unlink, find -delete) where it is the command. where.at is the folder the command stands in
// (the hook's cwd, moved by each cd before it), so a relative target is read from where the delete
// stands (`cd /c/Users/u && rm -rf Documents` passed until 2026-11-15).
function checkDelete(words, ni, env, where, vars, r) {
  const text = words.join(" ");
  if (!RECURSIVE_DELETE.test(text) && !ANY_DELETE.test(text)) return null;
  const name = words[ni];
  const recursive = RECURSIVE_DELETE.test(text);
  const plain = !recursive && DELETE_WORD.test(name) && (!/find(\.exe)?$/i.test(name) || words.includes("-delete") || (words.includes("-exec") && words.some((w) => /^(rm|unlink)$/.test(w))));
  if (!recursive && !plain) return null;
  const kind = recursive ? "recursive deletes" : "deletes";
  // find's own tests (-name "*.tmp") follow its first -option: patterns, not targets.
  const isFind = /find(\.exe)?$/i.test(name);
  let expr = false, dNext = false;
  // Its targets come after the delete's own word.
  for (let raw of words.slice(words.findIndex((w) => DELETE_WORD.test(w)) + 1)) {
    // PowerShell's -Path:x and -LiteralPath=x name their target in the same word.
    const pv = /^-(\w+)[:=](.+)$/s.exec(raw);
    if (pv && PATH_PARAM(pv[1])) raw = pv[2];
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
      else if (!/^-([HLP]|O\d*|D\S+)$/.test(t) && /^[-(!]/.test(t)) expr = true;
    }
    if (/^-/.test(t) || /^\/[sqfa]$/i.test(t) || /^(\/dev\/null|nul)$/i.test(t)) continue;
    if (/^~([\\/]|$)/.test(t)) return `refusing a ${recursive ? "recursive delete" : "delete"} in the home folder ("${t}")`;
    if (recursive && (/^(\.|\.\/|\*|\.\/\*|\/|\.git|\.git\/.*)$/.test(t) || /(^|[\\/])\.\.([\\/]|$)/.test(t))) return `refusing a recursive delete of "${t}"`;
    const abs = isAbsolute(t);
    if (!abs && where.lost) return `refusing a delete after a cd the guard cannot follow: it cannot tell which folder "${t}" is in`;
    if (!abs && !where.at) { const odd = oddReason(norm(t), t); if (odd) return odd; continue; }
    const p = norm(abs ? t : `${where.at}/${t}`);
    const odd = oddReason(p, t);
    if (odd) return odd;
    if (r.repo && under(p, `${r.repo}/.git`)) return `refusing a delete inside .git (${t})`;
    if (recursive && r.repo && p === r.repo) return `refusing a recursive delete of the repository (${t})`;
    const prot = protectedPath(p, r);
    if (prot) return `refusing a delete of ${prot} (${t})`;
    // The state folder itself, or a folder above it, takes the runner's files and the handover with it.
    if (r.state && under(r.state, p)) return `refusing a delete of the run's state folder (${t})`;
    if (!(isFind && expr) && GLOB.test(p)) {
      const hit = protectedTargets(r).find(([c]) => overlaps(p, c));
      if (hit) return `refusing a delete of ${hit[1]} through a wildcard (${t})`;
    }
    if (!r.writable.some((root) => under(p, root) && !(recursive && p === root))) return `${kind} are limited to the repository and temp folders (got ${t})`;
  }
  return null;
}

// Every Bash/PowerShell rule for one simple command. A wrapper (bash -c, powershell -c, cmd /c,
// eval, find -exec) hands its inner command to checkCommand again, so the rules read what is run
// and not the wrapper's words.
function readCommand(c, pipe, sawPipe, prev, env, where, opts, depth, r) {
  const { vars } = opts;
  // The splitter cannot see "$(...)" inside quotes; each one is a command of its own.
  for (const w of c.words) for (const body of substitutions(w)) {
    const why = checkCommand(body, env, { ...where }, opts, depth + 1);
    if (why) return why;
  }
  recordAssignments(c.words, vars, env);
  // PowerShell's `$env:NAME = x` and cmd's `set NAME=x` change the environment of the git after them;
  // kept apart from the shell variables (a key no $NAME can match) and read by the git check below.
  const pe = /^\$env:(\w+)/i.exec(c.words[0]) ?? (/^set$/i.test(c.words[0]) ? /^(\w+)=/.exec(c.words[1] ?? "") : null);
  if (pe) vars.set(`${/^set$/i.test(c.words[0]) ? "set:" : "$env:"}${pe[1]}`, "");
  const { args, writes, here, input } = splitRedirects(c);
  for (const t of writes) { const why = writeDenial(t, env, where, vars, r); if (why) return why; }
  let ni = nameIndex(args);
  if (ni < 0) return null;
  // A name that is a variable can be any command; a PowerShell $x alone is an expression, only `& $x` runs it.
  // A variable in the folder part ($HOME/bin/tool) leaves the command itself in view.
  if (args[ni].includes("$") && !(opts.ps && !/&$/.test(c.sep))) {
    const v = expand(args[ni], vars, env);
    if (v === null) { if (base(args[ni]).includes("$")) return "a command named by a variable cannot be read"; }
    else {
      args.splice(ni, 1, ...v.split(/\s+/).filter(Boolean));
      if (ni >= args.length) return null;
    }
  }
  const nm = base(args[ni]), rest = args.slice(ni + 1);
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
  // eval runs its words in this shell, so what it cd's and sets carries on.
  if (/^(eval|iex|invoke-expression)$/.test(nm)) {
    const script = rest.join(" ").trim();
    return !script || isSubstitution(script) ? null : checkCommand(scriptText(script, vars, env), env, where, opts, depth + 1);
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
    if (cmd && (DELETE_WORD.test(cmd) || /^(git|xargs)$/.test(base(cmd)) || SHELL_NAME.test(base(cmd)))) return "xargs builds a command the guard cannot read";
  }
  // Git reads GIT_CONFIG_* the way it reads -c: a variable can define an alias too. `git-push` and the
  // like are the same commands under their dashed names.
  if (nm === "git" || nm.startsWith("git-")) {
    if (args.slice(0, ni).some((w) => GIT_ENV_VAR.test(w)) || [...vars.keys()].some((k) => GIT_ENV_VAR.test(k))) return "git is not pointed at other config or another repository during a night run";
    const why = gitRule(nm === "git" ? rest : [nm.slice(4), ...rest], { env, where, opts, depth });
    if (why) return why;
  }
  if (nm !== "git" && !PRINTS.test(nm)) {
    const joined = args.map(txt).join(" ");
    for (const [re, reason] of GENERIC) if (re.test(joined)) return reason;
  }
  for (const t of writeTargets(nm, rest)) { const why = writeDenial(t, env, where, vars, r); if (why) return why; }
  if (PRINTS.test(nm)) return null;
  // A launcher the walker does not read (wsl, ssh, docker exec, call, flock, a PowerShell block):
  // wherever a word is git, the words after it are git's.
  if (nm !== "git" && !nm.startsWith("git-")) {
    for (let k = ni + 1; k < args.length; k++) {
      if (base(args[k]) !== "git") continue;
      const why = gitRule(args.slice(k + 1), { env, where, opts, depth });
      if (why) return why;
    }
  }
  // Of git only `git rm` deletes; a commit message that mentions `rm -rf` is text.
  if (nm === "git") {
    if (rest[gitGlobals(rest).sub] !== "rm") return null;
  }
  return checkDelete(args, ni, env, where, vars, r);
}

function walk(cmds, env, where, opts, depth) {
  if (depth > 4) return NESTED;
  const r = roots(env), saved = [];
  let lvl = 0, sawPipe = false, prev = null;
  for (const c of cmds) {
    // A cd inside ( ) lasts until the ), so the folder it left is put back there.
    while (lvl < c.lvl) { saved.push({ ...where }); lvl++; }
    while (lvl > c.lvl) { Object.assign(where, saved.pop()); lvl--; }
    const pipe = isPipe(c.sep);
    const why = readCommand(c, pipe, sawPipe, prev, env, where, opts, depth, r);
    if (why) return why;
    sawPipe ||= pipe; prev = c;
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
  return walk(simpleCommands(text), env, where, { ...opts, vars: opts.vars ?? new Map() }, depth);
}

// The project's deny rules. A file that does not validate yields an error instead: a rule that
// cannot be read must not silently stop refusing, so decide refuses every shell command.
function projectRules(env) {
  if (!env.NIGHT_SHIFT_REPO) return { rules: [] };
  const { config, errors } = readProjectConfig(env.NIGHT_SHIFT_REPO);
  if (errors.length) return { error: errors[0] };
  return { rules: (config.deny || []).map((d) => [new RegExp(d.pattern, d.flags ?? "i"), d.reason ?? `refused by a project rule (${d.pattern})`]) };
}

export function decide(input, env = process.env, opts = {}) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    return checkWrite(ti.file_path || ti.notebook_path, env);
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

function selfTest() {
  const env = { NIGHT_SHIFT_REPO: "C:/work/repo", NIGHT_SHIFT_STATE: "C:/temp/x-night", USERPROFILE: "C:\\Users\\u" };
  const bash = (command) => decide({ tool_name: "Bash", tool_input: { command } }, env);
  const write = (file_path) => decide({ tool_name: "Write", tool_input: { file_path } }, env);
  const cases = [
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
    [write("C:/temp/../Users/u/.claude/skills/night-shift/scripts/guard.mjs"), true], [write("C:/work/repo/.claude/settings.json."), true],
    [bash("cd /c/Users/u && rm -rf Documents"), true], [bash("cd app && rm -rf dist"), false],
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
    [bash("bash -c 'npm run build'"), false], [bash("echo hi > notes.md"), false], [bash("grep -n taskkill probe.ps1"), false],
  ];
  let failed = 0;
  cases.forEach(([got, deny], i) => {
    if (Boolean(got) !== deny) { failed++; console.log(`case ${i}: expected ${deny ? "deny" : "allow"}, got ${got ?? "allow"}`); }
  });
  console.log(failed ? `${failed} of ${cases.length} failed` : `all ${cases.length} cases pass`);
  process.exit(failed ? 1 : 0);
}

const imported = !process.argv[1] || resolve(process.argv[1]).toLowerCase() !== fileURLToPath(import.meta.url).toLowerCase();
if (imported) { /* the tests import decide() */ }
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
