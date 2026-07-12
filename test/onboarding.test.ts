import assert from "node:assert/strict";
import { test } from "node:test";
import { runAddCommand } from "../src/commands.js";
import { CLIError } from "../src/security.js";
import { addGuide, missingAccountName } from "../src/services/onboarding.js";

test("addGuide lists every provider with a runnable command", () => {
  const guide = addGuide();
  assert.match(guide, /Claude\s+gauge add <name>/);
  assert.match(guide, /Codex\s+gauge add codex <name> --codex-home <path>/);
  assert.match(guide, /Cursor\s+gauge add cursor <name>/);
});

test("missing add name without a provider guides through all providers", () => {
  const error = missingAccountName("add");
  assert.equal(error.code, "ACCOUNT_NAME_REQUIRED");
  assert.equal(error.exitCode, 2);
  assert.match(error.message, /gauge add <name>/);
  assert.match(error.message, /gauge add codex <name>/);
  assert.match(error.message, /gauge add cursor <name>/);
});

test("missing add name for a known provider guides only that provider", () => {
  const codex = missingAccountName("add", "codex");
  assert.match(codex.message, /Codex account/);
  assert.match(codex.message, /--codex-home <path>/);
  // The example path must survive redaction as author-trusted guidance.
  assert.equal(codex.trustedMessage, true);
  assert.match(codex.message, /~\/\.codex/);

  const cursor = missingAccountName("add", "cursor");
  assert.match(cursor.message, /browser/);
  assert.doesNotMatch(cursor.message, /codex-home/);
});

test("missing refresh/remove name points at the account list", () => {
  for (const command of ["refresh", "remove"] as const) {
    const error = missingAccountName(command);
    assert.match(error.message, new RegExp(`gauge ${command} <name>`));
    assert.match(error.message, /gauge list/);
  }
});

test("runAddCommand without a name guides instead of validating a schema", async () => {
  await assert.rejects(
    () => runAddCommand(undefined, {}),
    (error: unknown) =>
      error instanceof CLIError && error.code === "ACCOUNT_NAME_REQUIRED",
  );
});

test("runAddCommand with a raw payload still defers to wire validation", async () => {
  // Agents pass --json; the friendly guard must not intercept that path.
  await assert.rejects(
    () => runAddCommand(undefined, { json: "{}" }),
    (error: unknown) =>
      error instanceof CLIError && error.code !== "ACCOUNT_NAME_REQUIRED",
  );
});
