import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { atomicReplace } from "../src/persistence/atomic-replace.js";
import {
  ExternalCredentialWriter,
  validateCodexHome,
} from "../src/persistence/external-credential-writer.js";
import { CLIError } from "../src/security.js";

test("writes refreshed Codex tokens while preserving unrelated auth data", () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const authPath = path.join(homePath, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      account: { id: "account-1" },
      tokens: { account_id: "account-1", existing: "preserved" },
    }),
    { mode: 0o600 },
  );
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [homePath],
  });

  const result = writer.apply(
    {
      accessToken: "new-access-token",
      homePath,
      idToken: "new-id-token",
      lastRefresh: "2026-07-11T12:00:00.000Z",
      refreshToken: "new-refresh-token",
    },
    "refresh-if-stale",
  );

  assert.deepEqual(result, {
    applied: true,
    authPath: fs.realpathSync(authPath),
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(authPath, "utf8")), {
    account: { id: "account-1" },
    tokens: {
      access_token: "new-access-token",
      account_id: "account-1",
      existing: "preserved",
      id_token: "new-id-token",
      last_refresh: "2026-07-11T12:00:00.000Z",
      refresh_token: "new-refresh-token",
    },
  });
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
});

test("never policy returns a typed result without writing credentials", () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const authPath = path.join(homePath, "auth.json");
  fs.writeFileSync(authPath, '{"tokens":{"access_token":"old-token"}}');
  let writes = 0;
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [homePath],
    replaceFile: () => {
      writes += 1;
    },
  });

  const result = writer.apply(
    {
      accessToken: "sensitive-new-token",
      homePath,
      lastRefresh: "2026-07-11T12:00:00.000Z",
    },
    "never",
  );

  assert.deepEqual(result, {
    applied: false,
    error: {
      code: "CREDENTIAL_REFRESH_DISABLED",
      message: "Credential refresh is disabled by policy.",
      retryable: false,
    },
  });
  assert.equal(writes, 0);
  assert.equal(
    fs.readFileSync(authPath, "utf8"),
    '{"tokens":{"access_token":"old-token"}}',
  );
});

test("rejects mismatched and escaping Codex homes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const allowedHome = path.join(root, "allowed");
  const otherHome = path.join(root, "other");
  fs.mkdirSync(allowedHome);
  fs.mkdirSync(otherHome);
  const otherAuth = path.join(otherHome, "auth.json");
  fs.writeFileSync(otherAuth, '{"tokens":{"access_token":"old-token"}}');
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [allowedHome],
  });

  for (const homePath of [
    otherHome,
    path.join(allowedHome, "..", "other"),
    path.join(allowedHome, "..", "missing"),
  ]) {
    assert.throws(
      () =>
        writer.apply(
          {
            accessToken: "sensitive-new-token",
            homePath,
            lastRefresh: "2026-07-11T12:00:00.000Z",
          },
          "refresh-if-stale",
        ),
      (error: unknown) =>
        error instanceof CLIError && error.code === "CODEX_HOME_NOT_ALLOWED",
    );
  }

  assert.equal(
    fs.readFileSync(otherAuth, "utf8"),
    '{"tokens":{"access_token":"old-token"}}',
  );
});

test("rejects a symlinked allowed Codex home", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const realHome = path.join(root, "real-home");
  const linkedHome = path.join(root, "linked-home");
  fs.mkdirSync(realHome);
  fs.symlinkSync(realHome, linkedHome, "dir");

  assert.throws(
    () =>
      new ExternalCredentialWriter({
        allowedCodexHomes: [linkedHome],
      }),
    (error: unknown) =>
      error instanceof CLIError && error.code === "CODEX_HOME_SYMLINK",
  );

  fs.writeFileSync(path.join(realHome, "auth.json"), '{"tokens":{}}');
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [realHome],
  });
  assert.throws(
    () =>
      writer.apply(
        {
          accessToken: "sensitive-new-token",
          homePath: linkedHome,
          lastRefresh: "2026-07-11T12:00:00.000Z",
        },
        "refresh-if-stale",
      ),
    (error: unknown) =>
      error instanceof CLIError && error.code === "CODEX_HOME_SYMLINK",
  );
});

test("rejects a symlinked Codex auth file", () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const outsideAuth = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "gauge-outside-")),
    "auth.json",
  );
  fs.writeFileSync(outsideAuth, '{"tokens":{"access_token":"old-token"}}');
  fs.symlinkSync(outsideAuth, path.join(homePath, "auth.json"), "file");
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [homePath],
  });

  assert.throws(
    () =>
      writer.apply(
        {
          accessToken: "sensitive-new-token",
          homePath,
          lastRefresh: "2026-07-11T12:00:00.000Z",
        },
        "refresh-if-stale",
      ),
    (error: unknown) =>
      error instanceof CLIError && error.code === "CODEX_AUTH_SYMLINK",
  );
  assert.equal(
    fs.readFileSync(outsideAuth, "utf8"),
    '{"tokens":{"access_token":"old-token"}}',
  );
});

test("rejects a non-regular Codex auth file", () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  fs.mkdirSync(path.join(homePath, "auth.json"));
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [homePath],
  });

  assert.throws(
    () =>
      writer.apply(
        {
          accessToken: "sensitive-new-token",
          homePath,
          lastRefresh: "2026-07-11T12:00:00.000Z",
        },
        "refresh-if-stale",
      ),
    (error: unknown) =>
      error instanceof CLIError && error.code === "CODEX_AUTH_NOT_REGULAR",
  );
});

test("preserves old auth when atomic replacement fails without exposing tokens", () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const authPath = path.join(homePath, "auth.json");
  const oldAuth = '{"tokens":{"access_token":"old-token"}}';
  fs.writeFileSync(authPath, oldAuth, { mode: 0o600 });
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [homePath],
    replaceFile: (destinationPath, content, options) =>
      atomicReplace(destinationPath, content, {
        ...options,
        rename: () => {
          throw new Error("injected replacement failure");
        },
      }),
  });

  assert.throws(
    () =>
      writer.apply(
        {
          accessToken: "sensitive-new-token",
          homePath,
          lastRefresh: "2026-07-11T12:00:00.000Z",
        },
        "refresh-if-stale",
      ),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /sensitive-new-token/);
      return (
        error instanceof Error &&
        /injected replacement failure/.test(error.message)
      );
    },
  );
  assert.equal(fs.readFileSync(authPath, "utf8"), oldAuth);
  assert.deepEqual(fs.readdirSync(homePath), ["auth.json"]);
});

test("clamps permissive Codex auth mode to 0600", () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const authPath = path.join(homePath, "auth.json");
  fs.writeFileSync(authPath, '{"tokens":{}}', { mode: 0o644 });
  fs.chmodSync(authPath, 0o644);
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [homePath],
  });

  writer.apply(
    {
      accessToken: "new-access-token",
      homePath,
      lastRefresh: "2026-07-11T12:00:00.000Z",
    },
    "refresh-if-stale",
  );

  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
});

test("does not expose stored or pending tokens in validation errors", () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const authPath = path.join(homePath, "auth.json");
  fs.writeFileSync(
    authPath,
    '{"tokens":{"access_token":"stored-sensitive-token"}, trailing',
    { mode: 0o600 },
  );
  const writer = new ExternalCredentialWriter({
    allowedCodexHomes: [homePath],
  });

  assert.throws(
    () =>
      writer.apply(
        {
          accessToken: "pending-sensitive-token",
          homePath,
          lastRefresh: "2026-07-11T12:00:00.000Z",
        },
        "refresh-if-stale",
      ),
    (error: unknown) => {
      assert.doesNotMatch(String(error), /stored-sensitive-token/);
      assert.doesNotMatch(String(error), /pending-sensitive-token/);
      return error instanceof CLIError && error.code === "INVALID_CODEX_AUTH";
    },
  );
});

test("validates supported Codex credential shapes without exposing their values", () => {
  for (const auth of [
    { OPENAI_API_KEY: "api-key-value" },
    { tokens: { access_token: "snake-token-value" } },
    { tokens: { accessToken: "camel-token-value" } },
  ]) {
    const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
    const authPath = path.join(homePath, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });

    assert.deepEqual(validateCodexHome(homePath), {
      authPath: path.join(fs.realpathSync(homePath), "auth.json"),
      homePath: fs.realpathSync(homePath),
    });
  }
});

test("Codex credential validation rejects missing and malformed artifacts", () => {
  const missingHome = path.join(os.tmpdir(), "gauge-missing-codex-home");
  fs.rmSync(missingHome, { force: true, recursive: true });
  assert.throws(
    () => validateCodexHome(missingHome),
    (error: unknown) =>
      error instanceof CLIError && error.code === "INVALID_CODEX_HOME",
  );

  const fileHome = temporaryAuthPath("not a directory");
  assert.throws(
    () => validateCodexHome(fileHome),
    (error: unknown) =>
      error instanceof CLIError && error.code === "INVALID_CODEX_HOME",
  );

  const missingAuthHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "gauge-codex-"),
  );
  assert.throws(
    () => validateCodexHome(missingAuthHome),
    (error: unknown) =>
      error instanceof CLIError && error.code === "INVALID_CODEX_AUTH",
  );

  const emptyAuthHome = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  fs.writeFileSync(path.join(emptyAuthHome, "auth.json"), '{"tokens":{}}');
  assert.throws(
    () => validateCodexHome(emptyAuthHome),
    (error: unknown) =>
      error instanceof CLIError && error.code === "INVALID_CODEX_AUTH",
  );

  const directoryAuthHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "gauge-codex-"),
  );
  fs.mkdirSync(path.join(directoryAuthHome, "auth.json"));
  assert.throws(
    () => validateCodexHome(directoryAuthHome),
    (error: unknown) =>
      error instanceof CLIError && error.code === "CODEX_AUTH_NOT_REGULAR",
  );

  const arrayAuthHome = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  fs.writeFileSync(path.join(arrayAuthHome, "auth.json"), "[]");
  assert.throws(
    () => validateCodexHome(arrayAuthHome),
    (error: unknown) =>
      error instanceof CLIError && error.code === "INVALID_CODEX_AUTH",
  );
});

function temporaryAuthPath(content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const filePath = path.join(directory, "home-file");
  fs.writeFileSync(filePath, content);
  return filePath;
}
