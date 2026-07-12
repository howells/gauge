import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atomicReplace } from "../src/persistence/atomic-replace.js";

test("atomicReplace flushes and replaces a file through a sibling temporary", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-atomic-"));
  const destination = path.join(directory, "result.json");
  fs.writeFileSync(destination, "old-content");

  atomicReplace(destination, "new-content", { mode: 0o600 });

  assert.equal(fs.readFileSync(destination, "utf8"), "new-content");
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(directory), ["result.json"]);
});

test("atomicReplace cleans up after a write path failure", () => {
  const missingParent = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gauge-atomic-")),
    "missing",
  );
  assert.throws(() =>
    atomicReplace(path.join(missingParent, "result.json"), "content"),
  );
  assert.equal(fs.existsSync(missingParent), false);
});

test("atomicReplace preserves the old file when replacement fails", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-atomic-"));
  const destination = path.join(directory, "result.json");
  fs.writeFileSync(destination, "old-content");

  assert.throws(
    () =>
      atomicReplace(destination, "new-content", {
        rename: () => {
          throw new Error("injected rename failure");
        },
      }),
    /injected rename failure/,
  );

  assert.equal(fs.readFileSync(destination, "utf8"), "old-content");
  assert.deepEqual(fs.readdirSync(directory), ["result.json"]);
});

test("atomicReplace closes an open descriptor and removes its temporary after write failure", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-atomic-"));
  const destination = path.join(directory, "state.json");
  let closes = 0;

  assert.throws(
    () =>
      atomicReplace(destination, "new", {
        close: (descriptor) => {
          closes += 1;
          fs.closeSync(descriptor);
        },
        write: () => {
          throw new Error("injected write failure");
        },
      }),
    /injected write failure/,
  );
  assert.equal(closes, 1);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test("atomicReplace reports replacement and cleanup failures together", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-atomic-"));
  const destination = path.join(directory, "state.json");

  assert.throws(
    () =>
      atomicReplace(destination, "new", {
        rename: () => {
          throw new Error("injected rename failure");
        },
        unlink: () => {
          throw new Error("injected cleanup failure");
        },
      }),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      /cleanup both failed/.test(error.message),
  );
});
