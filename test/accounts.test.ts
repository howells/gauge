import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  accountExists,
  createAccount,
  getAccountArtifacts,
  importStorageState,
  listAccountDetails,
  listAccounts,
  refreshAccount,
  removeAccount,
  saveAccount,
} from "../src/accounts.js";

test("account facade delegates every mutation to provider-scoped v3 storage", () => {
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-home-"));
  process.env.HOME = home;
  try {
    assert.equal(accountExists("work", "claude"), false);

    saveAccount("work", { provider: "claude", renewsAt: null });
    assert.equal(accountExists("work", "claude"), true);
    saveAccount("work", {
      provider: "claude",
      renewsAt: "2026-08-01T00:00:00.000Z",
    });

    createAccount("work", {
      codexHome: "/tmp/codex-work",
      provider: "codex",
    });
    refreshAccount("work", {
      provider: "codex",
      renewsAt: "2026-09-01T00:00:00.000Z",
    });

    const jsonState = JSON.stringify({ cookies: [], origins: [] });
    const claudeStorage = importStorageState(
      "work",
      { json: jsonState },
      "claude",
    );
    assert.equal(fs.existsSync(claudeStorage), true);

    const cursorFile = path.join(home, "cursor-state.json");
    fs.writeFileSync(cursorFile, jsonState);
    createAccount("cursor-work", { provider: "cursor" });
    const cursorStorage = importStorageState(
      "cursor-work",
      { filePath: cursorFile },
      "cursor",
    );
    assert.equal(fs.existsSync(cursorStorage), true);

    assert.deepEqual(
      listAccounts().map(({ provider, name }) => `${provider}:${name}`),
      ["claude:work", "codex:work", "cursor:cursor-work"],
    );
    assert.deepEqual(
      listAccountDetails("codex").map(
        ({ provider, name }) => `${provider}:${name}`,
      ),
      ["codex:work"],
    );
    const artifacts = getAccountArtifacts("work", "claude");
    assert.match(
      artifacts.accountPath,
      /accounts\/v3\/claude\/work\/config\.json$/,
    );
    assert.equal(listAccountDetails("claude")[0]?.hasStorageState, true);

    assert.equal(removeAccount("work", "claude"), true);
    assert.equal(removeAccount("work", "claude"), false);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});
