import assert from "node:assert/strict";
import { test } from "node:test";

import { findChrome } from "../src/chrome.js";

test("findChrome returns string or null", () => {
  const result = findChrome();
  assert.ok(result === null || typeof result === "string");
});

test("Chrome is found on this machine", () => {
  const result = findChrome();
  assert.ok(typeof result === "string", "Expected Chrome to be installed");
});
