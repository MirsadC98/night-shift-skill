// The recursive-delete check: only a delete's own command is read, a here-document's
// text is data, and a variable target must resolve. node --test guard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
