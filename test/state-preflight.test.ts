import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CLIError } from "../src/security.js";
import { assertStateCommandAllowed } from "../src/services/state-preflight.js";

test("migration preflight permits only describe, doctor, and migrate with legacy state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-preflight-"));
  fs.writeFileSync(
    path.join(root, "work.json"),
    JSON.stringify({
      name: "work",
      addedAt: "2026-01-01T00:00:00.000Z",
    }),
  );

  for (const command of ["describe", "doctor", "migrate"] as const) {
    assert.doesNotThrow(() => assertStateCommandAllowed(command, root));
  }
  for (const command of [
    "status",
    "list",
    "add",
    "refresh",
    "remove",
  ] as const) {
    assert.throws(
      () => assertStateCommandAllowed(command, root),
      (error: unknown) => {
        assert.ok(error instanceof CLIError);
        assert.equal(error.code, "MIGRATION_REQUIRED");
        assert.deepEqual(error.details, {
          next_steps: [
            "gauge migrate --dry-run --format json",
            "gauge migrate --format json",
          ],
        });
        return true;
      },
    );
  }
});

test("migration preflight is read-only for missing data roots", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-preflight-"));
  const root = path.join(parent, ".gauge");

  assert.doesNotThrow(() => assertStateCommandAllowed("status", root));
  assert.equal(fs.existsSync(root), false);
});
