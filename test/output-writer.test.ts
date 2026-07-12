import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeConfinedOutput } from "../src/persistence/output-writer.js";

test("output writer tolerates an EEXIST parent-creation race", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-output-"));
  const output = writeConfinedOutput(cwd, "created/result.json", "value", {
    mkdir: (directory, options) => {
      fs.mkdirSync(directory, options);
      const error = new Error("already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    },
  });

  assert.equal(fs.readFileSync(output, "utf8"), "value");
});

test("output writer propagates unexpected path metadata failures", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-output-"));
  const failure = new Error("metadata unavailable") as NodeJS.ErrnoException;
  failure.code = "EACCES";

  assert.throws(
    () =>
      writeConfinedOutput(cwd, "result.json", "value", {
        lstat: () => {
          throw failure;
        },
      }),
    /metadata unavailable/,
  );
});
