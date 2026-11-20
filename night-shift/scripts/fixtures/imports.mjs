// For the tests: the ./*.mjs files a module imports statically, followed through each of them (the module itself
// included). A module loaded with import() from inside night-report.mjs or night-chain.mjs must reach neither: both end
// in a top-level await when they are the entry module, and that import() would never settle.
import fs from "node:fs";
import path from "node:path";

export function reached(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+["'](\.{1,2}\/[^"']+\.mjs)["']/gm)) reached(path.resolve(path.dirname(file), m[1]), seen);
  for (const m of text.matchAll(/^\s*import\s+["'](\.{1,2}\/[^"']+\.mjs)["']/gm)) reached(path.resolve(path.dirname(file), m[1]), seen);
  return seen;
}
