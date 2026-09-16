import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertSafeName,
  getAccountPath,
  getDataDir,
  getProfileDir,
  getStorageStatePath,
} from "../src/paths.js";

const expectedDir = path.join(os.homedir(), ".gauge");
const RE_DIRNAME = /__dirname/;
const RE_DIST = /\/dist\//;
const RE_NODE_MODULES = /node_modules/;

test("getDataDir returns ~/.gauge", () => {
  assert.equal(getDataDir(), expectedDir);
});

test("getAccountPath returns file inside data dir", () => {
  const result = getAccountPath("test");
  assert.ok(result.startsWith(expectedDir));
  assert.ok(result.endsWith("test.json"));
});

test("getStorageStatePath returns file inside data dir", () => {
  const result = getStorageStatePath("test");
  assert.ok(result.startsWith(expectedDir));
  assert.ok(result.endsWith("test-storage.json"));
});

test("getProfileDir returns dir inside data dir", () => {
  const result = getProfileDir("test");
  assert.ok(result.startsWith(expectedDir));
  assert.ok(result.includes("profile-test"));
});

test("rejects path traversal in account names", () => {
  const bad = [
    "../evil",
    "../../.ssh/keys",
    "foo/bar",
    "/absolute",
    "a b c",
    "",
  ];
  for (const name of bad) {
    assert.throws(() => getAccountPath(name), /invalid characters/);
    assert.throws(() => getStorageStatePath(name), /invalid characters/);
    assert.throws(() => getProfileDir(name), /invalid characters/);
  }
});

test("accepts valid account names", () => {
  const good = ["personal", "work-2", "my_account", "ABC123"];
  for (const name of good) {
    assert.doesNotThrow(() => assertSafeName(name));
  }
});

test("no paths contain __dirname, dist, or node_modules", () => {
  const paths = [
    getDataDir(),
    getAccountPath("x"),
    getStorageStatePath("x"),
    getProfileDir("x"),
  ];
  for (const p of paths) {
    assert.doesNotMatch(p, RE_DIRNAME);
    assert.doesNotMatch(p, RE_DIST);
    assert.doesNotMatch(p, RE_NODE_MODULES);
  }
});
