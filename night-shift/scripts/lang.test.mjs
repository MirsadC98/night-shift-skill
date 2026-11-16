// node --test night-shift/scripts/lang.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strings, langOf, LANG_NAMES } from "./lang/index.mjs";
import en from "./lang/en.mjs";
import tr from "./lang/tr.mjs";

const throwaway = () => fs.mkdtempSync(path.join(os.tmpdir(), "ns-lang-"));
const homeWithGlobal = (cfg) => {
  const home = throwaway();
  fs.mkdirSync(path.join(home, ".claude", "night-shift"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "night-shift", "config.json"), JSON.stringify(cfg));
  return home;
};

// Every key path of a table with the kind of its value; a nested object is walked.
const shape = (t, prefix = "") => Object.entries(t).flatMap(([k, v]) => (v && typeof v === "object" ? shape(v, `${prefix}${k}.`) : [[`${prefix}${k}`, typeof v]]));

test("the two tables have the same keys, each with the same kind of value", () => {
  assert.deepEqual(shape(en), shape(tr));
  assert.ok(shape(en).length > 50, "the walk reached the tables' contents");
});

test("an unknown language reads the English table", () => {
  assert.equal(strings("de"), strings("en"));
  assert.equal(strings(), strings("en"));
  assert.equal(strings("tr"), tr);
  assert.deepEqual(LANG_NAMES, { en: "English", tr: "Turkish" });
});

test("langOf: the run's own language, else the config files as they are now, else en", () => {
  const repo = path.join(throwaway(), "repo");
  assert.equal(langOf({ lang: "tr" }), "tr");
  assert.equal(langOf({ repo, lang: undefined }, homeWithGlobal({ lang: "tr" })), "tr");   // a run.json from before this change
  assert.equal(langOf({}, throwaway()), "en");
  assert.equal(langOf({ repo }, throwaway()), "en");
  assert.equal(langOf({}, homeWithGlobal({ lang: "tr" })), "tr");
  // the project's file wins over the global one; a value that is no language is not one
  fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "night-shift.json"), JSON.stringify({ lang: "en" }));
  assert.equal(langOf({ repo }, homeWithGlobal({ lang: "tr" })), "en");
  assert.equal(langOf({ repo: path.join(throwaway(), "x"), lang: "de" }, homeWithGlobal({ lang: "fr" })), "en");
});
