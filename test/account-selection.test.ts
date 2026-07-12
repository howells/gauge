import assert from "node:assert/strict";
import { test } from "node:test";
import { CLIError } from "../src/security.js";
import { selectConfiguredAccounts } from "../src/services/account-selection.js";

const accounts = [
  { id: { provider: "claude", name: "work" }, order: 0 },
  { id: { provider: "codex", name: "work" }, order: 1 },
  { id: { provider: "cursor", name: "personal" }, order: 2 },
] as const;

test("provider filtering selects configured accounts before acquisition", () => {
  assert.deepEqual(selectConfiguredAccounts(accounts, { provider: "codex" }), [
    accounts[1],
  ]);
  assert.deepEqual(
    selectConfiguredAccounts(accounts, {
      provider: "cursor",
      account: "personal",
    }),
    [accounts[2]],
  );
});

test("account-only filtering succeeds for exactly one configured match", () => {
  assert.deepEqual(
    selectConfiguredAccounts(accounts, { account: "personal" }),
    [accounts[2]],
  );
});

test("account-only filtering reports provider-qualified ambiguity", () => {
  assert.throws(
    () => selectConfiguredAccounts(accounts, { account: "work" }),
    (error: unknown) => {
      assert.ok(error instanceof CLIError);
      assert.equal(error.code, "AMBIGUOUS_ACCOUNT");
      assert.deepEqual(error.details, {
        candidates: ["claude:work", "codex:work"],
      });
      return true;
    },
  );
});

test("missing configured account filters fail without selecting ambient sources", () => {
  assert.throws(
    () => selectConfiguredAccounts(accounts, { account: "ambient-codex" }),
    (error: unknown) =>
      error instanceof CLIError && error.code === "ACCOUNT_NOT_FOUND",
  );
});
