// The recursive-delete check: only a delete's own command is read, a here-document's
// text is data, and a variable target must resolve. node --test guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decide } from "./guard.mjs";
import { tempRoot } from "./config.mjs";
import { platformFor } from "./platform.mjs";

const env = { NIGHT_SHIFT_REPO: "C:/work/repo", NIGHT_SHIFT_STATE: "C:/temp/x-night", USERPROFILE: "C:\\Users\\u" };
const bash = (command, e = env) => decide({ tool_name: "Bash", tool_input: { command } }, e);
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("session 08's command: a slash in a heredoc's text is not the delete's target", () => {
  assert.equal(bash(fixture("guard-session08-heredoc.txt")), null);
});

test("a slash in another command's text is not a delete target", () => {
  assert.equal(bash(`git commit -m "unit 318 files / 3434 tests" && rm -rf C:/temp/demo-app-x/walks`), null);
  assert.equal(bash("echo a / b; rm -rf dist"), null);
});

test("a delete written inside a heredoc's text is data", () => {
  assert.equal(bash("cat > C:/temp/x/notes.md <<'EOF'\nthen rm -rf / was refused\nEOF"), null);
});

test("a << inside quoted text starts no heredoc, so the next line is still read", () => {
  assert.ok(bash(`echo "see <<X"\nrm -rf /c/Users/u/Documents`));
});

test("a heredoc fed to a shell is still read as commands", () => {
  assert.match(bash("bash <<'EOF'\nrm -rf /\nEOF"), /recursive delete/);
  assert.match(bash("cat <<'EOF' | sh\nrm -rf ~/x\nEOF"), /recursive delete/);
});

test("an unresolved variable target is refused", () => {
  assert.match(bash("rm -rf $D/walks-a"), /variable/);
  assert.match(bash('rm -rf "${OUT}/x"'), /variable/);
  assert.match(bash('for d in a b; do rm -rf "$d"; done'), /variable/);
  assert.ok(bash("rm -rf $(pwd)/x"));
});

test("a variable set earlier in the same command is resolved, then checked", () => {
  assert.equal(bash("D=C:/temp/demo-app-d3-20261110; rm -rf $D/walks-a $D/walks-b"), null);
  assert.equal(bash('D="C:/temp/demo-app-x y"; rm -rf "$D/old"'), null);
  assert.match(bash("D=C:/Users/u/Documents; rm -rf $D/a"), /limited to the repository and temp/);
  assert.match(bash("rm -rf $D/a; D=C:/temp/x"), /variable/);
});

test("a prefix assignment does not reach its own command's arguments", () => {
  assert.match(bash("D=C:/temp/x rm -rf $D/a"), /variable/);
});

test("a variable of the session's environment resolves from it", () => {
  assert.equal(bash('rm -rf "$NIGHT_SHIFT_STATE/old"'), null);
  assert.ok(bash("rm -rf $HOME/x", { ...env, HOME: "C:/Users/u" }));
  assert.ok(bash("rm -rf $USERPROFILE/x"));
});

test("a .. segment is refused even under a temp folder", () => {
  assert.ok(bash("rm -rf C:/temp/../Users/u/Documents"));
});

// ---------------------------------------------------------------- the 2026-11-15 security review
const write = (file_path, e = env) => decide({ tool_name: "Write", tool_input: { file_path } }, e);
const ps = (command, e = env) => decide({ tool_name: "PowerShell", tool_input: { command } }, e);

test("the runner's own files in the state folder are not the session's to write", () => {
  for (const f of ["night-settings.json", "run.json", "launch.cmd", "resume.json", "chain.log", "RELOAD-REQUEST"]) {
    assert.match(write(`C:/temp/x-night/${f}`), /runner's own/, f);
  }
  assert.match(write("C:\\temp\\x-night\\Night-Settings.json"), /runner's own/);
  assert.equal(write("C:/temp/x-night/next-prompt.md"), null);
  assert.equal(write("C:/temp/x-night/prompts/03-inbox.md"), null);
  assert.equal(write("C:/temp/other/run.json"), null);
});

test("a written path is read the way Windows resolves it: .., a trailing dot, \\\\?\\", () => {
  assert.match(write("C:/temp/../Users/u/.claude/skills/night-shift/scripts/guard.mjs"), /night-shift skill/);
  assert.match(write("C:/temp/../Users/u/.claude/CLAUDE.md"), /CLAUDE\.md/);
  assert.match(write("C:/temp/../Users/u/Desktop/a.txt"), /limited to/);
  assert.match(write("C:/work/repo/src/../.git/hooks/pre-commit"), /\.git/);
  assert.match(write("C:/work/repo/.claude/settings.json."), /settings/);
  assert.match(write("C:/work/repo/.claude/settings.json "), /settings/);
  assert.match(write("C:/work/repo/.claude./settings.json"), /settings/);
  assert.match(write("\\\\?\\C:\\Users\\u\\Desktop\\a.txt"), /limited to/);
  assert.match(write("\\\\server\\share\\a.txt"), /limited to/);
  assert.equal(write("\\\\?\\C:\\work\\repo\\src\\a.ts"), null);
  assert.equal(write("C:/work/repo/src/./sub/../a.ts"), null);
});

// C4: a plugin install puts the skill in Claude Code's plugin cache. Since the C4 follow-up the guard names the cache
// as Claude Code's installed plugins, for a shell redirect or cp too (session 23 found `cp` there passed), and the
// run's own copy as the skill itself (NIGHT_SHIFT_SKILL, the tests at the end of this file).
test("a plugin install's copy of the skill is refused to Write, a delete, a redirect and cp as an installed plugin's, and as the skill's when the run starts from it", () => {
  const copy = "C:/Users/u/.claude/plugins/cache/night-shift/night-shift/0.3.0-dev/night-shift";
  assert.match(write(`${copy}/scripts/guard.mjs`) ?? "", /writing Claude Code's installed plugins is not allowed/);
  for (const c of [`rm -rf ${copy}`, `rm ${copy}/scripts/guard.mjs`, `cp a.mjs ${copy}/scripts/guard.mjs`, `echo x > ${copy}/SKILL.md`])
    assert.match(bash(c) ?? "", /Claude Code's installed plugins/, c);
  const own = { ...env, NIGHT_SHIFT_SKILL: copy };
  assert.match(write(`${copy}/scripts/guard.mjs`, own) ?? "", /writing the night-shift skill itself is not allowed/);
  assert.match(bash(`cp a.mjs ${copy}/scripts/guard.mjs`, own) ?? "", /the night-shift skill itself/);
});

test("a relative delete target is read from where the command stands", () => {
  assert.equal(bash("cd C:/work/repo/app && rm -rf dist"), null);
  assert.equal(bash("cd app && rm -rf dist"), null);
  assert.equal(bash("cd C:/temp/x && rm -rf old"), null);
  assert.match(bash("cd /c/Users/u && rm -rf Documents"), /limited to the repository and temp/);
  assert.match(bash("cd .. && rm -rf other-project"), /limited to the repository and temp/);
  assert.match(bash("pushd C:/Users/u; rm -rf Documents"), /limited to the repository and temp/);
  assert.match(bash("cd && rm -rf Documents"), /cannot tell which folder/);
  assert.match(bash("cd $SOMEWHERE; rm -rf x"), /cannot tell which folder/);
  assert.match(bash("cd -; rm -rf x"), /cannot tell which folder/);
  // The hook's own cwd is where a command without a cd stands.
  const at = (cwd, command) => decide({ tool_name: "Bash", cwd, tool_input: { command } }, env);
  assert.match(at("C:\\Users\\u", "rm -rf Documents"), /limited to the repository and temp/);
  assert.equal(at("C:\\work\\repo\\app", "rm -rf dist"), null);
});

test("PowerShell's ways to write a recursive delete are read too", () => {
  assert.ok(ps("Remove-Item -Recurse -Force ~\\Documents"));
  assert.ok(ps("Remove-Item -r -fo C:\\Users\\u\\Documents"));
  assert.ok(ps("ri -rec C:\\Users\\u\\Documents"));
  assert.ok(ps("Remove-Item -Recurse \\\\?\\C:\\Users\\u\\Documents"));
  assert.ok(ps("Remove-Item -Recurse \\\\server\\share\\x"));
  assert.ok(ps("Set-Location C:\\Users\\u; Remove-Item -Recurse Documents"));
  assert.equal(ps("Remove-Item -Recurse -Force C:\\temp\\x\\old"), null);
  assert.equal(ps("Set-Location C:\\temp\\x; Remove-Item -r old"), null);
  assert.equal(ps("Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue"), null);
});

test("a plain delete outside the repository and temp is refused too", () => {
  assert.match(bash("rm -f /c/Users/u/Documents/thesis.docx"), /limited to the repository and temp/);
  assert.match(bash("cd /c/Users/u && rm notes.txt"), /limited to the repository and temp/);
  assert.match(bash("find /c/Users/u/Documents -name '*.bak' -delete"), /limited to the repository and temp/);
  assert.ok(ps("Remove-Item C:\\Users\\u\\notes.txt"));
  assert.ok(bash("rm C:/work/repo/.git/index"));
  assert.equal(bash("rm C:/temp/x/a.txt"), null);
  assert.equal(bash("rm file.txt"), null);
  assert.equal(bash("rm -f src/old.ts && git add -A"), null);
  assert.equal(bash("rm -rf dist > /dev/null 2>&1"), null);
  assert.equal(bash('grep -rn "rm" /c/Users/u/x'), null);
  assert.equal(bash("find /c/Users/u/Documents -name '*.md'"), null);
  assert.equal(bash("find . -name '*.tmp' -delete"), null);
});

test("a quoted flag or refspec is still a flag; a commit message is still text", () => {
  assert.ok(bash('git push "--force" origin main'));
  assert.ok(bash("git push origin '+main'"));
  assert.ok(bash('git push origin ":old"'));
  assert.ok(bash('git reset "--hard" HEAD~3'));
  assert.equal(bash(`git commit -m "ui: merge pets tab, pull fix"`), null);
  assert.equal(bash(`git commit -m "--amend is not used here"`), null);
  assert.equal(bash("git push origin night"), null);
});

test("short flags written together and a command continued on the next line are read", () => {
  assert.ok(bash("git push -uf origin main"));
  assert.ok(bash("git push -fu origin main"));
  assert.ok(bash("git push origin main \\\n  --force"));
  assert.ok(bash("git branch -rd origin/x"));
  assert.equal(bash("git push -u origin night"), null);
  assert.equal(bash("git branch -vv"), null);
});

test("discarding the whole tree and deleting a ref need the user", () => {
  assert.ok(bash("git checkout -- ."));
  assert.ok(bash("git checkout ."));
  assert.ok(bash("git checkout -f main"));
  assert.ok(bash("git restore ."));
  assert.ok(bash("git restore --staged --worktree ."));
  assert.ok(bash("git restore -s HEAD~1 ."));
  assert.ok(bash("git update-ref -d refs/heads/main"));
  assert.equal(bash("git checkout -- src/a.ts"), null);
  assert.equal(bash("git checkout -b night"), null);
  assert.equal(bash("git restore --staged ."), null);
  assert.equal(bash("git restore src/a.ts"), null);
});

test("gh api writes are read in every spelling; reads pass", () => {
  assert.ok(bash("gh api --method=DELETE repos/o/r"));
  assert.ok(bash("gh api -XPOST repos/o/r/issues"));
  assert.ok(bash("gh api repos/o/r/issues -f title=x"));
  assert.ok(bash("gh api repos/o/r/issues --input body.json"));
  assert.ok(bash("gh api graphql -f query='mutation { addStar(input: {}) { clientMutationId } }'"));
  assert.equal(bash("gh api repos/o/r/pulls"), null);
  assert.equal(bash("gh api -X GET search/issues -f q=x"), null);
  assert.equal(bash("gh api graphql -f query='{ viewer { login } }'"), null);
});

// A repo in a throwaway folder whose .claude/night-shift.json holds `text`. Under the temp folder's long form: a CI
// runner's TEMP may be an 8.3 name (C:\Users\RUNNER~1\...), which the guard refuses in any path it reads.
const repoWithConfig = (text) => {
  const repo = mkdtempSync(join(tempRoot(), "guard-config-test-"));
  mkdirSync(join(repo, ".claude"));
  writeFileSync(join(repo, ".claude", "night-shift.json"), typeof text === "string" ? text : JSON.stringify(text));
  return { ...env, NIGHT_SHIFT_REPO: repo };
};

test("a broken project config refuses shell commands with its reason, and does not crash", () => {
  assert.match(bash("ls", repoWithConfig("{ not json")), /\.claude\/night-shift\.json is invalid/);
  assert.match(bash("ls", repoWithConfig({ deny: [{ pattern: "(" }] })), /\.claude\/night-shift\.json is invalid/);
  assert.match(bash("ls", repoWithConfig({ modle: "fable" })), /unknown key "modle"/);
  const ok = repoWithConfig({ deny: [{ pattern: "deploy\\.ps1" }] });
  assert.match(bash("./deploy.ps1", ok), /refused by a project rule \(deploy\\\.ps1\)/);
  assert.equal(bash("ls", ok), null);
});

test("a project rule also reads the path a Write, Edit, MultiEdit or NotebookEdit call writes", () => {
  const e = repoWithConfig({ deny: [{ pattern: "secrets/" }, { pattern: "^build/out\\.txt$", reason: "build output is the CI's" }, { pattern: "^docs/Keep\\.md$", flags: "" },
    { pattern: "^private/", reason: "private" }, { pattern: "^gl/", flags: "g" }] });
  const repo = e.NIGHT_SHIFT_REPO, msys = repo.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  const w = (file, tool = "Write", env2 = e) => decide({ tool_name: tool, tool_input: tool === "NotebookEdit" ? { notebook_path: file } : { file_path: file } }, env2);
  assert.match(w(`${repo}/secrets/a.txt`) ?? "", /refused by a project rule \(secrets\/\)/);
  assert.match(w(`${repo}\\secrets\\a.txt`, "Edit") ?? "", /project rule/);
  assert.match(w(`${repo}/secrets/b.txt`, "MultiEdit") ?? "", /project rule/);
  assert.match(w(`${repo}/secrets/n.ipynb`, "NotebookEdit") ?? "", /project rule/);
  // An anchored rule reads the path from the repository down; a rule without "i" keeps its case.
  assert.match(w(`${repo}/build/out.txt`) ?? "", /build output is the CI's/);
  assert.match(w(`${repo}/docs/Keep.md`) ?? "", /project rule/);
  assert.match(w(`${msys}/docs/Keep.md`) ?? "", /project rule/);
  assert.equal(w(`${repo}/docs/keep.md`), null);
  // The path as Windows resolves it: a .. or . on the way, a doubled slash, a trailing dot.
  for (const f of [`${repo}/src/../private/a.txt`, `${repo}/./private/a.txt`, `${repo}//private/a.txt`, `${repo}/private./a.txt`, `${msys}/private/a.txt`])
    assert.equal(w(f), "private", f);
  // A rule with the g flag matches every time, not every other time.
  for (let i = 0; i < 3; i++) assert.match(w(`${repo}/gl/a.txt`) ?? "", /project rule/);
  assert.equal(w(`${repo}/src/build/out.txt`), null);
  assert.equal(w(`${repo}/src/a.txt`), null);
  // A config that cannot be read refuses writes too, as it refuses shell commands.
  assert.match(w(`${repo}/src/a.txt`, "Write", repoWithConfig("{ not json")) ?? "", /night-shift\.json is invalid/);
});

test("an MCP tool is refused unless the project's config allows its server", () => {
  const call = (tool, e) => decide({ tool_name: tool, tool_input: {} }, e);
  const none = repoWithConfig({}), off = repoWithConfig({ mcp: "none" }), listed = repoWithConfig({ mcp: ["plugin_x_y"] }), inherit = repoWithConfig({ mcp: "inherit" });
  assert.match(call("mcp__plugin_x_y__do_it", none), /MCP tools are off in a night run \(server "plugin_x_y"\); the user allows one with "mcp": \["plugin_x_y"\] in \.claude\/night-shift\.json/);
  assert.ok(call("mcp__plugin_x_y__do_it", off));
  assert.equal(call("mcp__plugin_x_y__do_it", listed), null);
  assert.match(call("mcp__blender__execute_blender_code", listed), /server "blender"/);
  assert.equal(call("mcp__blender__execute_blender_code", inherit), null);
  // The server is what lies before the last "__"; a longer name that merely starts with a listed one is another server.
  assert.ok(call("mcp__plugin_x_y_z__do_it", listed));
  // A plugin's server listed as `claude mcp list` names it, and a name its tools spell with _, are the same server.
  const spelled = repoWithConfig({ mcp: ["plugin:x:y", "my.server"] });
  assert.equal(call("mcp__plugin_x_y__do_it", spelled), null);
  assert.equal(call("mcp__my_server__look", spelled), null);
  assert.ok(call("mcp__plugin_x_z__do_it", spelled));
  // Outside a project (no repo named) it is the same as "none".
  assert.ok(call("mcp__blender__look", { ...env, NIGHT_SHIFT_REPO: "" }));
  // A config that does not validate refuses, as it does for a shell command.
  assert.match(call("mcp__plugin_x_y__do_it", repoWithConfig("{ not json")), /\.claude\/night-shift\.json is invalid/);
  assert.match(call("mcp__plugin_x_y__do_it", repoWithConfig({ mcp: 3 })), /\.claude\/night-shift\.json is invalid/);
});

test("a state folder that is too wide adds nothing to what may be written", () => {
  const wide = { ...env, NIGHT_SHIFT_STATE: "C:/Users/u" };
  assert.ok(bash("rm -rf C:/Users/u/Documents", wide));
  assert.ok(write("C:/Users/u/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/x.cmd", wide));
  assert.equal(write("C:/temp/x-night/next-prompt.md"), null);
});

// ---------------------------------------------------------------- stream and short names, failing closed
test("a path that names an NTFS stream or a short name is refused", () => {
  assert.ok(write("C:/work/repo/.git::$INDEX_ALLOCATION/config"));
  assert.ok(write("C:/temp/x-night/night-settings.json::$DATA"));
  assert.ok(write("C:/work/repo/src/a.ts:hidden"));
  assert.ok(write("C:/work/repo/.claude/SETTIN~1.JSO"));
  assert.ok(bash("rm -f C:/work/repo/SRC~1/a.ts"));
  assert.ok(bash("rm -f C:/work/repo/src/a.ts:hidden"));
  assert.match(write("C:/work/repo/src/a.ts:hidden"), /refusing a path with an NTFS stream name/);
  assert.match(write("C:/work/repo/SRC~1/a.ts"), /refusing a path with a short \(8\.3\) name/);
  assert.equal(write("C:/work/repo/src/a~b.ts"), null);
});

test("only the user's own memory folders are the memory exception", () => {
  assert.equal(write("C:/Users/u/.claude/projects/p/memory/a.md"), null);
  assert.ok(write("C:/Users/u/Documents/.claude/projects/p/memory/a.txt"));
  assert.ok(write("C:/Users/u/.claude/projects/p/other/a.txt"));
});

test("the runner's files and the state folder cannot be deleted", () => {
  assert.match(bash("rm -f C:/temp/x-night/run.json"), /refusing a delete of the runner's own files/);
  assert.match(bash("rm -rf C:/temp/x-night"), /refusing a delete of the run's state folder/);
  assert.match(bash("rm -rf $NIGHT_SHIFT_STATE"), /refusing a delete of the run's state folder/);
  assert.ok(write("C:/temp/x-night/fable.json"));
  assert.equal(bash("rm -f C:/temp/x-night/scratch.txt"), null);
  assert.match(bash("rm -f C:/Users/u/.claude/settings.json"), /refusing a delete of Claude settings/);
  assert.match(bash("rm C:/work/repo/.claude/night-shift.json"), /refusing a delete of the project's night-shift rules/);
});

test("the caps' count, the waiter's marks and the user's stop are the runner's own files too; what a session writes is not", () => {
  const edit = (file_path) => decide({ tool_name: "Edit", tool_input: { file_path } }, env);
  for (const f of ["limits.json", "wait.json", "STOP-REQUEST", "stop-request"]) {
    const at = `C:/temp/x-night/${f}`;
    for (const r of [write(at), edit(at), bash(`echo {} > ${at}`), bash(`sed -i s/1/0/ ${at}`)])
      assert.match(r ?? "", /the runner's own files in the state folder/, f);
    assert.match(bash(`rm -f ${at}`) ?? "", /refusing a delete of the runner's own files/, f);
  }
  for (const f of ["questions.md", "inbox.md", "next-prompt.md", "prompts/21-inbox.md"]) {
    const at = `C:/temp/x-night/${f}`;
    assert.equal(write(at), null, f);
    assert.equal(edit(at), null, f);
    assert.equal(bash(`echo x >> ${at}`), null, f);
  }
});

test("the hook answers deny when it cannot read its input or throws", () => {
  const GUARD = fileURLToPath(new URL("./guard.mjs", import.meta.url));
  for (const input of ["{ not json", "null"]) {
    const r = spawnSync(process.execPath, [GUARD], { input, encoding: "utf8" });
    assert.equal(r.status, 0, input);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny", input);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /could not check this call/, input);
  }
});

test("a wildcard delete that can reach the state folder or a protected one is refused", () => {
  for (const c of [
    "rm -rf C:/temp/x-night/*", "rm -f C:/temp/x-night/run.*", "rm -f C:/temp/x-night/?un.json", 'rm -rf "$NIGHT_SHIFT_STATE"/*',
    "rm -f C:/work/repo/.claude/*.json", "rm -f C:/work/repo/.claude/settings.*", "rm -f C:/work/repo/.cl*/settings.json",
    "rm -f C:/temp/x-night/[r]un.json", "rm -rf C:/temp/x-*", "rm -rf C:/work/repo/*", "rm -f C:/work/repo/.g*/hooks/pre-commit",
    "rm -f C:/work/repo/.*/config", "find -L C:/temp/x-night/* -delete", "find -P C:/temp/x-night/run.* -delete",
    "find -H C:/work/repo/.claude/* -delete", "find -L C:/work/repo/.claude/settings.* -type f -delete",
    "find -D tree -O2 C:/temp/x-night/run.* -delete","cd C:/temp/x-night && rm -f run.*", "rm -f C:/Users/u/.claude/skills/night-*/scripts/guard.mjs",
  ]) assert.match(bash(c), /through a wildcard|state folder|recursive delete/, c);
  assert.match(bash("rm -f C:/temp/x-night/run.*"), /refusing a delete of the run's state folder through a wildcard/);
  assert.match(bash("rm -f C:/work/repo/.claude/settings.*"), /refusing a delete of the project's \.claude folder through a wildcard/);
  for (const c of [
    "rm -rf dist/*", "rm -rf build/.cache", "rm -f C:/temp/x-night/scratch.txt", 'find . -name "*.tmp" -delete', 'find -L . -name "*.tmp" -delete', 'find -D tree . -name "*.tmp" -delete',
    "rm -f C:/temp/*.txt", "rm -f src/*.bak", "rm -rf C:/temp/demo-*", "rm -f C:/work/repo/.cache/*",
  ]) assert.equal(bash(c), null, c);
});

// ---------------------------------------------------------------- the command a wrapper runs
test("a command inside a wrapper is read like any other", () => {
  for (const c of [
    `bash -c 'git push --force origin main'`, `bash -lc "rm -rf /c/Users/u/Documents"`, `sh -c 'cd /c/Users/u && rm -rf Documents'`,
    `powershell -c "Remove-Item -Recurse -Force C:\\Users\\u\\Documents"`, `pwsh -NoProfile -Command "git reset --hard HEAD~3"`,
    `cmd /c "rd /s /q C:\\Users\\u\\Documents"`, `cmd //c "git push -f"`, `eval 'git push --force'`,
    `find . -name x -exec git push --force \\;`, `bash -c "bash -c 'git push --force'"`,
    `powershell -EncodedCommand ZABpAHIA`, `powershell -enc ZABpAHIA`,
    `echo "git push --force" | bash`, `printf 'rm -rf /c/Users/u/Documents' | sh`, `cat s.txt | pwsh`,
    `echo /c/Users/u/Documents | xargs rm -rf`, `git branch | xargs git branch -D`, `ls | xargs -I{} bash -c '{}'`,
  ]) assert.ok(bash(c), c);
  for (const c of [`bash -c 'npm run build'`, `powershell -c "Get-ChildItem src"`, `cmd /c "dir C:\\temp"`, `bash scripts/build.sh`,
    `git ls-files | xargs grep -l TODO`, `bash -c 'cd app && rm -rf dist'`])
    assert.equal(bash(c), null, c);
});
test("a wrapper nested deeper than four levels is refused unread", () => {
  assert.match(bash("eval eval eval eval eval ls") || "", /nested/);
  assert.equal(bash("eval eval ls"), null);
});
test("words in text a command only reads or prints are not commands", () => {
  for (const c of [`grep -n "taskkill|reg import" scripts/probe.ps1`, `rg "Stop-Process -Name node" docs/`, `echo "never run shutdown /s here" >> notes.md`,
    `git commit -m "fix: taskkill node on exit"`, `git log --grep "reg add"`, `Select-String -Pattern "npm publish" README.md`])
    assert.equal(bash(c), null, c);
  for (const c of [`taskkill /IM node.exe /F`, `echo x && reg add HKCU\\Software\\X /v a`, `npm publish`])
    assert.ok(bash(c), c);
});
test("shell keywords and builtins before cd do not hide where a delete stands", () => {
  for (const c of [`if cd /c/Users/u; then rm -rf Documents; fi`, `{ cd /c/Users/u; rm -rf Documents; }`, `builtin cd /c/Users/u && rm -rf Documents`,
    // A quoted folder name with letters outside ASCII, as real Windows homes have (escaped: the file stays ASCII).
    `cd "/c/Users/u/R\u00e9sum\u00e9s/My Game/.." && rm -rf Documents`])
    assert.ok(bash(c), c);
  assert.equal(bash(`if cd app; then rm -rf dist; fi`), null);
  // The quoted folder outside ASCII is followed, not lost: inside the temp folder the same delete is allowed.
  assert.equal(bash(`cd "/c/temp/R\u00e9sum\u00e9s/My Game/.." && rm -rf old`), null);
});
test("PowerShell's separators and continuation are read", () => {
  assert.ok(ps("Set-Location C:\\Users\\u; Remove-Item -Recurse -Force Documents"));
  assert.ok(ps("Set-Location C:\\Users\\u\r\nRemove-Item `\r\n  -Recurse Documents"));
  assert.equal(ps("Set-Location app; Remove-Item -Recurse -Force dist"), null);
});
test("a redirect or a copy onto a protected file is a write", () => {
  for (const c of [`echo '{}' > C:/temp/x-night/night-settings.json`, `echo x >>/c/Users/u/.claude/settings.json`,
    `cp evil.json C:/Users/u/.claude/settings.json`, `mv a C:/work/repo/.git/config`, `echo x | tee C:/temp/x-night/run.json`,
    `Set-Content -Path C:/work/repo/.claude/night-shift.json -Value x`])
    assert.ok(bash(c), c);
  for (const c of [`echo hi > notes.md`, `git log > C:/temp/out.txt`, `cp a.json b.json`]) assert.equal(bash(c), null, c);
});

// ---------------------------------------------------------------- what the walker closes beyond the brief's list
test("a command built from a variable or a substitution is read, or refused when it cannot be", () => {
  for (const c of [`X='rm -rf /c/Users/u/Documents'; $X`, `X='rm -rf /c/Users/u/Documents'; eval "$X"`, `X='rm -rf /c/Users/u/Documents'; bash -c "$X"`,
    `echo "$(rm -rf /c/Users/u/Documents)"`, `echo "\`git push -f\`"`, `env -i rm -rf /c/Users/u/Documents`, `nohup rm -rf /c/Users/u/Documents`])
    assert.ok(bash(c), c);
  assert.ok(ps("& $x"));
  for (const c of [`eval "$(fnm env --shell bash)"`, `echo "$(date)"`, `x=$(git rev-parse HEAD); echo $x`, `bash -c 'echo $HOME'`, `D=C:/temp/x; rm -rf "$D/y"`])
    assert.equal(bash(c), null, c);
  for (const c of [`$files = Get-ChildItem; $files | ForEach-Object { $_.Name }`, `$ErrorActionPreference = 'Stop'; npm test`]) assert.equal(ps(c), null, c);
});
test("a literal backtick or an escaped $( in text is not a command substitution", () => {
  for (const c of ["git commit -m 'document the `git push -f` flag'", "gh pr create --body 'Blocks `git push --force` and `rm -rf /`'", "echo 'run `rm -rf /` never'",
    'git commit -m "fix: \\`rm -rf /c/Users/u/Documents\\` guard"', 'git commit -m "docs: \\$(rm -rf /) is literal"'])
    assert.equal(bash(c), null, c);
  // Of git only `git rm` deletes.
  assert.ok(bash("git rm -r C:/Users/u/Documents"));
  assert.ok(bash("git -C /c/Users/u rm -rf ."));
  assert.equal(bash("git rm -r src/old"), null);
  // A live one in double quotes is still read.
  assert.ok(bash('echo "$(rm -rf /c/Users/u/Documents)"'));
  assert.ok(bash('echo "`rm -rf /c/Users/u/Documents`"'));
});
test("a wrapper behind timeout, nice and the like is read; the launcher's own words are not the command", () => {
  for (const c of [`timeout 10 bash -c 'git push -f'`, `timeout 10 bash -c 'rm -rf /c/Users/u/Documents'`, `timeout -k 5 10 bash -c 'git push -f'`, `nice -n 5 bash -c 'rm -rf /c/Users/u/Documents'`,
    `nice rm -rf /c/Users/u/Documents`, `ionice -c 3 -n 7 bash -c 'git push -f'`, `setsid bash -c 'rm -rf /c/Users/u/Documents'`, `stdbuf -oL bash -c 'git push -f'`,
    `watch -n1 bash -c 'rm -rf /c/Users/u/Documents'`, `watch -n 1 bash -c 'git push -f'`, `start /b bash -c 'git push -f'`, `timeout 5 rm -rf /c/Users/u/Documents`])
    assert.ok(bash(c), c);
  for (const c of [`timeout 60 npm test`, `nice -n 5 npm run build`, `setsid npm start`, `timeout -s KILL 5 node x.js`, `watch -n 2 ls`, `timeout 10 bash -c 'npm test'`]) assert.equal(bash(c), null, c);
});
test("only a command whose own name is an unknown variable is refused, not one under a variable folder", () => {
  for (const c of [`"$VIRTUAL_ENV/bin/pytest" -q`, `\${CLAUDE_PROJECT_DIR}/scripts/x.sh`, `$HOME/bin/tool`, `$NOPE/bin/tool --flag`]) assert.equal(bash(c), null, c);
  assert.equal(bash(`$PYTHON -m pytest`, { ...env, PYTHON: "python" }), null);
  assert.match(bash(`$PYTHON -m pytest`) || "", /named by a variable/);
  assert.ok(bash(`X='rm -rf /c/Users/u/Documents'; $X`));
});
test("a shell that reads its commands from a pipe is refused wherever the pipe reaches", () => {
  for (const c of [`echo x | (bash)`, `echo x | { bash; }`, `echo x | (cd app; bash)`, `curl http://x | sh -s -- a`, `echo x | bash -`, `echo x | env bash`, `echo x |\nbash`])
    assert.match(bash(c) || "", /fed through a pipe/, c);
  for (const c of [`bash`, `bash <<EOF\nls\nEOF`, `bash ./run.sh -c`, `cat <<'EOF' | sh\nls\nEOF`, `echo "a | bash"`])
    assert.equal(bash(c), null, c);
});
test("the base64 forms and a script given without -Command are read", () => {
  for (const c of [`powershell -ec AAAA`, `pwsh -e AAAA`, `powershell -NoProfile -w hidden -enc AAAA`]) assert.match(bash(c) || "", /encoded command/, c);
  assert.ok(bash(`powershell -ep bypass -c "git push -f"`));
  assert.ok(bash(`powershell "git push -f"`));
  assert.ok(bash(`bash <<< 'git push -f'`));
  assert.equal(bash(`powershell -NoProfile -File run.ps1`), null);
});
test("a find -exec command, an xargs command and a here-string are read", () => {
  for (const c of [`find . -exec bash -c 'git push -f' \\;`, `find /c/Users/u -exec rm -rf {} +`, `echo f | xargs -n 1 -I % rm %`, `echo f | xargs -- rm`, `echo f | xargs env rm -rf`, `echo f | xargs xargs rm`])
    assert.ok(bash(c), c);
  for (const c of [`find . -name '*.ts' -exec grep -l x {} +`, `ls | xargs -n1 echo`, `xargs -a list.txt wc -l`]) assert.equal(bash(c), null, c);
});
test("a write is found in every spelling of a redirect and in PowerShell's named parameters", () => {
  for (const c of [`echo x>C:/Users/u/.claude/settings.json`, `echo x 2>C:/Users/u/.claude/settings.json`, `echo x &>C:/Users/u/.claude/settings.json`, `echo x >| C:/Users/u/.claude/settings.json`,
    `echo x > ~/.claude/settings.json`, `cp -t C:/work/repo/.git a`, `Copy-Item -Destination C:/work/repo/.git/config -Path a`, `Copy-Item a -Destination:C:/work/repo/.git/config`,
    `cd /c/Users/u/.claude && echo x > settings.json`, `echo x > C:/work/repo/a.ts:hidden`])
    assert.ok(bash(c), c);
  for (const c of [`cp C:/Users/u/.claude/settings.json C:/temp/backup.json`, `echo "a > b"`, `grep ">" file.txt`, `rm -rf dist 2>/dev/null`, `node s.js < in.txt > out.txt`, `echo x | tee -a build.log`])
    assert.equal(bash(c), null, c);
});
test("PowerShell's -Path:value and -LiteralPath=value are delete targets", () => {
  assert.match(ps("Remove-Item -Path:C:\\temp\\x-night\\run.json"), /runner's own files/);
  assert.match(ps("Remove-Item -LiteralPath=C:\\temp\\x-night\\run.json"), /runner's own files/);
  assert.match(ps("Remove-Item -Recurse -Path:C:\\Users\\u\\Documents"), /limited to the repository and temp/);
  assert.equal(ps("Remove-Item -Path:C:\\temp\\x\\a.txt"), null);
  assert.equal(ps("Remove-Item -Recurse -Path:dist"), null);
});
test("a cd inside a wrapper or parentheses does not move the commands after it", () => {
  const at = (command) => decide({ tool_name: "Bash", cwd: "C:\\Users\\u", tool_input: { command } }, env);
  assert.ok(at("(cd /c/temp/x); rm -rf Documents"));
  assert.ok(at("bash -c 'cd /c/temp/x'; rm -rf Documents"));
  assert.ok(at("bash -c 'rm -rf Documents'"));
  assert.equal(at("(cd /c/temp/x && rm -rf old)"), null);
  assert.equal(at("eval 'cd /c/temp/x'; rm -rf old"), null);
});

const aliases = { fp: "push --force", wipe: "!rm -rf /c/Users/u/Documents", st: "status -sb", loop: "loop", pass: "!git", gp: "-C app push --force" };
const git = (c) => decide({ tool_name: "Bash", tool_input: { command: c } }, env, { gitAlias: (n) => aliases[n] ?? null });

test("git options are read as git reads them: abbreviated, clustered, after global options", () => {
  for (const c of [`git push --dele origin side`, `git push --forc`, `git push --force-if-includes --force-with-lea`, `git push origin HEAD:main ""-f`,
    `git reset --har HEAD~3`, `git commit --amen -m x`, `git clean -d --force`, `git clean --fo`, `git clean --f`, `git branch --del x`, `git branch -f main HEAD~3`,
    `git branch -M old main`, `git checkout -qf`, `git checkout -B main origin/main`, `git switch -f main`, `git switch --discard-changes main`,
    `git switch -C main origin/main`, `git update-ref refs/heads/x 0000000000000000000000000000000000000000`, `git reflog expire --expire=now --all`,
    `git reflog delete HEAD@{1}`, `git -C /c/work/repo push --force`, `git --no-pager -c core.pager=cat reset --hard`, `git.exe push -f`,
    `"C:/Program Files/Git/bin/git.exe" push --force`, `git --namespace x push -f`, `git --exec-path=/x --git-dir=.git reset --hard`, `git-push --force`,
    `git remote -v add x http://h/r`, `git restore -SW .`, `git restore --staged --worktree .`, `git checkout ./`, `env -u A git push -f`,
    `git rebase -i HEAD~3`, `git merge --abort`, `git pull`, `git pull --rebase`, `git stash drop`, `git stash clear`, `git config --glob user.name x`, `git push origin +main`, `git push origin :old`])
    assert.ok(git(c), c);
  for (const c of [`git push -u origin night`, `git push origin main`, `git checkout -b night`, `git switch -c night`, `git branch -m old new`,
    `git branch --show-current`, `git reset --soft HEAD~1`, `git reflog`, `git clean -n`, `git commit -m "docs: --amend and --force notes"`,
    `git -C app status`, `git restore --staged .`, `git stash push -u -m wip`, `git log --oneline | grep -i merge`, `git merge-base HEAD origin/main`,
    `git push --no-force origin night`, `git push -- --force`, `git branch --format='%(refname)'`, `git pull --ff-only`, `git remote -v`,
    `git commit -m x --no-amend`, `git status -sb`, `git -c color.ui=always log`, `git rm src/a.ts`, `git checkout main -- src/a.ts`])
    assert.equal(git(c), null, c);
});
test("an alias is read as what it stands for, and defining one is refused", () => {
  assert.ok(git("git fp origin HEAD:main"));
  assert.ok(git("git wipe"));
  assert.ok(git("git gp"));
  assert.ok(git("git pass push --force"));
  assert.ok(git("git loop"), "an alias that never ends is a refusal, not a hang");
  assert.equal(git("git st"), null);
  assert.equal(git("git unknown-thing"), null);
  assert.ok(git(`git config alias.fp 'push --force'`));
  assert.ok(git(`git -c alias.x='push --force' x origin main`));
  assert.ok(git(`git -c "alias.x=!rm -rf /c/Users/u/Documents" x`));
  assert.ok(git(`git --config-env=alias.x=A x`));
  assert.ok(git(`git --config-env alias.x=A x`));
  assert.ok(git(`git -c include.path=/c/temp/a.cfg x`));
  assert.ok(git(`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='push -f' git x`));
  assert.ok(git("git config --global user.name x"));
  assert.equal(git("git config user.name"), null);
  assert.equal(git("git config --get alias.fp"), null);
  assert.equal(git("git -c user.name=x commit -m y"), null);
});
test("git's global options are read the same way for git rm", () => {
  for (const c of [`git --namespace x rm -rf /c/Users/u/Documents`, `git --super-prefix=a/ rm -rf /c/Users/u/Documents`, `git --config-env=core.x=A rm -rf /c/Users/u/Documents`,
    `git -c core.x=y rm -rf /c/Users/u/Documents`])
    assert.ok(bash(c), c);
  assert.equal(bash("git --namespace x rm -r src/old"), null);
});
test("a command named like an object property is just a command", () => {
  for (const c of ["constructor a b", "__proto__ x", "toString", "hasOwnProperty -x"]) assert.equal(bash(c), null, c);
  assert.ok(bash("constructor; rm -rf /c/Users/u/Documents"));
});

test("git's global options that take a value are all read (--attr-source), and reset --merge discards", () => {
  for (const c of [`git --attr-source HEAD push --force`, `git --attr-source HEAD reset --hard`, `git --attr-source HEAD rm -rf /c/Users/u/Documents`, `git reset --merge`])
    assert.ok(git(c), c);
  assert.equal(git(`git --attr-source=HEAD status`), null);
  assert.equal(git(`git reset --mixed HEAD~1`), null);
});
test("config the night session writes itself cannot define a command git runs", () => {
  for (const c of [`git config include.path ../ev.cfg`, `git config --add includeIf.gitdir:x.path y`, `git -C /c/temp/y config include.path z`, `git config INCLUDE.path z`,
    `git config core.editor 'rm -rf /c/Users/u/Documents'`, `git config core.sshCommand x`, `git config core.hooksPath /c/temp/h`, `git config --local core.fsmonitor x`,
    `git config core.pager x`, `git config sequence.editor x`, `git config credential.helper x`, `git config credential.https://h.helper x`, `git config diff.external x`,
    `git config diff.a.textconv x`, `git config filter.a.clean x`, `git config filter.a.smudge x`, `git config filter.a.process x`, `git config merge.a.driver x`,
    `git config gpg.program x`, `git config help.autocorrect immediate`, `git -c core.pager='rm -rf /c/Users/u/Documents' log`, `git -c core.sshCommand='rm -rf /c/Users/u/Documents' fetch`, `git --config-env=core.pager=V log`,
    `git --config-env core.hooksPath=V status`, `git -c core.fsmonitor=x status`])
    assert.ok(git(c), c);
  for (const c of [`git config core.editor`, `git config --get core.pager`, `git config --unset core.editor`, `git config user.email a@b.c`, `git config core.autocrlf false`, `git -c user.name=x status`])
    assert.equal(git(c), null, c);
});
test("a variable that points git at other config or another repository refuses the git command after it", () => {
  for (const c of [`HOME=/c/temp/h git status`, `XDG_CONFIG_HOME=/c/temp/h git log`, `GIT_DIR=/c/temp/g git status`, `GIT_COMMON_DIR=/c/temp/g git status`, `env HOME=/c/temp/h git status`,
    `export HOME=/c/temp/h; git status`, `set GIT_DIR=/c/temp/g && git status`, `home=/c/temp/h git status`])
    assert.ok(git(c), c);
  const ps = (command) => decide({ tool_name: "PowerShell", tool_input: { command } }, env, { gitAlias: () => null });
  for (const c of [`$env:GIT_CONFIG_COUNT = "1"; git status`, `$env:HOME="C:\\temp\\h"; git status`, `$env:GIT_DIR = 'C:\\temp\\g'; git log`]) assert.ok(ps(c), c);
  assert.equal(git(`GIT_CONFIG_NOSYSTEM=1 git status`), null);
  assert.equal(git(`GIT_TERMINAL_PROMPT=0 git fetch`), null);
});
test("the alias lookup runs in the folder git will use", () => {
  const seen = [];
  const at = (command, cwd) => decide({ tool_name: "Bash", cwd, tool_input: { command } }, env, { gitAlias: (n, dir) => { seen.push(dir); return null; } });
  at("git zz", undefined); at("git zz", "C:\\Users\\u\\proj"); at("git -C sub zz", "C:\\Users\\u\\proj"); at("git -C /c/temp/y zz", "C:\\Users\\u\\proj"); at("git -C /c/temp/y -C z zz", undefined);
  assert.deepEqual(seen.map((d) => String(d).toLowerCase()), ["c:/work/repo", "c:/users/u/proj", "c:/users/u/proj/sub", "c:/temp/y", "c:/temp/y/z"]);
});
test("git behind a launcher or a block the walker does not read is still git", () => {
  for (const c of [`wsl git push --force`, `ssh host git push -f`, `docker exec c git push -f`, `call git push -f`, `flock /tmp/x git push -f`, `taskset 1 git push -f`,
    `winpty git push -f`, `doas git push -f`, `runuser -u x git push -f`, `npx git push -f`, `parallel git push -f ::: a`, `su -c git push -f`, `wsl git -C app reset --hard`])
    assert.ok(git(c), c);
  const ps = (command) => decide({ tool_name: "PowerShell", tool_input: { command } }, env, { gitAlias: () => null });
  for (const c of [`1 | ForEach-Object { git push -f }`, `try { git push -f } catch {}`, `Invoke-Command { git push -f }`, `$x = git push -f`, `function f { git push -f }; f`,
    `& git push --force`, `Start-Job { git reset --hard }`])
    assert.ok(ps(c), c);
  for (const c of [`gh pr create --title "git push -f"`, `man git`, `npm run git-hooks`, `echo git push -f`, `grep -r "git push -f" docs/`, `wsl git status`, `ssh host git log`, `which git`])
    assert.equal(git(c), null, c);
});

test("what git submodule foreach, bisect run, difftool, grep -O and for-each-repo hand on is read", () => {
  for (const c of [`git submodule foreach git push -f`, `git submodule foreach --recursive git reset --hard`, `git bisect run git reset --hard`, `git -C x submodule foreach git push -f`,
    `git submodule foreach 'rm -rf /c/Users/u/Documents'`, `git submodule --quiet foreach "git push --force origin main"`, `git difftool -x 'rm -rf /c/Users/u/Documents'`,
    `git difftool --extcmd="git push -f"`, `git difftool --extcmd 'git reset --hard'`, `git grep -O'git push -f' x`, `git grep --open-files-in-pager='rm -rf /c/Users/u/Documents' x`,
    `git for-each-repo --config=maintenance.repo push --force`, `git for-each-repo --config maintenance.repo reset --hard`])
    assert.ok(git(c), c);
  for (const c of [`git submodule foreach git status`, `git bisect run npm test`, `git submodule update --init`, `git bisect start`, `git difftool -x meld`, `git grep -n TODO`, `git grep -O less x`,
    `git for-each-repo --config=maintenance.repo fetch`, `git submodule foreach --recursive 'echo $name'`])
    assert.equal(git(c), null, c);
});

test("delete targets written through globs, braces, pipes and .NET are refused; a mktemp folder is not", () => {
  for (const c of [`rm -rf .*`, `rm -rf ./.*`, `rm -rf src/.*`, `rm -rf {/c/Users/u/Documents,x}`, `rm -rf C:/work/repo/*`, `rm -rf /c/temp/*`,
    `find /c/Users/u/Documents -name "*.tmp" -execdir rm {} +`, "rm -rf `cat list.txt`", `rm -rf $(cat list.txt)`,
    `D=/c/work/repo; D+=/../../Users/u; rm -rf "$D"`, `gci C:\\Users\\u\\Documents | ri -Recurse -Force`,
    `[IO.Directory]::Delete("C:\\Users\\u\\Documents", $true)`, `[System.IO.File]::Delete("C:\\Users\\u\\a.txt")`])
    assert.ok(bash(c), c);
  for (const c of [`D=$(mktemp -d) && rm -rf "$D"`, `T="$(mktemp -d -t build.XXXX)"; cp -r dist "$T"; rm -rf "$T"`, `rm -rf dist/*`, `rm -rf build/.cache`,
    `find . -name "*.tmp" -delete`, `find . -name '*.tmp' -exec rm {} \\;`])
    assert.equal(bash(c), null, c);
});

test("a PowerShell parameter's value is no delete target; a find expression goes on after an escaped semicolon", () => {
  const ps = (command) => decide({ tool_name: "PowerShell", tool_input: { command } }, env);
  for (const c of [`Get-ChildItem C:\\Users\\u\\Documents | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue`, `gci C:\\Users\\u\\Documents | ri -r -fo -ea SilentlyContinue`,
    `gci C:\\Users\\u\\Documents | Remove-Item -Recurse -Force -ea 0`, `gci C:\\Users\\u\\Documents | Remove-Item -Recurse -Force -ErrorVariable e`,
    `gci C:\\Users\\u\\Documents | ri -Recurse -Stream x -Credential y`])
    assert.ok(ps(c), c);
  assert.equal(ps(`Remove-Item -Recurse -Force -ErrorAction SilentlyContinue .\\dist`), null);
  assert.equal(bash(`rm -r -f build`), null);
  for (const c of [`find /c/Users/u/Documents -exec true {} \\; -delete`, `find /c/Users/u/Documents -exec echo {} \\; -exec rm {} \\;`])
    assert.ok(bash(c), c);
  assert.equal(bash(`find . -name '*.tmp' -exec rm {} \\;`), null);
  assert.equal(bash(`find . -name '*.tmp' -exec rm {} \\; -print`), null);
});

test("an escaped backslash leaves the semicolon after it a separator; an escaped semicolon is text", () => {
  for (const c of [`echo x\\\\; rm -rf ~`, `printf a\\\\; git push --force`, `bash -c 'echo x\\\\; rm -rf ~'`, `true \\\\; rm -rf /c/Users/u/Documents`])
    assert.ok(bash(c), c);
  assert.equal(bash(`echo a\\; rm -rf ~`), null);
});

// ---------------------------------------------------------------- final-review fix wave B
test("a short-form TEMP leaves the tool's own temp paths writable; a short name still is refused", () => {
  // A directory junction named like an 8.3 name stands in for a volume that makes short names. The base is in long
  // form, so that only the junction is short where the real TEMP is short too (a CI runner's C:\Users\RUNNER~1\...).
  const base = mkdtempSync(join(tempRoot(), "night-short-temp-"));
  const long = join(base, "LongTempFolderName"), link = join(base, "LONGUS~1");
  mkdirSync(long);
  symlinkSync(long, link, "junction");
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = process.env.TMP = link;
  try {
    const state = long.replace(/\\/g, "/") + "/night-x";
    const e = { ...env, NIGHT_SHIFT_STATE: state };
    assert.equal(decide({ tool_name: "Write", tool_input: { file_path: `${state}/next-prompt.md` } }, e), null);
    assert.equal(bash(`cat > "$NIGHT_SHIFT_STATE/next-prompt.md" <<'EOF'\nx\nEOF`, e), null);
    assert.equal(bash("echo x > /tmp/scratch.txt", e), null);
    assert.equal(bash(`D=$(mktemp -d) && rm -rf "$D"`, e), null);
    assert.match(bash(`echo x > ${link.replace(/\\/g, "/")}/a.txt`, e), /short \(8\.3\) name/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(base, { recursive: true, force: true });
  }
});

test("a find delete rooted at the repository or its .claude folder needs a test that narrows it or leaves .git out", () => {
  for (const c of ["find . -delete", "find . -type f -delete", `find . -name '*' -delete`, `find C:/work/repo -name '*' -delete`, `find -D tree . -name "*" -delete`,
    "find -delete", `find . -name '.*' -delete`, "find .claude -delete", `find . -path '*/.git/*' -delete`, "find . -mtime +7 -delete", "find .. -type f -delete",
    String.raw`find . -exec rm {} \;`, "find C:/work/repo/.claude -type f -delete", `find . -not -name '*.keep' -delete`])
    assert.match(bash(c) ?? "", /find delete/, c);
  assert.match(decide({ tool_name: "Bash", tool_input: { command: "find .. -delete" }, cwd: "C:/work/repo/src" }, env) ?? "", /find delete/);
  for (const c of [`find . -name '*.tmp' -delete`, `find . -not -path './.git/*' -delete`, `find . ! -path '*/.git/*' -type f -delete`, `find . -path ./.git -prune -o -type f -delete`,
    "find dist -delete", "find src -type f -delete", String.raw`find . -name '*.log' -exec rm {} \;`, "find . -type f", `find . -name '*' -print`])
    assert.equal(bash(c), null, c);
});

test("a stateDir that reaches system or per-user program folders is refused by the guard's roots", () => {
  for (const s of ["C:/Users/u/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/n", "C:/Windows/Temp/n", "C:/Program Files/x/n", "C:/Program Files (x86)/x/n", "C:/ProgramData/n"]) {
    const e = { ...env, NIGHT_SHIFT_STATE: s };
    assert.ok(decide({ tool_name: "Write", tool_input: { file_path: `${s}/x.txt` } }, e), s);
  }
});

test("empty input, or input without a tool name, is a deny, not an allow", () => {
  const GUARD = fileURLToPath(new URL("./guard.mjs", import.meta.url));
  for (const input of ["", "   ", "{}", `{"cwd":"C:/work/repo"}`, `{"tool_name":""}`, `{"tool_name":5}`]) {
    const r = spawnSync(process.execPath, [GUARD], { input, encoding: "utf8" });
    assert.equal(r.status, 0, input);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", input);
  }
  assert.ok(decide({}, env));
  assert.equal(decide({ tool_name: "Read", tool_input: {} }, env), null);
});

test("PowerShell provider drives are not NTFS streams; a stream or short name still is refused", () => {
  const ps = (command) => decide({ tool_name: "PowerShell", tool_input: { command } }, env);
  for (const c of ["Remove-Item Env:FOO", "Remove-Item Env:\\FOO", "Remove-Item -Path Env:FOO -Force", "Remove-Item Alias:ll", "Remove-Item Variable:x -Force", "Remove-Item Function:prompt", "ri env:FOO"])
    assert.equal(ps(c), null, c);
  for (const c of ["Remove-Item a.ts:hidden", "Remove-Item 'C:\\work\\repo\\.git::$INDEX_ALLOCATION'", "Remove-Item SETTIN~1.JSO", "Remove-Item Env:FOO:bar"])
    assert.match(ps(c) ?? "", /NTFS stream|short \(8\.3\)/, c);
});

test(".Delete($true), FileSystem::DeleteDirectory and a find -exec that deletes through any wrapper are refused", () => {
  const ps = (command) => decide({ tool_name: "PowerShell", tool_input: { command } }, env);
  for (const c of ["(Get-Item C:\\Users\\u\\Documents).Delete($true)", "$d.Delete($true)", "(Get-Item x).Delete( $true )",
    `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory("C:\\Users\\u\\Documents", "DeletePermanently")`])
    assert.match(ps(c) ?? "", /\.NET/, c);
  for (const c of [`$cache.Delete("key")`, "$f.Delete()", "Write-Host .Delete($true)", `echo "x.Delete($true)"`]) assert.equal(ps(c), null, c);
  for (const c of [String.raw`find /c/Users/u/Documents -exec bash -c 'rm "$0"' {} \;`, String.raw`find /c/Users/u/Documents -exec rmdir {} \;`,
    String.raw`find /c/Users/u/Documents -exec shred {} \;`, String.raw`find /c/Users/u/Documents -execdir sh -c 'unlink "$0"' {} +`,
    String.raw`find /c/Users/u/Documents -exec env X=1 rm {} \;`, String.raw`find /c/Users/u/Documents -name '*.bak' -exec cmd /c del {} \;`])
    assert.match(bash(c) ?? "", /limited to the repository and temp/, c);
  for (const c of [String.raw`find /c/Users/u/Documents -exec grep -l rm {} \;`, String.raw`find /c/Users/u/Documents -exec bash -c 'echo "$0"' {} \;`,
    String.raw`find src -name '*.o' -exec rmdir {} \;`])
    assert.equal(bash(c), null, c);
});

// The final review's second fix wave: the walker (eval, cd across & and |, here-document substitutions) and the git rules.
const psh = (command) => decide({ tool_name: "PowerShell", tool_input: { command } }, env, { gitAlias: () => null });

test("eval of a substitution that only echoes or prints is read as the script; a tool's own output is not", () => {
  for (const c of [`eval "$(echo 'rm -rf /c/Users/u/Documents')"`, `eval "$(printf '%s' 'rm -rf /c/Users/u/Documents')"`, `eval "$(echo rm -rf /c/Users/u/Documents)"`,
    "eval \"`echo 'rm -rf /c/Users/u/Documents'`\"", `eval "$(fnm env; echo 'rm -rf /c/Users/u/Documents')"`])
    assert.match(bash(c) ?? "", /limited to the repository and temp/, c);
  for (const c of [`eval "$(fnm env)"`, `eval "$(ssh-agent -s)"`, `eval "$(echo 'cd app')"`, `eval "$(echo hello)"`, `eval "$(echo 'rm -rf dist')"`]) assert.equal(bash(c), null, c);
});

test("a cd in a pipeline or before & runs in a subshell and leaves the folder of the commands after it alone", () => {
  const at = (command) => decide({ tool_name: "Bash", cwd: "C:\\Users\\u", tool_input: { command } }, env);
  for (const c of ["cd C:/temp & rm -rf Documents", "cd C:/temp | cat; rm -rf Documents", "cat x | cd C:/temp; rm -rf Documents", "cd C:/temp |& cat; rm -rf Documents",
    "cd /c/temp/x && ls & rm -rf Documents", "(cd C:/temp & true); rm -rf Documents"])
    assert.match(at(c) ?? "", /limited to the repository and temp/, c);
  for (const c of ["cd C:/temp && rm -rf old", "cd C:/temp; rm -rf old", "git status | cat; cd C:/temp; rm -rf old", "cd C:/temp && ls & cd C:/temp && rm -rf old", "cd C:/temp && rm -rf old | cat"])
    assert.equal(at(c), null, c);
  // PowerShell's | and & are no subshell: its cd moves the session
  assert.equal(decide({ tool_name: "PowerShell", cwd: "C:\\Users\\u", tool_input: { command: "cd C:/temp | Out-Null; Remove-Item -Recurse old" } }, env), null);
});

test("an unquoted here-document runs its $( ) and backtick spans; a quoted delimiter keeps them text", () => {
  for (const c of ["cat <<EOF\n$(rm -rf /c/Users/u/Documents)\nEOF", "cat > C:/temp/x/n.md <<EOF\nnote `rm -rf /c/Users/u/Documents` here\nEOF", "cat <<-EOF\n\tdone $(rm -rf /c/Users/u/Documents)\n\tEOF",
    "cat <<EOF\nline\n$(cd /c/Users/u\nrm -rf Documents\n)\nEOF", "cat <<A <<B\nx\nA\n$(rm -rf /c/Users/u/Documents)\nB"])
    assert.match(bash(c) ?? "", /limited to the repository and temp/, c);
  for (const c of ["cat <<'EOF'\n$(rm -rf /c/Users/u/Documents)\nEOF", 'cat <<"EOF"\n$(rm -rf /c/Users/u/Documents)\nEOF', "cat <<'EOF'\n`rm -rf /c/Users/u/Documents`\nEOF",
    "cat <<EOF\n\\$(rm -rf /c/Users/u/Documents)\nEOF", "cat <<EOF\n\\`rm -rf /c/Users/u/Documents\\`\nEOF", "cat <<EOF\ntoday is $(date) and $((1+2))\nEOF", "cat <<EOF\nplain text\nEOF"])
    assert.equal(bash(c), null, c);
  assert.match(bash("cat <<EOF\nx\nEOF\nrm -rf /c/Users/u/Documents") ?? "", /limited to the repository and temp/);
});

test("the environment variables git runs as a command are read as one; the ones that name a program are refused", () => {
  for (const c of [`GIT_SSH_COMMAND='rm -rf /c/Users/u/Documents' git fetch`, `GIT_PAGER='rm -rf /c/Users/u/Documents' git log`, `export GIT_EDITOR="bash -c 'rm -rf /c/Users/u/Documents'"; git commit`,
    `GIT_ASKPASS='rm -rf /c/Users/u/Documents' git push origin night`, `GIT_EXTERNAL_DIFF='rm -rf /c/Users/u/Documents' git diff`, `GIT_PROXY_COMMAND='rm -rf /c/Users/u/Documents' git fetch`,
    `env GIT_PAGER='rm -rf /c/Users/u/Documents' git log`])
    assert.match(git(c) ?? "", /limited to the repository and temp/, c);
  for (const c of [`GIT_EXEC_PATH=/c/temp/h git status`, `GIT_SSH=/c/temp/h/ssh git fetch`, `export GIT_EXEC_PATH=/c/temp/h; git log`, `GIT_PAGER=$UNKNOWN git log`, `export GIT_PAGER=$(x); git log`])
    assert.ok(git(c), c);
  for (const c of [`GIT_PAGER=cat git log`, `export GIT_PAGER=cat; git log`, `GIT_EDITOR=true git commit -m x`, `GIT_SSH_COMMAND='ssh -i /c/temp/key' git fetch`, `GIT_ASKPASS=echo git fetch`, `GIT_TERMINAL_PROMPT=0 git fetch`])
    assert.equal(git(c), null, c);
  // (a value with rm -rf in it is refused at the assignment already; a plain delete is only read where git runs it)
  assert.match(psh(`$env:GIT_PAGER = 'del C:\\Users\\u\\Documents\\a.txt'; git log`) ?? "", /limited to the repository and temp/);
  assert.match(psh(`$env:GIT_SSH_COMMAND='rm C:\\Users\\u\\Documents\\a.txt'; git fetch`) ?? "", /limited to the repository and temp/);
  assert.match(decide({ tool_name: "Bash", tool_input: { command: `set GIT_PAGER=del C:\\Users\\u\\Documents\\a.txt && git log` } }, env, { gitAlias: () => null }) ?? "", /limited to the repository and temp/);
  assert.ok(psh(`$env:GIT_EXEC_PATH = 'C:\\temp\\h'; git status`));
  assert.equal(psh(`$env:GIT_PAGER = 'cat'; git log`), null);
});

test("more config keys that make git run a command or open a protocol cannot be set", () => {
  for (const k of ["pager.log", "gpg.ssh.program", "gpg.x509.program", "gpg.openpgp.program", "core.askpass", "core.gitProxy", "core.alternateRefsCommand", "uploadpack.packObjectsHook",
    "remote.origin.uploadpack", "remote.origin.receivepack", "diff.a.command", "difftool.a.cmd", "mergetool.a.cmd", "trailer.a.command", "protocol.ext.allow", "protocol.allow", "Core.GitProxy"]) {
    assert.ok(git(`git config ${k} x`), k);
    // given with -c, a key whose value is a command line is read as that command; the rest are refused outright
    assert.ok(git(`git -c ${k}='rm -rf /c/Users/u/Documents' log`), k);
  }
  for (const c of [`git config --get pager.log`, `git config protocol.version 2`, `git config uploadpack.allowFilter true`, `git config diff.tool vimdiff`, `git config diff.algorithm patience`,
    `git config remote.origin.fetch +refs/heads/*:refs/remotes/origin/*`, `git config gpg.format ssh`, `git config trailer.sign.key Signed-off-by`, `git config --get-all remote.origin.uploadpack`])
    assert.equal(git(c), null, c);
});

test("a git config write that moves where a fetch or push goes is a change to the remotes", () => {
  for (const c of ["git config remote.origin.url https://example.com/other.git", "git config remote.origin.pushurl x", "git config --add remote.origin.pushurl x",
    "git config url.https://example.com/.insteadOf https://github.com/", "git config url.x.pushInsteadOf y", "git config --replace-all remote.origin.url x",
    "git config set remote.origin.url x", "git config --unset remote.origin.pushurl", "git config unset url.x.insteadof", "git config --local Remote.Origin.URL x",
    "git config --file .git/config remote.origin.url x", "git -C sub config remote.origin.url x", "git config -- remote.origin.url x",
    "git config --rename-section zz url.https://example.com/", "git config --rename-section remote.origin remote.old",
    "git config --remove-section remote.origin", "git config remove-section url.x", "git config --unse remote.origin.pushurl",
    "git -c url.https://example.com/.insteadOf=https://github.com/ push", "git -c remote.origin.pushurl=x push origin main", "git --config-env=remote.origin.url=V push",
    "git config --unset-all remote.origin.url"])
    assert.match(git(c) ?? "", /remotes needs the user/, c);
  for (const c of ["git config --get remote.origin.url", "git config remote.origin.url", "git config --get-regexp '^url[.]'", "git config get remote.origin.pushurl",
    "git config --get-urlmatch http https://example.com", "git config branch.night.remote origin", "git config --list", "git -c user.name=x push origin night",
    "git config --file .git/config remote.origin.url", "git config -- remote.origin.url", "git config --unset core.editor"])
    assert.equal(git(c), null, c);
});

test("a push to a URL instead of a remote's name is refused: the place a push goes is the user's", () => {
  for (const c of ["git push https://example.com/o/r.git HEAD:main", "git push git@example.com:o/r.git main", "git push --repo=https://example.com/o/r.git",
    "git push --repo https://example.com/o/r.git", "git push file:///c/temp/x main", "git push -u ssh://git@example.com/o/r night", "git push -- https://example.com/o/r.git night",
    "git push example.com:o/r.git main", "git push --repo=host:o/r.git", "git push --rep host:o/r.git", "git push -o ci.skip https://example.com/o/r.git night",
    "git push -uo ci:skip https://example.com/x.git night", "git push -uoci:skip https://example.com/x.git night"])
    assert.match(git(c) ?? "", /URL/, c);
  for (const c of ["git push origin HEAD:refs/heads/night", "git push -u origin night", "git push origin main:main", "git push", "git push ../bare night", "git push origin 'HEAD@{1}:night'",
    "git push origin night@2:night", "git push -o ci.skip origin night", "git push --push-option ci@x:y origin night", "git push C:/temp/bare night", "git push -- origin night",
    "git push -uo ci:skip origin night", "git push -qo ci:skip -u origin night", "git push -uoci:skip origin night"])
    assert.equal(git(c), null, c);
});

test("node's inline script is one word of JavaScript: a quoted path with a colon in it is no delete target", () => {
  // The shape of session 08's read-only probe (2026-11-19), refused as "a path with an NTFS stream name".
  const probe = String.raw`cd /c/work/repo/scripts && node -e "
import('./guard.mjs').then(({ decide }) => {
  const env = { NIGHT_SHIFT_REPO: 'C:/work/repo', NIGHT_SHIFT_STATE: 'C:/temp/x-night', USERPROFILE: 'C:/Users/u' };
  const bash = (command) => decide({ tool_name: 'Bash', tool_input: { command } }, env);
  console.log('inside temp:', JSON.stringify(bash('cd \"/c/temp/My Game/..\" && rm -rf old')));
  console.log('unquoted lost cd:', JSON.stringify(bash('cd \$X && rm -rf old')).slice(0, 80));
});"`;
  assert.equal(bash(probe), null);
  for (const c of [`node -p "process.env.A + ':' + 'rm -rf x'"`, `node -e "f('rm -rf C:/Users/u/x')"`, `node --eval "f('rm -rf C:/Users/u/x')"`,
    `node --print="f('rm -rf C:/Users/u/x')"`, `node -pe "'rm -rf a:b'"`, `C:/tools/node.exe -e "f('rm -rf C:/Users/u/x')"`, `node --input-type=module -e "f('rm -rf C:/x')"`,
    `node -ep "f('rm -rf C:/Users/u/x')"`, `node --eval="f('rm -rf C:/Users/u/x')"`])
    assert.equal(bash(c), null, c);
  // An option with a value before the script ends the search (decisions, session 12): the script is read, a false refusal kept on purpose.
  assert.ok(bash(`node -r x.js -e "'rm -rf a:b'"`));
  // What the shell does around the script is still read: a substitution in it, a redirect, a pipe, the next command, words after it.
  for (const c of [`node -e "x" > C:/Users/u/.claude/settings.json`, `node -e "x" && rm -rf C:/Users/u/Documents`, `node -e "$(rm -rf /c/Users/u/Documents)"`,
    `node -p "1" | tee C:/temp/x-night/run.json`, `node -e "x" rm -rf C:/Users/u/Documents`, `bash -c 'node -e "x"; rm -rf ~/Documents'`, `node -e "x" -- rm -rf C:/Users/u/Documents`,
    // after a script file, -p and -e are the script's own words: what follows them is still read
    `node node_modules/rimraf/bin.js -p C:/Users/u/Documents`, `node tools/rm.mjs -e "rm -rf C:/Users/u/Documents"`])
    assert.ok(bash(c), c);
});

test("a transport option that names a program is refused wherever git takes one", () => {
  for (const c of [`git fetch --upload-pack='rm -rf /c/Users/u/Documents;' origin`, `git fetch --upload-pack x origin`, `git fetch --upload origin`, `git pull --ff-only --upload-pack=x`,
    `git push --receive-pack=x origin night`, `git push --exec=x origin night`, `git push --rece x`, `git ls-remote --upload-pack=x origin`, `git clone -u x url`, `git clone -qu x url`,
    `git clone --upload-pack=x url`, `git archive --exec=x HEAD`, `git fetch origin --upload-pack=x`, `git -C /c/temp/y fetch --upload-pack=x`])
    assert.ok(git(c), c);
  for (const c of [`git fetch origin`, `git fetch --all --prune`, `git fetch --update-head-ok origin`, `git clone --depth 1 url`, `git clone -b dev url`, `git clone -q url dir`, `git archive -o x.zip HEAD`,
    `git archive --remote=origin HEAD`, `git ls-remote origin`, `git ls-remote --heads origin`, `git push -u origin night`, `git pull --ff-only`, `git fetch origin -- --upload-pack=x`])
    assert.equal(git(c), null, c);
});

test("restoring or checking out every file by a glob is the same as the whole tree", () => {
  for (const c of [`git checkout -- '*'`, `git checkout -- *`, `git restore '*'`, `git restore *`, `git restore :/*`, `git restore ':/*'`, `git checkout -- :/*`, `git checkout -- './*'`, `git restore --worktree '*'`])
    assert.match(git(c) ?? "", /whole tree/, c);
  for (const c of [`git checkout -- src/*.ts`, `git restore --staged '*'`, `git restore src/a.ts`, `git checkout main`, `git checkout -- src/a.ts`])
    assert.equal(git(c), null, c);
});

test("git's options given through a variable the walker knows are read as the value", () => {
  for (const c of [`F=--force; git push $F origin main`, `F=--force; git push "$F" origin main`, `F=--force; git push \${F} origin main`, `export F=--hard; git reset $F HEAD`, `F='--force --no-verify'; git push $F origin`,
    `B=:old; git push origin $B`, `OPT=--amend; git commit $OPT`, `D=--delete; F=$D; git push $F origin x`, `O=-f; git push $O`, `F=--force; git -C app push $F`])
    assert.ok(git(c), c);
  for (const c of [`F=--no-verify; git commit $F -m x`, `M=--force; git commit -m "$M"`, `B=night; git push origin $B`, `git push origin $UNSET`, `F=--force; git status $F`, `git commit -m 'cost $5 and $X'`])
    assert.equal(git(c), null, c);
});

// The findings the 2026-11-16 reviews deferred: forms the walker did not read, and everyday commands it refused.
const atHome = (command) => decide({ tool_name: "Bash", cwd: "C:\\Users\\u", tool_input: { command } }, env);

test("a find delete from the repository is refused when an -o branch deletes without a test of its own", () => {
  for (const c of ["find . -name x -o -delete", "find . -name '*.tmp' -o -type f -delete", "find . -delete -o -delete", String.raw`find . \( -name '*.tmp' -o -true \) -delete`,
    String.raw`find . -name '*.tmp' -o -exec rm {} \;`])
    assert.match(bash(c) ?? "", /find delete/, c);
  for (const c of ["find . -name '*.tmp' -o -name '*.bak' -delete", String.raw`find . \( -name '*.tmp' -o -name '*.bak' \) -delete`, "find . -path ./.git -prune -o -type f -delete",
    "find . -name '*.tmp' -delete -o -name '*.bak' -delete", "find . -name '*.tmp' -delete -o -print"])
    assert.equal(bash(c), null, c);
});

test("a find delete from the repository whose test can match a file inside .git or .claude is refused", () => {
  for (const c of ["find . -name HEAD -delete", "find . -name config -delete", "find . -iname 'head' -delete", "find . -name 'pack-*.pack' -delete", "find . -name '*.sample' -delete",
    "find . -name logs -exec rm -rf {} +", "find . -name night-shift.json -delete", "find . -name '*.json' -delete", "find . -name 'settings*.json' -delete", "find . -path '*/hooks/*' -delete",
    "find . -name .claude -exec rm -rf {} +", "find . -path './.claude/*' -delete", "find . -not -name .git -delete"])
    assert.match(bash(c) ?? "", /find delete/, c);
  for (const c of ["find . -name '*.pyc' -delete", "find . -name '*.log' -delete", "find . -name HEAD -not -path './.git/*' -delete", "find src -name config -delete",
    "find . -name '*.json' -path './dist/*' -delete", "find . -path './src/*' -name index -delete", "find . -path '*/node_modules/*' -name '*.map' -delete", "find . ! -path './.git/*' -type f -delete"])
    assert.equal(bash(c), null, c);
});

test("a cd inside a group or a compound command does not move what follows its & or its pipeline", () => {
  for (const c of ["{ cd C:/temp; } & rm -rf Documents", "{ cd C:/temp; } | cat; rm -rf Documents", "if true; then cd C:/temp; fi & rm -rf Documents",
    "for i in 1; do cd C:/temp; done | cat; rm -rf Documents", "while true; do cd C:/temp; break; done & rm -rf Documents", "true && { cd C:/temp; } & rm -rf Documents",
    "cat x | { cd C:/temp; cat; }; rm -rf Documents", "if a; then b; else if c; then cd C:/temp; fi; fi & rm -rf Documents"])
    assert.match(atHome(c) ?? "", /limited to the repository and temp/, c);
  // a group fed by a pipe keeps its own cd for the commands inside it
  for (const c of ["cat x | { cd /c/Users/u; rm -rf Documents; }", "cat x | if cd /c/Users/u; then rm -rf Documents; fi", "cat x | while read f; do cd /c/Users/u; rm -rf Documents; done"])
    assert.match(bash(c) ?? "", /limited to the repository and temp/, c);
  for (const c of ["{ cd C:/temp; rm -rf old; }", "{ cd C:/temp; }; rm -rf old", "if cd C:/temp; then rm -rf old; fi", "{ cd C:/temp; } && rm -rf old", "cat x | { cd C:/temp; rm -rf old; }",
    "cd C:/temp; for i in 1 2; do echo $i; done | cat; rm -rf old", "cd C:/temp; { echo a; echo b; } | cat; rm -rf old"])
    assert.equal(atHome(c), null, c);
});

test("a PowerShell delete at the end of a pipeline is judged by the folder its listing names", () => {
  for (const c of [String.raw`gci C:\Users\u -Recurse | Remove-Item -Force`, String.raw`Get-ChildItem C:\Users\u\Documents | del`, String.raw`gci C:\Users\u\Documents | % { Remove-Item $_.FullName }`,
    String.raw`gci C:\Users\u\Documents | ForEach-Object { Remove-Item $_.FullName -Force }`, String.raw`Get-ChildItem -Path C:\Users\u\Documents -File | Where-Object { $_.Length -gt 0 } | Remove-Item`,
    String.raw`ls ~\Documents | rm`, String.raw`gci C:\work\repo\.git -Recurse | Remove-Item -Force`, String.raw`gci C:\temp\x-night | ri -Force`, "Get-ChildItem . -Recurse | Remove-Item -Force",
    "Get-ChildItem -Recurse -Force | Remove-Item -Force", "gci . | Remove-Item -Recurse -Force", "gci . -Recurse -Filter HEAD | Remove-Item -Force", String.raw`dir C:\Users\u\Documents,dist | Remove-Item`,
    String.raw`gci C:\Users\u\Documents | % { Remove-Item $_.FullName -Recurse }`, String.raw`Get-Item C:\Users\u\Documents | Remove-Item -Recurse -Force`, "gci . -Filter .g* | ri -Recurse -Force",
    String.raw`Get-ChildItem -Path C:\Users\u\Documents -File | ForEach-Object { $_.Delete() }`, String.raw`gci C:\temp\x-night\shots | ri -Force`])
    assert.ok(ps(c), c);
  assert.ok(bash(String.raw`powershell -c "gci C:\Users\u\Documents | Remove-Item -Force"`));
  for (const c of ["gci dist -Filter *.map | Remove-Item -Force", "Get-ChildItem . -Filter *.tmp | Remove-Item", "Get-ChildItem -Recurse -Filter *.log | Remove-Item -Force",
    "Get-ChildItem dist | Remove-Item -Recurse -Force", "Get-ChildItem -Recurse -Directory -Filter __pycache__ | Remove-Item -Recurse -Force", "Get-ChildItem . -Recurse -Include *.pyc | Remove-Item -Force",
    "gci dist -Recurse | Remove-Item -Force", String.raw`gci C:\temp\x\shots | ri -Force`, "$files | Remove-Item", "Get-Content list.txt | Remove-Item", "gci dist | % { Remove-Item $_.FullName }",
    "ls | ? Name -like '*.tmp' | rm", "Get-Item dist | Remove-Item -Recurse -Force"])
    assert.equal(ps(c), null, c);
});

test("a file edited in place, or written through a tool's own option, is a write", () => {
  for (const c of ["sed -i s/a/b/ C:/temp/x-night/run.json", "sed -i.bak -e s/a/b/ .git/config", "sed -ni /x/p .claude/night-shift.json", "sed --in-place s/a/b/ .claude/settings.json",
    "perl -pi -e s/a/b/ C:/temp/x-night/night-settings.json", "dd if=/dev/zero of=C:/temp/x-night/run.json", "truncate -s 0 C:/temp/x-night/chain.log", "install -m 644 x .git/hooks/pre-commit",
    "curl -o C:/temp/x-night/run.json https://example.com/x", "curl -sL https://example.com/x --output .git/config", "wget -O .claude/night-shift.json https://example.com/x",
    "touch C:/temp/x-night/reload-request", "rsync -a x/ .git/hooks/"])
    assert.match(bash(c) ?? "", /not allowed during a night run/, c);
  for (const c of ["New-Item -ItemType File -Path .claude/night-shift.json -Force", "ni .claude/night-shift.json -Force", "Clear-Content C:/temp/x-night/chain.log", "Rename-Item .claude/night-shift.json x.json",
    "New-Item -Path C:/temp/x-night -Name run.json"])
    assert.match(ps(c) ?? "", /not allowed during a night run/, c);
  for (const c of ["sed -i s/a/b/ src/a.js", "sed -i.bak -e 's/a/b/' package.json", "sed -i 's/a: b/c/' src/a.yml", "sed -n /x/p C:/temp/x-night/run.json", "perl -ne 'print if /x/' .git/config",
    "dd if=.git/config of=C:/temp/x/config.bak", "truncate -s 0 C:/temp/x-night/notes.log", "curl -o C:/temp/x/a.zip https://example.com/a.zip", "touch src/new.js", "cat C:/temp/x-night/run.json"])
    assert.equal(bash(c), null, c);
  for (const c of ["New-Item -ItemType Directory dist -Force", "Clear-Content build.log", "Rename-Item a.txt b.txt", "New-Item notes.txt -Value 'at 12:30'"]) assert.equal(ps(c), null, c);
});

test("a move takes its source away, so it is held to the folders a delete is; shred is a delete", () => {
  for (const c of ["mv C:/Users/u/Documents C:/temp/gone", "mv ~/Documents/a.txt .", "mv -t C:/temp/gone C:/Users/u/Documents C:/Users/u/Desktop", "mv C:/work/repo C:/temp/gone", "mv C:/temp/x-night C:/temp/y",
    "shred -u C:/Users/u/Documents/a.txt", "shred C:/temp/x-night/run.json"])
    assert.ok(bash(c), c);
  for (const c of [String.raw`Move-Item C:\Users\u\Documents C:\temp\gone`, String.raw`Move-Item -Path C:\Users\u\Documents -Destination C:\temp\gone`, String.raw`mi C:\Users\u\Documents C:\temp\gone`])
    assert.match(ps(c) ?? "", /moves are limited/, c);
  for (const c of ["mv src/a.js src/b.js", "mv dist C:/temp/x/dist", "mv C:/temp/x/a.zip .", "git mv a b", "shred -u C:/temp/x/secret.txt", `for f in *.txt; do mv "$f" "$f.bak"; done`]) assert.equal(bash(c), null, c);
  assert.equal(ps("Move-Item a.txt b.txt"), null);
});

test("ksh, fish, busybox, wsl and su run the command they are given, and it is read", () => {
  for (const c of ["ksh -c 'rm -rf ~/Documents'", "fish -c 'rm -rf ~/Documents'", "busybox sh -c 'rm -rf ~/Documents'", "su -c 'rm -rf /c/Users/u/Documents'", "su - u -c 'git push -f'",
    "wsl bash -c 'rm -rf ~/Documents'", "wsl -d Ubuntu -e bash -c 'git push -f'", "wsl env HOME=/tmp/x git status", "ksh <<'EOF'\nrm -rf ~/Documents\nEOF", "ssh host HOME=/x git status"])
    assert.ok(git(c), c);
  for (const c of ["ksh -c 'npm test'", "busybox ls", "wsl ls -la", "wsl bash -c 'rm -rf dist'", "su -c 'npm test'", "wsl --shutdown", "ssh host git status"]) assert.equal(git(c), null, c);
});

test("a backslash before an ordinary character hides neither a command's name nor an option", () => {
  for (const c of [String.raw`r\m -rf ~/Documents`, String.raw`git push --for\ce origin main`, String.raw`g\it push -f`, String.raw`\rm -rf /c/Users/u/Documents`, String.raw`rm -r\f /c/Users/u/Documents`,
    String.raw`rm -rf C:/temp/x\-night`])
    assert.ok(git(c), c);
  for (const c of [String.raw`\rm -rf dist`, String.raw`\ls -la`, String.raw`rm -rf C:\temp\x\old`, String.raw`echo a\ b`]) assert.equal(git(c), null, c);
});

test("a ~user path is a home folder too", () => {
  for (const c of ["rm -rf ~u/Documents", "rm -f ~u/a.txt", "rm -rf ~root"]) assert.match(bash(c) ?? "", /home folder/, c);
  assert.equal(bash(`rm -f '~$report.docx'`), null);
});

test("deleting a tag, forcing a worktree away, pruning objects and replaying history need the user", () => {
  for (const c of ["git tag -d v1", "git tag --delete v1", "git worktree remove --force ../wt", "git worktree remove -f ../wt", "git gc --prune=now", "git gc --aggressive --prune=all", "git prune",
    "git replay --onto main a..b", "git history reword HEAD~2"])
    assert.ok(git(c), c);
  for (const c of ["git tag v1.0", "git tag -l 'v*'", "git tag -a v1 -m 'x -d y'", "git worktree remove ../wt", "git worktree add ../wt -b night", "git worktree prune", "git gc", "git gc --auto", "git gc --prune"])
    assert.equal(git(c), null, c);
});

test("a config section renamed into one whose keys git runs, and a home pointed elsewhere, are refused", () => {
  for (const c of ["git config --rename-section zz core", "git config --rename-section zz alias", "git config rename-section zz core", "USERPROFILE=C:/temp/x git status",
    "declare -x HOME=C:/temp/x; git status", "local -r HOME=C:/temp/x; git status"])
    assert.ok(git(c), c);
  for (const c of ["git config --rename-section branch.old branch.new", "declare -x FOO=1; git status", "USERPROFILE_BACKUP=x git status"]) assert.equal(git(c), null, c);
});

test("a quoted variable is one word for git: a message that names an option stays a message", () => {
  for (const c of [`M='fix --amend docs'; git commit -m "$M"`, `MSG='reset --hard was wrong'; git commit -am "$MSG"`, `T='notes --force'; git tag -a v1 -m "$T"`]) assert.equal(git(c), null, c);
  for (const c of [`F='--force origin'; git push $F main`, `F=--force; git push "$F" origin main`, `OPT=--amend; git commit "$OPT"`]) assert.ok(git(c), c);
});

test("git clone's attached -b value is not read as -u", () => {
  for (const c of ["git clone -bfeature https://github.com/a/b dir", "git clone -bu url", "git clone -qbupdate url", "git clone -oupstream url"]) assert.equal(git(c), null, c);
  for (const c of ["git clone -ub url", "git clone -qu x url", "git clone -u x url", "git clone -lu x url"]) assert.ok(git(c), c);
});

test("a command git takes from the environment is read with the variables it cannot resolve left in place", () => {
  assert.equal(git(`GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes" git fetch`), null);
  for (const c of ["GIT_SSH_COMMAND=$MYSSH git fetch", `GIT_SSH_COMMAND="$TOOL -rf /c/Users/u/Documents" git fetch`, `GIT_SSH_COMMAND="rm -rf $SOMEWHERE" git fetch`]) assert.ok(git(c), c);
});

test("what a find -exec deletes recursively is judged by the find's own start path and tests", () => {
  for (const c of ["find . -type d -name __pycache__ -exec rm -rf {} +", "find . -name node_modules -prune -exec rm -rf {} +", "find dist -mindepth 1 -exec rm -rf {} +",
    String.raw`find C:/temp/x -name 'old-*' -exec rm -rf {} \;`, "find /tmp -name 'x-*' -delete"])
    assert.equal(bash(c), null, c);
  for (const c of ["find . -exec rm -rf {} +", "find . -name .git -exec rm -rf {} +", "find /c/Users/u -name cache -exec rm -rf {} +", "find C:/temp -maxdepth 1 -exec rm -rf {} +",
    "find /tmp -delete", "find /tmp -mindepth 1 -exec rm -rf {} +", "find C:/temp/x-night -exec rm -rf {} +"])
    assert.ok(bash(c), c);
});

test("a PowerShell switch written with a value (-Confirm:$false) is no delete target", () => {
  for (const c of ["Remove-Item dist -Recurse -Force -Confirm:$false", "Remove-Item -Path dist -Recurse -Confirm:$false", "Remove-Item old.txt -Confirm:$false"]) assert.equal(ps(c), null, c);
  for (const c of [String.raw`Remove-Item C:\Users\u\Documents -Recurse -Force -Confirm:$false`, "Remove-Item -Recurse -Confirm:$false", "Remove-Item -Recurse -Path:$x"]) assert.ok(ps(c), c);
});

test("a brace list in a recursive delete is read as the paths it stands for", () => {
  for (const c of ["rm -rf dist/{a,b}", "rm -rf {dist,build}", "rm -rf build/{cache,tmp} dist", "rm -rf C:/temp/x/{a,b}/{c,d}"]) assert.equal(bash(c), null, c);
  for (const c of ["rm -rf {/c/Users/u/Documents,x}", "rm -rf {.,x}", "rm -rf {~,x}", "rm -rf .{git,x}", "rm -rf ./{a,b}/../..", "rm -rf x{,/../../Users/u}", `rm -rf ${"{a,b}".repeat(8)}`])
    assert.ok(bash(c), c);
});

test("a mktemp template under the temp folder names a folder there", () => {
  for (const c of ["D=$(mktemp -d /tmp/x.XXXXXX); rm -rf $D", `D="$(mktemp -d /tmp/build.XXXXXX)" && rm -rf "$D"`]) assert.equal(bash(c), null, c);
  for (const c of ["D=$(mktemp -d /tmp/foo); rm -rf $D/*", `D="$(mktemp -d /c/Users/u/Documents/x.XXXXXX)"; rm -rf "$D"`, "D=$(mktemp -d /c/Users/u/Documents/x.XXXXXX); rm -rf $D"]) assert.ok(bash(c), c);
});

test("reading git config is no change; a pager or editor given with -c is read as the command it is", () => {
  for (const c of ["git config --get core.editor --local", "git config core.pager --get", "git config --global --get user.name", "git config --global user.email", "git config get core.editor",
    "git config --list --show-origin", "git -c core.editor=true cherry-pick --continue", "git -c core.pager=cat log", "git -c pager.log=false log", "git -c core.pager= log"])
    assert.equal(git(c), null, c);
  for (const c of ["git config --global user.name x", "git config core.editor vim", "git config --add core.pager cat", "git -c core.editor='rm -rf /c/Users/u/Documents' commit",
    `git -c core.pager="$X" log`, "git -c core.fsmonitor=x status", "git config --global --unset user.name", "git config --global -e", "git config set core.editor vim", "git config --get core.editor --unset"])
    assert.ok(git(c), c);
});

test("xargs may hand file names to a git command that only takes them as paths", () => {
  for (const c of ["git ls-files -m | xargs git add", "git ls-files -z -o --exclude-standard | xargs -0 git add --", "git diff --name-only | xargs git checkout --", "git ls-files '*.js' | xargs git diff --stat"])
    assert.equal(git(c), null, c);
  for (const c of ["cat list | xargs git rm", "cat list | xargs git push", "cat list | xargs git checkout", "cat list | xargs git clean --", "cat list | xargs git push --force --", "cat list | xargs git rm --",
    "cat list | xargs git push origin --", "cat list | xargs -I{} git checkout {} --"])
    assert.ok(git(c), c);
});

test("a night session cannot write or delete the rule and config files", () => {
  const rules = /the project's night-shift rules/, mine = /the user's night-shift settings and rules/;
  assert.match(write("C:/work/repo/.claude/night-shift-rules.md"), rules);
  assert.match(bash("echo 'push is fine' >> .claude/night-shift-rules.md"), rules);
  assert.match(bash("rm .claude/night-shift-rules.md"), /refusing a delete of the project's night-shift rules/);
  assert.ok(bash("rm -f C:/work/repo/.claude/night-shift-*"));
  assert.match(ps("Set-Content .claude\\night-shift-rules.md 'x'"), rules);
  assert.equal(bash("cat .claude/night-shift-rules.md"), null);
  // Outside the writable roots the folder was refused too; the new reason names it.
  assert.match(write("C:/Users/u/.claude/night-shift/rules.md"), mine);
  assert.match(write("C:/Users/u/.claude/night-shift/runs/x.json"), mine);
  assert.match(write("C:/USERS/U/.Claude/Night-Shift/Config.json"), mine);
  assert.match(write("C:/Users/u/.claude/night-shift/../night-shift/config.json"), mine);
  assert.match(bash("rm -f C:/Users/u/.claude/night-shift/rules.md"), /refusing a delete of the user's night-shift settings and rules/);
  assert.ok(bash("rm -f C:/Users/u/.claude/night-*/rules.md"));
  assert.ok(bash("find . -name night-shift-rules.md -delete"));
});

test("a run whose repository is ~/.claude still cannot touch the global rule and config files", () => {
  const inHome = { ...env, NIGHT_SHIFT_REPO: "C:/Users/u/.claude" };
  const mine = /the user's night-shift settings and rules/;
  assert.match(write("C:/Users/u/.claude/night-shift/rules.md", inHome), mine);
  assert.match(write("C:/Users/u/.claude/night-shift/config.json", inHome), mine);
  assert.match(bash("rm night-shift/rules.md", inHome), mine);
  assert.match(bash("echo x > night-shift/config.json", inHome), mine);
  assert.match(bash("rm -rf night-shift", inHome), mine);
  assert.equal(write("C:/Users/u/.claude/notes.md", inHome), null);
  assert.equal(bash("echo x > notes.md", inHome), null);
});

test("a find or a listing from a repository at ~/.claude cannot reach the global rule and config files by name", () => {
  const inHome = { ...env, NIGHT_SHIFT_REPO: "C:/Users/u/.claude" };
  for (const c of ["find . -name rules.md -delete", "find . -name config.json -delete", "find . -path '*/night-shift/*' -delete", "find . -name rules.md -exec rm {} +",
    "find . -name night-shift -exec rm -rf {} +", "find . -path './night-shift/*' -delete", "find . -path './night-shift/rules.md' -delete", "find . -path './night-*/*' -delete", "find C:/Users/u/.claude -iname 'RULES.MD' -delete", "find . -name 'rules*' -delete"])
    assert.ok(bash(c, inHome), c);
  for (const c of ["Get-ChildItem . -Recurse -Filter config.json | Remove-Item", "gci -Recurse -Include rules.md | ri"]) assert.ok(ps(c, inHome), c);
  for (const c of ["find . -name notes.md -delete", "find . -path './projects/*' -delete", "find . -path './skills/*' -delete", "find ./skills -name x.md -delete"]) assert.equal(bash(c, inHome), null, c);
  assert.equal(ps("Get-ChildItem . -Recurse -Filter notes.md | Remove-Item", inHome), null);
  // Only a start path that covers the folder reads those names as inside it: elsewhere they are ordinary names.
  assert.equal(bash("find . -name rules.md -delete"), null);
  assert.equal(bash("find . -path './night-shift/*' -delete"), null);
  assert.equal(bash("find src -name config.json -delete", { ...env, NIGHT_SHIFT_REPO: "C:/Users/u/.claude" }), null);
  assert.equal(ps("Get-ChildItem . -Recurse -Filter config.json | Remove-Item"), null);
});

// ---------------------------------------------------------------- a linked ~/.claude (2026-11-18)
test("a home whose .claude is a link: its protected files are protected under the link's target too", () => {
  // On the user's PC ~/.claude is a junction to another folder; `echo x > <that folder>/settings.json` passed.
  const base = mkdtempSync(join(tempRoot(), "night-linked-home-"));
  const target = join(base, "settings-folder"), home = join(base, "home");
  mkdirSync(join(target, "skills", "night-shift", "scripts"), { recursive: true });
  mkdirSync(join(target, "night-shift"));
  mkdirSync(home);
  symlinkSync(target, join(home, ".claude"), "junction");
  const t = target.replace(/\\/g, "/"), h = home.replace(/\\/g, "/");
  const e = { ...env, USERPROFILE: home };
  try {
    for (const c of [`echo x > "${t}/settings.json"`, `echo x >> "${t}/CLAUDE.md"`, `cp a.mjs "${t}/skills/night-shift/scripts/guard.mjs"`,
      `echo x > "${t}/night-shift/rules.md"`, `echo '{}' > "${t.toUpperCase()}/SETTINGS.LOCAL.JSON"`, `echo x > "${h}/.claude/settings.json"`])
      assert.match(bash(c, e) ?? "", /Claude settings|global CLAUDE\.md|night-shift skill|night-shift settings/, c);
    assert.equal(bash(`echo x > "${t}/notes.md"`, e), null);
    // The repository is that folder, named by its real path (Write and Edit are limited to the roots).
    const inTarget = { ...e, NIGHT_SHIFT_REPO: t };
    const write = (file_path) => decide({ tool_name: "Write", tool_input: { file_path } }, inTarget);
    assert.match(write(`${t}/settings.json`) ?? "", /Claude settings/);
    assert.match(write(`${t}/skills/night-shift/SKILL.md`) ?? "", /night-shift skill/);
    assert.equal(write(`${t}/notes.md`), null);
    assert.match(bash(`rm -f "${t}"/settings.*`, inTarget) ?? "", /Claude settings/);
    assert.match(bash("find . -name rules.md -delete", inTarget) ?? "", /find delete/);
    assert.equal(bash("find . -name notes.md -delete", inTarget), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
test("a linked home known only by an MSYS HOME (no USERPROFILE) still knows the link's target", () => {
  const base = mkdtempSync(join(tempRoot(), "night-linked-home-"));
  const target = join(base, "settings-folder"), home = join(base, "home");
  mkdirSync(target);
  mkdirSync(home);
  symlinkSync(target, join(home, ".claude"), "junction");
  const t = target.replace(/\\/g, "/");
  // Git Bash's HOME: /c/Users/u for C:\Users\u.
  const e = { ...env, HOME: home.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`) };
  delete e.USERPROFILE;
  try {
    assert.match(bash(`echo x > "${t}/settings.json"`, e) ?? "", /Claude settings/);
    assert.match(bash(`echo x > "${t}/night-shift/rules.md"`, e) ?? "", /night-shift settings/);
    assert.equal(bash(`echo x > "${t}/notes.md"`, e), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// U16: with CLAUDE_CONFIG_DIR set, Claude Code keeps its settings, skills and the user's night-shift folder there.
test("a folder named by CLAUDE_CONFIG_DIR is protected as ~/.claude is, also by its link's target, and ~/.claude stays protected", () => {
  const e = { ...env, CLAUDE_CONFIG_DIR: "C:/temp/claude-config" };
  const write = (file_path, en = e) => decide({ tool_name: "Write", tool_input: { file_path } }, en);
  for (const [c, why] of [["echo x > C:/temp/claude-config/settings.json", /Claude settings/], ["echo x > C:/temp/claude-config/CLAUDE.md", /global CLAUDE\.md/],
    ["cp a.mjs C:/temp/claude-config/skills/night-shift/scripts/guard.mjs", /night-shift skill/], ["echo x > C:/temp/claude-config/night-shift/rules.md", /night-shift settings/],
    ["rm -rf C:/temp/claude-config/night-shift", /night-shift settings/], ["echo x > C:/Users/u/.claude/settings.json", /Claude settings/]])
    assert.match(bash(c, e) ?? "", why, c);
  assert.match(write("C:/temp/claude-config/skills/night-shift/SKILL.md") ?? "", /night-shift skill/);
  assert.equal(write("C:/temp/claude-config/notes.md"), null, "the rest of a folder in temp stays writable");
  // Without the variable that folder is only a folder in temp.
  assert.equal(write("C:/temp/claude-config/CLAUDE.md", env), null);
  // A state folder inside that folder is no writable root (stateDirProblem reads the guard's own env).
  const inCfg = { ...env, CLAUDE_CONFIG_DIR: "D:/claude-config", NIGHT_SHIFT_STATE: "D:/claude-config/night" };
  assert.match(write("D:/claude-config/night/notes.md", inCfg) ?? "", /writes are limited/);
  assert.equal(write("D:/claude-config/night/notes.md", { ...inCfg, CLAUDE_CONFIG_DIR: undefined }), null);
  const base = mkdtempSync(join(tempRoot(), "night-config-dir-"));
  const target = join(base, "real-config"), link = join(base, "config-link");
  mkdirSync(target);
  symlinkSync(target, link, "junction");
  try {
    const t = target.replace(/\\/g, "/");
    assert.match(bash(`echo x > "${t}/settings.json"`, { ...env, CLAUDE_CONFIG_DIR: link }) ?? "", /Claude settings/);
    assert.equal(bash(`echo x > "${t}/notes.md"`, { ...env, CLAUDE_CONFIG_DIR: link }), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- C4 follow-up: the run's skill folder and the plugins
// The runner puts the folder of the copy it runs from into every session's environment (NIGHT_SHIFT_SKILL), the hook's
// included: wherever that copy is (a plugin's cache, a folder of the user's own), the guard names it as the skill itself.
const SKILL_AT = "D:/tools/night-shift";
const withSkill = (dir, e = env) => ({ ...e, NIGHT_SHIFT_SKILL: dir });
const edit = (file_path, e = env) => decide({ tool_name: "Edit", tool_input: { file_path, old_string: "a", new_string: "b" } }, e);
test("the run's skill folder is the night-shift skill itself wherever it is: Write, Edit, a redirect, the in-place writers and deletes", () => {
  const s = withSkill(SKILL_AT);
  for (const c of [`cp a.mjs ${SKILL_AT}/scripts/guard.mjs`, `echo x > ${SKILL_AT}/SKILL.md`, `echo x >> ${SKILL_AT}/references/goal.md`,
    `echo x | tee ${SKILL_AT}/SKILL.md`, `sed -i s/a/b/ ${SKILL_AT}/SKILL.md`, `rm ${SKILL_AT}/scripts/guard.mjs`, `rm -rf ${SKILL_AT}`,
    `rm -f ${SKILL_AT}/scripts/*.mjs`, `mv x.mjs ${SKILL_AT}/scripts/guard.mjs`])
    assert.match(bash(c, s) ?? "", /the night-shift skill itself/, c);
  assert.match(ps(`Set-Content ${SKILL_AT}/SKILL.md x`, s) ?? "", /the night-shift skill itself/);
  assert.match(write(`${SKILL_AT}/SKILL.md`, s) ?? "", /writing the night-shift skill itself is not allowed/);
  assert.match(edit(`${SKILL_AT}/scripts/guard.mjs`, s) ?? "", /writing the night-shift skill itself is not allowed/);
  // Other spellings of the same folder: case, backslashes, .., Git Bash's drive, \\?\.
  for (const c of [`echo x > "D:\\TOOLS\\Night-Shift\\SKILL.md"`, "echo x > D:/tools/x/../night-shift/SKILL.md", "echo x > /d/tools/night-shift/SKILL.md",
    `cp a '\\\\?\\D:\\tools\\night-shift\\SKILL.md'`])
    assert.match(bash(c, s) ?? "", /the night-shift skill itself/, c);
  assert.match(bash("echo x > /d/tools/night-shift/SKILL.md", withSkill("/d/tools/night-shift")) ?? "", /the night-shift skill itself/, "the variable in Git Bash's spelling");
  assert.match(bash(`echo x > ${SKILL_AT}/SKILL.md`, withSkill("D:\\tools\\night-shift\\")) ?? "", /the night-shift skill itself/, "the variable with backslashes");
  // The folder next to it is not the skill, and without the variable nothing changes: a shell write outside the roots passes,
  // Write and Edit meet only the folders' limit.
  assert.equal(bash("echo x > D:/tools/night-shift-old/SKILL.md", s), null);
  assert.equal(bash(`cp a.mjs ${SKILL_AT}/scripts/guard.mjs`), null);
  assert.match(write(`${SKILL_AT}/SKILL.md`) ?? "", /writes are limited to/);
  assert.match(bash(`rm ${SKILL_AT}/scripts/guard.mjs`) ?? "", /deletes are limited to/);
  // A copy in a temp folder, where everything else may be written and deleted.
  const inTemp = withSkill("C:/temp/copy/night-shift");
  assert.match(write("C:/temp/copy/night-shift/SKILL.md", inTemp) ?? "", /the night-shift skill itself/);
  assert.match(bash("rm -rf C:/temp/copy/*", inTemp) ?? "", /the night-shift skill itself through a wildcard/);
  assert.equal(write("C:/temp/copy/notes.md", inTemp), null);
  assert.equal(bash("rm -rf C:/temp/copy/old", inTemp), null);
  // A folder above it takes it along: a delete or a move of that folder is refused too.
  for (const c of ["rm -rf C:/temp/copy", "mv C:/temp/copy C:/temp/copy2", "rm -r /c/temp/copy/"])
    assert.match(bash(c, inTemp) ?? "", /of a folder that holds the night-shift skill itself/, c);
  assert.match(ps("Remove-Item -Recurse C:\\temp\\copy", inTemp) ?? "", /of a folder that holds the night-shift skill itself/);
  assert.equal(bash("rm -rf C:/temp/other", inTemp), null);
  // The same holds for the project's .claude folder, which a wildcard could not delete either; what is below it can go.
  for (const c of ["rm -rf .claude", "rm -rf C:/work/repo/.claude/", "mv .claude old-claude"]) assert.match(bash(c) ?? "", /of the project's \.claude folder/, c);
  assert.equal(bash("rm -rf .claude/worktrees/x"), null);
  assert.equal(bash("find . -name '*.tmp' -delete"), null, "a find from the repository is read by its tests, as before");
  // A drive-relative value (C:x) names a folder below that drive's own folder, as resolve() reads it (a path C:x itself
  // is refused as a stream name in any write).
  const driveRelative = resolve("C:tools-x/night-shift").replace(/\\/g, "/");
  assert.match(bash(`echo x > "${driveRelative}/SKILL.md"`, withSkill("C:tools-x/night-shift")) ?? "", /the night-shift skill itself/);
});

test("a skill folder inside the repository, or one that is or holds the repository, a temp root, the home, a drive or the state folder, changes nothing", () => {
  // A chain that develops the skill from its own clone: the clone is the repository's to change.
  const clone = withSkill("C:/work/repo/night-shift");
  assert.equal(write("C:/work/repo/night-shift/SKILL.md", clone), null);
  assert.equal(bash("cp a.mjs C:/work/repo/night-shift/scripts/guard.mjs", clone), null);
  assert.equal(bash("rm -rf C:/work/repo/night-shift/scripts/old", clone), null);
  assert.equal(write("C:/work/repo/night-shift/SKILL.md", withSkill("c:\\WORK\\repo\\Night-Shift")), null, "in another spelling");
  for (const [dir, shown] of [["C:/work/repo", "the repository"], ["C:/work", "a folder above the repository"], ["C:/temp", "a temp root"],
    ["C:/Users/u/AppData/Local/Temp", "the home's temp folder"], ["C:/Users/u/AppData", "a folder that holds a temp root"], ["C:/Users/u", "the home"],
    ["C:/Users", "a folder above the home"], ["D:/", "a drive"], ["D:", "a drive without its slash"], ["C:/temp/x-night", "the state folder"]]) {
    const e = withSkill(dir);
    assert.equal(write("C:/work/repo/src/a.ts", e), null, `${shown}: the repository stays writable`);
    assert.equal(bash("rm -rf C:/work/repo/dist", e), null, `${shown}: and its folders deletable`);
    assert.equal(write("C:/temp/x-night/notes.md", e), null, `${shown}: the state folder stays writable`);
    assert.equal(bash("echo x > C:/temp/a.txt", e), null, `${shown}: the temp folder stays writable`);
    assert.equal(bash("echo x > C:/Users/u/AppData/Local/Temp/a.txt", e), null, `${shown}: the home's temp folder too`);
  }
  assert.equal(bash("echo x > C:/Users/u/notes.md", withSkill("C:/Users/u")), null, "a skill folder that is the home names no file");
  assert.equal(bash("echo x > D:/a.txt", withSkill("D:/")), null, "nor one that is a drive");
  // A skill folder that holds the state folder would make the runner's handover unwritable.
  const holdsState = { ...withSkill(SKILL_AT), NIGHT_SHIFT_STATE: `${SKILL_AT}/state` };
  assert.equal(write(`${SKILL_AT}/state/next-prompt.md`, holdsState), null);
  assert.equal(bash(`echo x > ${SKILL_AT}/SKILL.md`, holdsState), null);
});

test("Claude Code's installed plugins are refused under every spelling of ~/.claude; plugins/data stays writable", () => {
  const plugins = "C:/Users/u/.claude/plugins";
  for (const c of [`cp a.mjs ${plugins}/cache/m/p/1.0.0/hooks/x.mjs`, `echo x > ${plugins}/marketplaces/m/.claude-plugin/marketplace.json`,
    `echo {} > ${plugins}/installed_plugins.json`, `echo {} > ${plugins}/known_marketplaces.json`, `sed -i s/a/b/ ${plugins}/installed_plugins.json`,
    `rm -rf ${plugins}/cache/m`, `rm ${plugins}/known_marketplaces.json`, `rm -rf ${plugins}/marketplaces`, `echo x > "C:\\USERS\\U\\.CLAUDE\\PLUGINS\\CACHE\\m\\x"`,
    `echo x > ${plugins}/data/../cache/m/x`, `echo x > ~/.claude/plugins/cache/m/x`])
    assert.match(bash(c) ?? "", /Claude Code's installed plugins/, c);
  assert.match(write(`${plugins}/cache/m/p/1.0.0/hooks/x.mjs`) ?? "", /writing Claude Code's installed plugins is not allowed/);
  assert.match(edit(`${plugins}/installed_plugins.json`) ?? "", /writing Claude Code's installed plugins is not allowed/);
  assert.match(ps(`Set-Content ${plugins}/known_marketplaces.json x`) ?? "", /Claude Code's installed plugins/);
  // Where plugins keep their own data, and the rest of the folder, are as before.
  assert.equal(bash(`echo x > ${plugins}/data/p/x.json`), null);
  assert.equal(bash(`cp a ${plugins}/data/p/y.json`), null);
  assert.equal(bash(`echo x > ${plugins}/cache-notes.md`), null);
  // With the repository at ~/.claude the plugins stay protected inside it.
  const inHome = { ...env, NIGHT_SHIFT_REPO: "C:/Users/u/.claude" };
  assert.match(write(`${plugins}/cache/m/x.mjs`, inHome) ?? "", /installed plugins/);
  assert.match(bash("rm -rf plugins/cache", inHome) ?? "", /installed plugins/);
  assert.match(bash("rm -rf plugins/*", inHome) ?? "", /installed plugins through a wildcard/);
  assert.equal(write(`${plugins}/data/p/x.json`, inHome), null);
  assert.match(bash("rm -rf plugins", inHome) ?? "", /of a folder that holds Claude Code's installed plugins/);
  assert.equal(bash("rm -rf plugins/data/p", inHome), null);
  // Under CLAUDE_CONFIG_DIR's folder, and ~/.claude's stay protected.
  const cfg = { ...env, CLAUDE_CONFIG_DIR: "C:/temp/claude-config" };
  assert.match(write("C:/temp/claude-config/plugins/cache/m/x.mjs", cfg) ?? "", /installed plugins/);
  assert.match(bash("echo {} > C:/temp/claude-config/plugins/installed_plugins.json", cfg) ?? "", /installed plugins/);
  assert.match(bash(`cp a ${plugins}/cache/m/x`, cfg) ?? "", /installed plugins/);
  assert.equal(write("C:/temp/claude-config/plugins/data/p/x.json", cfg), null);
});

test("CLAUDE_CODE_PLUGIN_CACHE_DIR names one more plugins folder, unless it is or holds the repository, a temp root, the home, a drive or the state folder", () => {
  const e = { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: "D:/plugins" };
  for (const c of ["cp a D:/plugins/cache/m/x.mjs", "echo {} > D:/plugins/installed_plugins.json", "rm -rf D:/plugins/marketplaces/m", "echo x > 'D:\\PLUGINS\\known_marketplaces.json'"])
    assert.match(bash(c, e) ?? "", /Claude Code's installed plugins/, c);
  assert.equal(bash("echo x > D:/plugins/data/p/x.json", e), null);
  assert.match(bash("cp a C:/Users/u/.claude/plugins/cache/m/x", e) ?? "", /installed plugins/, "the default folder stays protected");
  assert.equal(bash("cp a D:/plugins/cache/m/x.mjs"), null, "without the variable D:/plugins is any folder");
  // In a temp folder: protected there, the rest of temp writable.
  const inTemp = { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: "C:/temp/plugins" };
  assert.match(write("C:/temp/plugins/cache/m/x.mjs", inTemp) ?? "", /installed plugins/);
  assert.match(bash("rm -rf C:/temp/plugins", inTemp) ?? "", /of a folder that holds Claude Code's installed plugins/);
  assert.equal(write("C:/temp/notes.md", inTemp), null);
  for (const dir of ["C:/work/repo", "C:/work", "C:/temp", "C:/Users/u", "C:/Users/u/AppData/Local/Temp", "C:/Users", "D:", "C:/temp/x-night"]) {
    const v = { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: dir };
    assert.equal(bash(`echo {} > ${dir}/cache/a.json`, v), null, `${dir}: ignored`);
    assert.equal(bash(`echo {} > ${dir}/installed_plugins.json`, v), null, `${dir}: ignored`);
    assert.equal(write("C:/work/repo/src/a.ts", v), null, `${dir}: the repository stays writable`);
    assert.equal(write("C:/temp/x-night/notes.md", v), null, `${dir}: the state folder stays writable`);
  }
  assert.equal(write("C:/work/repo/cache/a.ts", { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: "C:/work/repo" }), null);
  assert.equal(write("C:/temp/x-night/cache/a.ts", { ...env, CLAUDE_CODE_PLUGIN_CACHE_DIR: "C:/temp/x-night" }), null);
});

test("a linked home's and a linked skill folder's targets are protected too", () => {
  const base = mkdtempSync(join(tempRoot(), "night-skill-link-"));
  const target = join(base, "settings-folder"), home = join(base, "home"), repo = join(base, "repo"), real = join(repo, "skill-real"), link = join(base, "skill-link");
  mkdirSync(join(target, "plugins", "cache"), { recursive: true });
  mkdirSync(home);
  mkdirSync(real, { recursive: true });
  symlinkSync(target, join(home, ".claude"), "junction");
  symlinkSync(real, link, "junction");
  const t = target.replace(/\\/g, "/"), h = home.replace(/\\/g, "/"), r = real.replace(/\\/g, "/");
  const e = { ...env, USERPROFILE: home };
  try {
    // ~/.claude is a link: its plugins by the target's path, and a skill folder in its cache by either spelling.
    assert.match(bash(`cp a "${t}/plugins/cache/m/x.mjs"`, e) ?? "", /installed plugins/);
    assert.match(bash(`echo {} > "${t}/plugins/installed_plugins.json"`, e) ?? "", /installed plugins/);
    assert.equal(bash(`echo x > "${t}/plugins/data/p/x.json"`, e), null);
    const cached = withSkill(`${h}/.claude/plugins/cache/night-shift/night-shift/0.3.0/night-shift`, e);
    assert.match(bash(`echo x > "${t}/plugins/cache/night-shift/night-shift/0.3.0/night-shift/SKILL.md"`, cached) ?? "", /the night-shift skill itself/);
    // The skill folder is a link: the folder it points at is the skill too.
    assert.match(bash(`echo x > "${r}/SKILL.md"`, withSkill(link, e)) ?? "", /the night-shift skill itself/);
    assert.match(bash(`echo x > "${link.replace(/\\/g, "/")}/SKILL.md"`, withSkill(link, e)) ?? "", /the night-shift skill itself/);
    // A linked skill folder whose target is inside the repository (not the repository itself) is the repository's.
    const inRepo = { ...withSkill(link, e), NIGHT_SHIFT_REPO: repo.replace(/\\/g, "/") };
    assert.equal(bash(`echo x > "${r}/SKILL.md"`, inRepo), null);
    assert.equal(decide({ tool_name: "Write", tool_input: { file_path: `${r}/SKILL.md` } }, inRepo), null);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

// C5: the path rules of macOS and Linux, judged on any system through decide()'s platform (platform.mjs).
const posixOf = (name, deps = {}) => platformFor(name, { tmpdir: () => "/tmp", realpath: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); }, homedir: () => "/home/node", ...deps });
const LINUX = posixOf("linux"), MAC = posixOf("darwin");
const penv = { NIGHT_SHIFT_REPO: "/work/Repo", NIGHT_SHIFT_STATE: "/tmp/x-night", HOME: "/home/u" };
const pbash = (command, platform, e = penv, cwd) => decide({ tool_name: "Bash", tool_input: { command }, ...(cwd ? { cwd } : {}) }, e, { platform });
const pwrite = (file_path, platform, e = penv) => decide({ tool_name: "Write", tool_input: { file_path } }, e, { platform });

test("on Linux the repository is the folder in its own case; on macOS any case of it is the repository", () => {
  assert.equal(pwrite("/work/Repo/src/a.ts", LINUX), null);
  assert.match(pwrite("/work/repo/src/a.ts", LINUX), /writes are limited to the repository, \/tmp and the temp folder/);
  assert.equal(pwrite("/work/repo/src/a.ts", MAC), null);
  assert.match(pbash("rm -rf /work/REPO", MAC), /recursive delete of the repository/);
  assert.match(pbash("rm -rf /work/REPO", LINUX), /limited to the repository and temp folders/);
  assert.match(pwrite("/work/Repo/.GIT/config", MAC), /\.git directory/);
});

test("off Windows ~/.claude is found by HOME, and USERPROFILE names no home", () => {
  for (const P of [LINUX, MAC]) {
    assert.match(pbash("echo x > /home/u/.claude/CLAUDE.md", P), /global CLAUDE\.md/);
    assert.match(pbash("cp a.mjs /home/u/.claude/skills/night-shift/scripts/guard.mjs", P), /night-shift skill itself/);
    assert.match(pbash("echo x > ~/.claude/night-shift/rules.md", P), /night-shift settings and rules/);
  }
  const profile = { NIGHT_SHIFT_REPO: "/work/Repo", USERPROFILE: "/home/u" };
  assert.equal(pbash("echo x > /home/u/.claude/CLAUDE.md", LINUX, profile), null);
  assert.match(pbash("echo x > /home/node/.claude/CLAUDE.md", LINUX, profile), /global CLAUDE\.md/);
});

test("off Windows a drive, a backslash and a doubled slash are read as POSIX reads them", () => {
  // C:/.. is a folder named C: and its parent, so from ~/.claude this names ~/.claude/settings.json.
  assert.match(pbash("cd /home/u/.claude && echo x > C:/../settings.json", LINUX), /Claude settings/);
  assert.match(pbash("cd /home/u/.claude && cp a C:/../CLAUDE.md", LINUX), /global CLAUDE\.md/);
  assert.match(pbash("echo x > //home/u/.claude/skills/night-shift/SKILL.md", LINUX), /night-shift skill itself/);
  // A backslash is part of a name: /work/Repo\x is a file beside the repository.
  assert.match(pwrite("/work/Repo\\x.ts", LINUX), /writes are limited/);
  assert.equal(pwrite("/work/Repo/a\\b.ts", LINUX), null);
});

test("off Windows the runner's files keep their capitals and the user's CLAUDE.md its name, and both stay protected", () => {
  for (const P of [LINUX, MAC]) {
    for (const f of ["STOP-REQUEST", "RELOAD-REQUEST", "chain.log", "run.json", "night-settings.json"])
      assert.match(pwrite(`/tmp/x-night/${f}`, P), /runner's own files/, f);
    assert.equal(pwrite("/tmp/x-night/next-prompt.md", P), null);
    assert.match(pwrite("/home/u/.claude/CLAUDE.md", P), /global CLAUDE\.md/);
  }
});

test("off Windows /tmp is a temp root, and a colon or ~1 in a name is ordinary", () => {
  for (const P of [LINUX, MAC]) {
    assert.equal(pwrite("/tmp/a.md", P), null);
    assert.equal(pbash("rm -rf /tmp/build-x", P), null);
    assert.equal(pbash("rm /work/Repo/a:b /work/Repo/a~1", P), null);
    assert.match(pbash("rm -rf /tmp", P), /refusing a (recursive )?delete/);
  }
  assert.equal(pbash("rm -rf /private/tmp/build-x", MAC), null);
  assert.match(pbash("rm -rf /private/tmp/build-x", LINUX), /limited to the repository and temp folders/);
  // C:/temp/x is a relative path there: a folder named C: in the repository.
  assert.equal(pbash("rm C:/temp/x", LINUX), null);
  assert.match(pbash("cd /home/u && rm C:/temp/x", LINUX), /limited to the repository and temp folders/);
  assert.match(pwrite("/users/u/.claude/settings.json/..namedfork/rsrc", MAC), /resource fork/);
});

test("on macOS /private/var and /var, and the data volume and /, are one spelling, so a session's TMPDIR meets the runner's state folder", () => {
  const mac = posixOf("darwin", { tmpdir: () => "/var/folders/ab/X/T", realpath: (t) => (t === "/var/folders/ab/X/T" ? "/private/var/folders/ab/X/T" : t) });
  const e = { NIGHT_SHIFT_REPO: "/Users/u/work/Repo", NIGHT_SHIFT_STATE: "/private/var/folders/ab/X/T/night-shift-Repo", HOME: "/Users/u" };
  assert.match(pbash("echo x > /var/folders/ab/X/T/night-shift-Repo/run.json", mac, e), /runner's own files/);
  assert.match(pbash("echo x > /private/var/folders/ab/X/T/night-shift-Repo/chain.log", mac, e), /runner's own files/);
  assert.equal(pwrite("/var/folders/ab/X/T/night-shift-Repo/next-prompt.md", mac, e), null);
  assert.equal(pwrite("/var/folders/ab/X/T/build/a.txt", mac, e), null);
  assert.match(pbash("echo x > /System/Volumes/Data/Users/u/.claude/CLAUDE.md", mac, e), /global CLAUDE\.md/);
  assert.match(pbash("echo x > /private/tmp/Repo/.git/config", mac, { ...e, NIGHT_SHIFT_REPO: "/tmp/Repo" }), /\.git directory/);
});

test("on Linux a path through /proc is refused, and /dev/null stays writable", () => {
  assert.match(pbash("echo x > /proc/self/cwd/.git/hooks/pre-commit", LINUX), /\/proc path/);
  assert.match(pbash("rm -rf /proc/self/root/home/u/x", LINUX), /\/proc path/);
  assert.equal(pbash("echo x > /dev/null 2> /dev/stderr", LINUX), null);
});

test("off Windows a state folder in a system or login folder is no writable root", () => {
  assert.match(pwrite("/home/u/.config/autostart/x.desktop", LINUX, { ...penv, NIGHT_SHIFT_STATE: "/home/u/.config/autostart" }), /writes are limited/);
  assert.match(pwrite("/etc/night/x", LINUX, { ...penv, NIGHT_SHIFT_STATE: "/etc/night" }), /writes are limited/);
  assert.equal(pwrite("/home/u/.local/state/night/x.md", LINUX, { ...penv, NIGHT_SHIFT_STATE: "/home/u/.local/state/night" }), null);
});

test("on Linux find's narrowing reads a mixed-case start path in lower case, as it reads the patterns", () => {
  assert.match(pbash("find /work/Repo -path '*/Repo/*' -delete", LINUX), /find delete from the repository/);
  assert.match(pbash("find /work/Repo -name HEAD -delete", LINUX), /find delete from the repository/);
  assert.equal(pbash("find /work/Repo -name '*.tmp' -delete", LINUX), null);
});

test("on Linux a Windows drive under /mnt/<letter> compares in any case and refuses an 8.3 name", () => {
  const e = { ...penv, NIGHT_SHIFT_REPO: "/mnt/c/Work/Repo" };
  assert.match(pwrite("/mnt/c/work/repo/.GIT/config", LINUX, e), /\.git directory/);
  assert.match(pbash("echo x > /mnt/c/Work/Repo/GIT~1/config", LINUX, e), /short \(8\.3\) name/);
  assert.equal(pwrite("/mnt/c/WORK/REPO/src/a.ts", LINUX, e), null);
});

test("runner.err, where a detached runner's start failures go, is the runner's own file on every system", () => {
  assert.match(write("C:/temp/x-night/runner.err"), /runner's own/);
  assert.match(pwrite("/tmp/x-night/runner.err", LINUX), /runner's own/);
  assert.match(pbash("echo x > /tmp/x-night/runner.err", MAC), /runner's own/);
  assert.equal(pwrite("/tmp/x-night/runner.errors.md", LINUX), null);
});
