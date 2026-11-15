// The recursive-delete check: only a delete's own command is read, a here-document's
// text is data, and a variable target must resolve. node --test guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decide } from "./guard.mjs";

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

// A repo in a throwaway folder whose .claude/night-shift.json holds `text`.
const repoWithConfig = (text) => {
  const repo = mkdtempSync(join(tmpdir(), "guard-config-test-"));
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
