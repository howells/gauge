import assert from "node:assert/strict";
import { test } from "node:test";
import { raceWithTimeout } from "../src/runtime/deadline.js";

test("raceWithTimeout returns the timeout value for a never-settling operation", async () => {
  const started = Date.now();
  const result = await raceWithTimeout(
    new Promise<boolean>(() => undefined),
    10,
    false,
  );

  assert.equal(result, false);
  assert.ok(Date.now() - started < 1_000);
});

test("raceWithTimeout preserves a completed operation", async () => {
  assert.equal(await raceWithTimeout(Promise.resolve(true), 100, false), true);
});
