import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AccountConfigV3Schema,
  type AccountId,
  encodeAccountId,
  parseAccountName,
  parseProvider,
} from "../src/domain/account.js";

test("provider-scoped account keys do not reproduce the legacy prefix collision", () => {
  const claude: AccountId = { provider: "claude", name: "codex-work" };
  const codex: AccountId = { provider: "codex", name: "work" };

  assert.notEqual(encodeAccountId(claude), encodeAccountId(codex));
});

test("account keys remain unique across the provider and prefixed-name matrix", () => {
  const providers = ["claude", "codex", "cursor"] as const;
  const names = ["work", "codex-work", "cursor-work"];
  const keys = providers.flatMap((provider) =>
    names.map((name) => encodeAccountId({ provider, name })),
  );

  assert.equal(new Set(keys).size, keys.length);
});

test("provider and account-name segments reject invalid identifiers", () => {
  assert.throws(() => parseProvider("openai"));

  for (const name of ["", "../work", "team/work", "team work", "work.json"]) {
    assert.throws(() => parseAccountName(name));
  }
});

test("v3 account configs accept the documented shape and reject unknown fields", () => {
  const config = {
    schema_version: 3,
    provider: "codex",
    name: "work",
    addedAt: "2026-07-11T12:00:00.000Z",
    codexHome: "/Users/example/.codex-work",
    renewsAt: "2026-07-12T00:00:00.000Z",
  };

  assert.deepEqual(AccountConfigV3Schema.parse(config), config);
  assert.equal(
    AccountConfigV3Schema.safeParse({ ...config, unexpected: true }).success,
    false,
  );
});
