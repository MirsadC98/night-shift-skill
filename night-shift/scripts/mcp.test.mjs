// node --test mcp.test.mjs — which MCP servers a night run starts, and from which config each comes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// A CLAUDE_CONFIG_DIR of the user's own would move the files these tests read (claudeHome in config.mjs).
delete process.env.CLAUDE_CONFIG_DIR;
import { listedServers, mcpArgs } from "./mcp.mjs";
import { mcpToolName } from "./config.mjs";

const put = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data)); };

// A home with a user server, a local server of the repository, a project .mcp.json and three installed plugins:
// one with a wrapped .mcp.json, one with an unwrapped one, one with its servers inline in plugin.json.
function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "night-mcp-test-"));
  const home = path.join(root, "home"), repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const cache = path.join(home, ".claude", "plugins", "cache");
  const ctx = path.join(cache, "official", "ctx", "1.0.0"), gh = path.join(cache, "official", "gh", "2.0.0"), steam = path.join(cache, "steam-market", "steam", "0.4.0");
  put(path.join(home, ".claude.json"), {
    numStartups: 3,
    mcpServers: { github: { type: "stdio", command: "gh-mcp", args: [], env: { TOKEN: "${GH_TOKEN}" } }, shared: { type: "http", url: "https://user.example/mcp" } },
    projects: { [repo.replace(/\\/g, "/")]: { mcpServers: { shared: { type: "http", url: "https://local.example/mcp" } } }, "C:/elsewhere": { mcpServers: { other: { command: "x" } } } },
  });
  put(path.join(repo, ".mcp.json"), { mcpServers: { db: { command: "db-mcp", args: ["--ro"] }, shared: { type: "http", url: "https://project.example/mcp" } } });
  put(path.join(home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: {
    "ctx@official": [{ scope: "user", installPath: ctx, version: "1.0.0" }],
    "gh@official": [{ scope: "project", projectPath: "C:/elsewhere", installPath: path.join(root, "nowhere") }, { scope: "user", installPath: gh }],
    "steam@steam-market": [{ scope: "user", installPath: steam }],
  } });
  put(path.join(ctx, ".mcp.json"), { mcpServers: { ctx: { type: "http", url: "https://ctx.example/mcp" } } });
  put(path.join(gh, ".mcp.json"), { github: { type: "http", url: "https://gh.example/mcp", headers: { Authorization: "Bearer ${GH_PAT}" } } });
  put(path.join(steam, ".claude-plugin", "plugin.json"), { name: "steam", mcpServers: { steamworks: { command: "uv", args: ["run", "--project", "${CLAUDE_PLUGIN_ROOT}", "--cache", "${CLAUDE_PLUGIN_DATA}", "steamworks-mcp"], env: { ROOT: "${CLAUDE_PLUGIN_ROOT}/data", CLAUDE_PLUGIN_DATA: "own" } } } });
  return { root, home, repo, ctx, gh, steam, env: {} };
}

test("a server's part of its tools' names: what is not a letter, a digit, _ or - becomes _", () => {
  assert.equal(mcpToolName("github"), "github");
  assert.equal(mcpToolName("plugin:context7:context7"), "plugin_context7_context7");
  assert.equal(mcpToolName("claude.ai Claude Docs"), "claude_ai_Claude_Docs");
  assert.equal(mcpToolName("my-server_2"), "my-server_2");
});

test("a list names servers of the user, the repository's local and project ones, and plugins' by either spelling", () => {
  const s = scene();
  const r = listedServers(["github", "db", "plugin:ctx:ctx", "plugin_steam_steamworks", "plugin:gh:github"], s);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(Object.keys(r.servers), ["github", "db", "plugin_ctx_ctx", "plugin_steam_steamworks", "plugin_gh_github"]);
  // A server's config is copied as it is, ${VAR} included: the CLI expands it.
  assert.deepEqual(r.servers.github, { type: "stdio", command: "gh-mcp", args: [], env: { TOKEN: "${GH_TOKEN}" } });
  assert.deepEqual(r.servers.db, { command: "db-mcp", args: ["--ro"] });
  assert.deepEqual(r.servers.plugin_ctx_ctx, { type: "http", url: "https://ctx.example/mcp" });
  // A plugin's own folders are filled in, outside the plugin loader nothing else would; a server it starts gets them in
  // its environment too, as the loader gives them, and keeps a value its config sets.
  const data = path.join(s.home, ".claude", "plugins", "data", "steam-steam-market");
  assert.deepEqual(r.servers.plugin_steam_steamworks, { command: "uv", args: ["run", "--project", s.steam, "--cache", data, "steamworks-mcp"],
    env: { CLAUDE_PLUGIN_ROOT: s.steam, CLAUDE_PLUGIN_DATA: "own", ROOT: `${s.steam}/data` } });
  // The install of another project is not this one's.
  assert.deepEqual(r.servers.plugin_gh_github, { type: "http", url: "https://gh.example/mcp", headers: { Authorization: "Bearer ${GH_PAT}" } });
  assert.deepEqual(r.found.map((f) => [f.name, f.source]), [["github", "user"], ["db", "project"], ["plugin:ctx:ctx", "plugin"], ["plugin:steam:steamworks", "plugin"], ["plugin:gh:github", "plugin"]]);
});

test("a name in several places takes the CLI's order: this project's local server, then .mcp.json, then the user's", () => {
  const s = scene();
  assert.equal(listedServers(["shared"], s).servers.shared.url, "https://local.example/mcp");
  assert.equal(listedServers(["shared"], s).found[0].source, "local");
  const claude = JSON.parse(fs.readFileSync(path.join(s.home, ".claude.json"), "utf8"));
  delete claude.projects;
  put(path.join(s.home, ".claude.json"), claude);
  assert.equal(listedServers(["shared"], s).servers.shared.url, "https://project.example/mcp");
  fs.rmSync(path.join(s.repo, ".mcp.json"));
  assert.equal(listedServers(["shared"], s).servers.shared.url, "https://user.example/mcp");
});

test("a name no config holds is missing, and one server named twice starts once", () => {
  const s = scene();
  const r = listedServers(["claude.ai Claude Docs", "other", "plugin:ctx:ctx", "plugin_ctx_ctx", "plugin:nope:x"], s);
  // "other" is a local server of another project.
  assert.deepEqual(r.missing, ["claude.ai Claude Docs", "other", "plugin:nope:x"]);
  assert.deepEqual(Object.keys(r.servers), ["plugin_ctx_ctx"]);
});

test("files that are missing, broken or of another shape are no servers and no crash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "night-mcp-test-"));
  const home = path.join(root, "home"), repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const where = { home, repo, env: {} };
  assert.deepEqual(listedServers(["github"], where), { servers: {}, found: [], missing: ["github"] });
  put(path.join(home, ".claude.json"), "{ not json");
  put(path.join(repo, ".mcp.json"), "[]");
  put(path.join(home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { "p@m": [{ scope: "user" }], "q@m": "odd", "r@m": [{ installPath: 5 }] } });
  assert.deepEqual(listedServers(["github"], where).missing, ["github"]);
  // Lists where maps belong, and a server that is no object.
  put(path.join(home, ".claude.json"), { mcpServers: [{ github: {} }], projects: [repo] });
  put(path.join(repo, ".mcp.json"), { mcpServers: { github: "gh-mcp", db: { command: "db" } } });
  assert.deepEqual(listedServers(["github", "db"], where).missing, ["github"]);
  // A project's .mcp.json without its mcpServers wrapper is not read (the CLI's format has it).
  put(path.join(repo, ".mcp.json"), { db: { command: "db" } });
  assert.deepEqual(listedServers(["db"], where).missing, ["db"]);
});

test("a plugin.json may declare its servers as a .json file, or a list of files and maps; a bundle is skipped", () => {
  const s = scene();
  put(path.join(s.steam, ".claude-plugin", "plugin.json"), { name: "steam", mcpServers: ["./servers.json", { inline: { command: "i" } }, "./pack.mcpb"] });
  put(path.join(s.steam, "servers.json"), { mcpServers: { filed: { command: "f" } } });
  const r = listedServers(["plugin:steam:filed", "plugin:steam:inline", "plugin:steam:pack"], s);
  assert.deepEqual(r.missing, ["plugin:steam:pack"]);
  assert.deepEqual(Object.keys(r.servers), ["plugin_steam_filed", "plugin_steam_inline"]);
});

test("the repository's key in .claude.json matches in any slash and drive-letter case", { skip: process.platform !== "win32" && "a backslash and a drive letter's case spell one path only on Windows" }, () => {
  const s = scene();
  const claude = JSON.parse(fs.readFileSync(path.join(s.home, ".claude.json"), "utf8"));
  const key = Object.keys(claude.projects)[0];
  claude.projects = { [key[0].toLowerCase() + key.slice(1).replace(/\//g, "\\")]: claude.projects[key] };
  put(path.join(s.home, ".claude.json"), claude);
  const upper = { ...s, repo: s.repo[0].toUpperCase() + s.repo.slice(1) };
  assert.equal(listedServers(["shared"], upper).found[0].source, "local");
});

test("CLAUDE_CONFIG_DIR moves .claude.json and the plugins into that folder", () => {
  const s = scene();
  const dir = path.join(s.root, "config-dir");
  put(path.join(dir, ".claude.json"), { mcpServers: { moved: { command: "m" } } });
  const env = { CLAUDE_CONFIG_DIR: dir };
  assert.deepEqual(listedServers(["moved", "github", "plugin:ctx:ctx"], { ...s, env }).missing, ["github", "plugin:ctx:ctx"]);
  assert.deepEqual(listedServers(["moved"], { ...s, env }).servers, { moved: { command: "m" } });
});

test("the flags a session starts with: none for inherit, no server for none or an empty list, the listed ones for a list", () => {
  const s = scene();
  assert.deepEqual(mcpArgs("inherit", s), { args: [], missing: [] });
  assert.deepEqual(mcpArgs("none", s), { args: ["--strict-mcp-config"], missing: [] });
  assert.deepEqual(mcpArgs(undefined, s), { args: ["--strict-mcp-config"], missing: [] });
  assert.deepEqual(mcpArgs([], s), { args: ["--strict-mcp-config"], missing: [] });
  const listed = mcpArgs(["db", "gone"], s);
  assert.deepEqual(listed.missing, ["gone"]);
  assert.deepEqual(listed.args.slice(0, 2), ["--strict-mcp-config", "--mcp-config"]);
  assert.deepEqual(JSON.parse(listed.args[2]), { mcpServers: { db: { command: "db-mcp", args: ["--ro"] } } });
  assert.deepEqual(mcpArgs(["gone"], s), { args: ["--strict-mcp-config"], missing: ["gone"] });
});
