import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { readMachineLogins } from "../src/services/machine-logins.js";

function jwt(claims: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  return `header.${body}.signature`;
}

function fakeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gauge-machine-"));
}

/** Keep a real CODEX_HOME on the developer's machine out of these readings. */
function withoutCodexHome<T>(run: () => T): T {
  const previous = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME;
  try {
    return run();
  } finally {
    if (previous !== undefined) process.env.CODEX_HOME = previous;
  }
}

test("readMachineLogins reports nothing when no tool is signed in", () => {
  const home = fakeHome();
  assert.deepEqual(
    withoutCodexHome(() => readMachineLogins(home)),
    [],
  );
});

test("readMachineLogins reads the Claude Code account from its state file", () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, ".claude.json"),
    JSON.stringify({
      oauthAccount: {
        accountUuid: "account-uuid",
        emailAddress: "person@example.com",
      },
    }),
  );

  const logins = withoutCodexHome(() => readMachineLogins(home));
  const claude = logins.find((login) => login.surface === "Claude Code");
  assert.equal(claude?.email, "person@example.com");
  assert.equal(claude?.accountId, "account-uuid");
});

test("readMachineLogins takes the Codex address out of its id token", () => {
  const home = fakeHome();
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      tokens: {
        account_id: "codex-account",
        id_token: jwt({ email: "person@gmail.com" }),
      },
    }),
  );

  const logins = withoutCodexHome(() => readMachineLogins(home));
  const codex = logins.find((login) => login.surface === "Codex");
  assert.equal(codex?.email, "person@gmail.com");
  assert.equal(codex?.accountId, "codex-account");
});

test("readMachineLogins falls back to the OpenAI profile claim for an address", () => {
  const home = fakeHome();
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({
      tokens: {
        id_token: jwt({
          "https://api.openai.com/profile": { email: "profile@example.com" },
        }),
      },
    }),
  );

  const codex = withoutCodexHome(() => readMachineLogins(home)).find(
    (login) => login.surface === "Codex",
  );
  assert.equal(codex?.email, "profile@example.com");
});

test("readMachineLogins survives unreadable and malformed state", () => {
  const home = fakeHome();
  fs.writeFileSync(path.join(home, ".claude.json"), "{ not json");
  const codexHome = path.join(home, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { id_token: "not-a-jwt" } }),
  );

  const logins = withoutCodexHome(() => readMachineLogins(home));
  // A broken Claude file yields no reading at all; a Codex token that cannot be
  // decoded still yields the surface, with no address rather than a crash.
  assert.equal(
    logins.some((login) => login.surface === "Claude Code"),
    false,
  );
  assert.equal(logins.find((login) => login.surface === "Codex")?.email, null);
});
