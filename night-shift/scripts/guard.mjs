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

import { readFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const norm = (p) => {
  let s = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").toLowerCase();
  const msys = /^\/([a-z])\//.exec(s);
  if (msys) s = `${msys[1]}:/${s.slice(3)}`;
  return s.replace(/\/+$/, "");
};
const under = (p, root) => root && (p === root || p.startsWith(root + "/"));

function roots(env) {
  const home = norm(env.USERPROFILE || env.HOME || homedir());
  return {
    repo: norm(env.NIGHT_SHIFT_REPO || ""),
    writable: [
      norm(env.NIGHT_SHIFT_REPO || ""),
      "c:/temp",
      norm(env.NIGHT_SHIFT_STATE || ""),
      norm(tmpdir()),
      `${home}/appdata/local/temp`,
    ].filter(Boolean),
    home,
  };
}

// Paths a night session may never write, even inside writable roots.
function protectedPath(p, r) {
  if (under(p, `${r.home}/.claude/skills/night-shift`)) return "the night-shift skill itself";
  if (/^.*\/\.claude\/settings(\.local)?\.json$/.test(p)) return "Claude settings";
  if (p === `${r.home}/.claude/claude.md`) return "the user's global CLAUDE.md";
  if (r.repo && p === `${r.repo}/.claude/night-shift.json`) return "the project's night-shift rules";
  if (r.repo && under(p, `${r.repo}/.git`)) return "the .git directory";
  return null;
}

function checkWrite(file, env) {
  const p = norm(file);
  const r = roots(env);
  const prot = protectedPath(p, r);
  if (prot) return `writing ${prot} is not allowed during a night run`;
  const memory = /^.*\/\.claude\/projects\/[^/]+\/memory(\/|$)/.test(p) && p.startsWith(r.home + "/");
  if (memory) return null;
  if (!r.writable.some((root) => under(p, root)))
    return `writes are limited to the repository, C:\\temp and the temp folder (got ${file})`;
  return null;
}

const GENERIC = [
  [/\bgit\b[^\n;&|]*\bpush\b[^\n;&|]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s--delete\b|\s-d\b|\s--mirror\b|\s\+\S|\s:\S)/i, "force or deleting pushes rewrite shared history"],
  [/\bgit\b[^\n;&|]*\breset\b[^\n;&|]*--hard\b/i, "git reset --hard discards work"],
  [/\bgit\b[^\n;&|]*\b(rebase|filter-branch|filter-repo)\b/i, "history rewrites need the user"],
  [/\bgit\b[^\n;&|]*\bcommit\b[^\n;&|]*--amend\b/i, "amending rewrites history"],
  [/\bgit\b[^\n;&|]*\bbranch\b[^\n;&|]*(\s-d\b|\s-D\b|\s--delete\b)/, "deleting branches needs the user"],
  [/\bgit\b[^\n;&|]*\bclean\b[^\n;&|]*\s-[a-z]*f/i, "git clean deletes untracked work"],
  [/\bgit\b[^\n;&|]*\bmerge(?![-\w])/i, "merges need the user"],
  [/\bgit\b[^\n;&|]*\bpull\b(?![^\n;&|]*--ff-only)/i, "only git pull --ff-only is allowed"],
  [/\bgit\b[^\n;&|]*\bstash\s+(drop|clear)\b/i, "dropping stashes discards work"],
  [/\bgit\b[^\n;&|]*\bremote\s+(add|remove|rm|set-url|rename)\b/i, "changing remotes needs the user"],
  [/\bgit\b[^\n;&|]*\bconfig\b[^\n;&|]*--(global|system)\b/i, "global git config is the user's"],
  [/\bgh\s+(pr\s+merge|release\s+(create|delete|upload|edit)|repo\s+(delete|edit|rename|archive|create)|secret\b|variable\b)/i, "publishing or changing the GitHub repository needs the user"],
  [/\bgh\s+api\b[^\n]*(-X|--method)\s*(DELETE|PUT|PATCH|POST)\b/i, "writing through the GitHub API needs the user"],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\bsteamcmd\b|\bbutler\s+push\b|\bvsce\s+publish\b/i, "publishing needs the user"],
  [/\b(shutdown(\.exe)?\s|Restart-Computer|Stop-Computer|diskpart|bcdedit|vssadmin|cipher\s+\/w|format(\.com)?\s+[a-z]:)/i, "system-level commands are not allowed"],
  [/\breg(\.exe)?\s+(add|delete|import|restore|load)\b|\b(Set|New|Remove|Rename)-ItemProperty\b|\bRemove-Item\b[^\n]*\bHK(CU|LM):/i, "registry writes change the live system"],
  [/\b(taskkill|Stop-Process|pkill|killall)\b[^\n]*\b(node|claude|powershell|pwsh|explorer|code|bash)(\.exe)?\b/i, "that process may be the run itself or the user's"],
  [/\bSystemParametersInfo\b/i, "changing system parameters touches the live desktop"],
];

const RECURSIVE_DELETE = /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b|\bRemove-Item\b[^\n]*-Recurse\b|\b(rmdir|rd)\s+\/s\b|\bdel\s+\/s\b|\brimraf\b/i;

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

// Splits a command line into simple commands at unquoted ; & | ( ) ` and newlines, each a
// list of words with their quotes removed. A $ inside single quotes is literal: kept as \0.
function simpleCommands(text) {
  const cmds = [];
  let words = [], word = null, q = null;
  const endWord = () => { if (word !== null) words.push(word); word = null; };
  const endCmd = () => { endWord(); if (words.length) cmds.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q === "'") { if (c === "'") q = null; else word += c === "$" ? "\0" : c; continue; }
    if (q === '"') {
      if (c === '"') q = null;
      else if (c === "\\" && /["\\$`]/.test(text[i + 1] || "")) word += text[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; word ??= ""; continue; }
    if (/[;&|()`\n]/.test(c)) { endCmd(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
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
  return out.replace(/\0/g, "$");
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

function checkRecursiveDelete(cmd, env) {
  const text = dropHeredocs(cmd);
  if (!RECURSIVE_DELETE.test(text)) return null;
  const r = roots(env);
  const vars = new Map();
  // Each delete is read on its own: the words of other commands are not its targets.
  for (const words of simpleCommands(text)) {
    recordAssignments(words, vars, env);
    if (!RECURSIVE_DELETE.test(words.join(" "))) continue;
    for (const raw of words) {
      const t = expand(raw, vars, env);
      if (t === null) return `refusing a recursive delete through a variable path that cannot be resolved (${raw.replace(/\0/g, "$")})`;
      if (/^-/.test(t) || /^\/(s|q)$/i.test(t)) continue;
      if (/^(\.|\.\/|\*|\.\/\*|\/|~|~\/.*|\.git|\.git\/.*)$/.test(t) || /(^|[\\/])\.\.([\\/]|$)/.test(t)) return `refusing a recursive delete of "${t}"`;
      const isAbs = /^[a-z]:[\\/]/i.test(t) || /^\/[a-z]\//i.test(t) || /^\//.test(t);
      if (isAbs) {
        const p = norm(t);
        if (r.repo && (p === r.repo || under(p, `${r.repo}/.git`))) return `refusing a recursive delete of the repository (${t})`;
        if (!r.writable.some((root) => under(p, root) && p !== root)) return `recursive deletes are limited to the repository and temp folders (got ${t})`;
      }
    }
  }
  return null;
}

function projectRules(env) {
  const repo = env.NIGHT_SHIFT_REPO;
  if (!repo) return [];
  const file = join(repo, ".claude", "night-shift.json");
  if (!existsSync(file)) return [];
  const cfg = JSON.parse(readFileSync(file, "utf8"));
  return (cfg.deny || []).map((d) => [new RegExp(d.pattern, d.flags ?? "i"), d.reason]);
}

export function decide(input, env = process.env) {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    return checkWrite(ti.file_path || ti.notebook_path, env);
  }
  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(ti.command || "");
    // Git rules read the command without its quoted text, so a commit message
    // that mentions "merge" or "pull" is not a merge or a pull.
    const unquoted = cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
    for (const [re, reason] of GENERIC) if (re.test(re.source.startsWith("\\bgit\\b") ? unquoted : cmd)) return reason;
    for (const [re, reason] of projectRules(env)) if (re.test(cmd)) return reason;
    return checkRecursiveDelete(cmd, env);
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
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  const reason = decide(input);
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `night-shift guard: ${reason}. Do not work around it; note it for the morning and take other work.`,
      },
    }));
  }
}
