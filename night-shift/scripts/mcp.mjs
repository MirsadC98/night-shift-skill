// The MCP servers a night session starts. With a list in the project's "mcp", the runner passes
// --strict-mcp-config and --mcp-config holding only the listed servers' own configs, so no other server
// starts and no other server's tools fill each call's context. Imports only node and config.mjs.
//   listedServers(list, { repo, home, env }) -> { servers: { key: config }, found: [{ name, key, source }], missing: [name] }
//   mcpArgs(mcp, { repo, home, env })        -> { args, missing }  the CLI flags for "none", "inherit" or a list
//   claudeJson(home, env)                    the user's .claude.json, where user and local servers are kept
//
// Where a server is looked for, in the CLI's own order when a name is in several places: this repository's
// local servers and the user's (`~/.claude.json`, or CLAUDE_CONFIG_DIR's `.claude.json`), the repository's
// `.mcp.json`, then the installed plugins (`plugins/installed_plugins.json` in the Claude folder). A plugin's
// server is named `plugin:<plugin>:<server>` and its tools `mcp__plugin_<plugin>_<server>__<tool>`; the list
// may use either spelling, and the session gets it under the second, so its tools keep their usual names.
// A claude.ai connector and a server packed as an .mcpb or .dxt bundle have no config to copy: they start
// only with "inherit".

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeHome, mcpToolName, norm } from "./config.mjs";

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")); } catch { return null; } };
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
// A map of server configs: { name: { command | url, … } }, with what is not an object left out.
const serverMap = (v) => (isObj(v) ? Object.fromEntries(Object.entries(v).filter(([, s]) => isObj(s))) : {});
// A .mcp.json is { mcpServers: { … } }; a plugin's may also be the map itself.
const mcpFile = (f, { bare = false } = {}) => { const j = readJson(f); return isObj(j?.mcpServers) ? serverMap(j.mcpServers) : bare ? serverMap(j) : {}; };
// Every string inside a config, with the plugin's variables (${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA}) filled in.
const withVars = (v, vars) => (typeof v === "string" ? Object.entries(vars).reduce((t, [k, x]) => t.split(`\${${k}}`).join(x), v)
  : Array.isArray(v) ? v.map((x) => withVars(x, vars)) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withVars(x, vars)])) : v);
// A plugin's server outside the plugin loader: its variables filled in, and a server it starts (command) gets them in its
// environment too, as the loader gives them, unless its own config sets them.
const asPluginServer = (config, vars) => {
  const c = withVars(config, vars);
  return typeof c.command === "string" ? { ...c, env: { ...vars, ...(isObj(c.env) ? c.env : {}) } } : c;
};
// The longest --mcp-config value start lets through: Windows ends a command line at 32,767 characters, all flags included.
export const MCP_ARG_MAX = 20_000;
export const mcpConfigArg = (servers) => JSON.stringify({ mcpServers: servers });

// The user's .claude.json: in CLAUDE_CONFIG_DIR's folder when it is set, else in the home folder (not in ~/.claude).
export const claudeJson = (home = os.homedir(), env = process.env) => (env.CLAUDE_CONFIG_DIR ? path.join(claudeHome(home, env), ".claude.json") : path.join(String(home), ".claude.json"));

// One plugin's servers: its root .mcp.json first, then what its plugin.json declares (a map, a .json file, or a list of those).
function pluginServers(root) {
  const out = { ...mcpFile(path.join(root, ".mcp.json"), { bare: true }) };
  const declared = readJson(path.join(root, ".claude-plugin", "plugin.json"))?.mcpServers;
  for (const d of Array.isArray(declared) ? declared : declared ? [declared] : []) {
    if (typeof d === "string" && /\.json$/i.test(d)) Object.assign(out, mcpFile(path.resolve(root, d), { bare: true }));
    else if (isObj(d)) Object.assign(out, isObj(d.mcpServers) ? serverMap(d.mcpServers) : serverMap(d));
  }
  return out;
}

// Every server a list may name, in the order a name is looked up.
function catalog({ repo, home, env }) {
  const items = [];
  const push = (source, servers, named = (n) => n, key = (n) => n) => {
    for (const [n, config] of Object.entries(servers)) items.push({ name: named(n), key: key(n), tool: mcpToolName(key(n)), source, config });
  };
  const cj = readJson(claudeJson(home, env));
  const projects = isObj(cj?.projects) ? cj.projects : {};
  const here = norm(repo);
  for (const [p, v] of Object.entries(projects)) if (norm(p) === here) push("local", serverMap(v?.mcpServers));
  push("project", mcpFile(path.join(String(repo), ".mcp.json")));
  push("user", serverMap(cj?.mcpServers));
  const installed = readJson(path.join(claudeHome(home, env), "plugins", "installed_plugins.json"))?.plugins;
  for (const [id, entries] of Object.entries(isObj(installed) ? installed : {})) {
    const at = id.includes("@") ? id.lastIndexOf("@") : id.length;
    const plugin = id.slice(0, at), market = id.slice(at + 1);
    // An install for another project is not this one's; this project's own comes first.
    const mine = (Array.isArray(entries) ? entries : [entries]).filter((e) => isObj(e) && typeof e.installPath === "string" && (!e.projectPath || norm(e.projectPath) === here));
    const entry = mine.find((e) => e.projectPath) || mine[0];
    if (!entry) continue;
    // The plugin's data folder is plugins/data/<plugin>-<marketplace> in the Claude folder.
    const vars = { CLAUDE_PLUGIN_ROOT: entry.installPath, CLAUDE_PLUGIN_DATA: path.join(claudeHome(home, env), "plugins", "data", market ? `${plugin}-${market}` : plugin) };
    const servers = Object.fromEntries(Object.entries(pluginServers(entry.installPath)).map(([n, c]) => [n, asPluginServer(c, vars)]));
    push("plugin", servers, (n) => `plugin:${plugin}:${n}`, (n) => mcpToolName(`plugin_${plugin}_${n}`));
  }
  return items;
}

export function listedServers(list, { repo, home = os.homedir(), env = process.env } = {}) {
  const items = catalog({ repo, home, env });
  const servers = {}, found = [], missing = [];
  for (const name of list) {
    // Its own name first (a local server called like a plugin's tools stays the local one), then its tools' spelling.
    const hit = items.find((i) => i.name === name) || items.find((i) => i.tool === mcpToolName(name));
    if (!hit) { missing.push(name); continue; }
    if (Object.hasOwn(servers, hit.key)) continue;
    servers[hit.key] = hit.config;
    found.push({ name: hit.name, key: hit.key, source: hit.source });
  }
  return { servers, found, missing };
}

// "inherit": every server the user has starts, as in an interactive session, and the guard lets all through.
// "none" (the default) and an empty list: no server. A list: only those it names.
export function mcpArgs(mcp, where = {}) {
  if (mcp === "inherit") return { args: [], missing: [] };
  if (!Array.isArray(mcp) || !mcp.length) return { args: ["--strict-mcp-config"], missing: [] };
  const { servers, missing } = listedServers(mcp, where);
  return { args: ["--strict-mcp-config", ...(Object.keys(servers).length ? ["--mcp-config", mcpConfigArg(servers)] : [])], missing };
}
