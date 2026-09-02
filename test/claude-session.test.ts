import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { lastClaudeSwitch } from "../src/services/claude-session.js";

function fakeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gauge-claude-session-"));
}

function writeBackup(dataDir: string, profile: unknown): string {
  const file = path.join(dataDir, "backups", "claude-session.previous.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ credentials: "{}", keychainAccount: "daniel", profile }),
  );
  return file;
}

test("lastClaudeSwitch reads the switched-away account from the backup", () => {
  const dataDir = fakeDataDir();
  const file = writeBackup(dataDir, {
    accountUuid: "previous-uuid",
    emailAddress: "person@example.com",
  });

  const switched = lastClaudeSwitch(dataDir);
  assert.ok(switched);
  assert.equal(switched.previousUuid, "previous-uuid");
  assert.equal(switched.previousEmail, "person@example.com");
  assert.equal(
    switched.switchedAt.getTime(),
    fs.statSync(file).mtime.getTime(),
  );
});

test("lastClaudeSwitch returns null with no backup", () => {
  assert.equal(lastClaudeSwitch(fakeDataDir()), null);
});

test("lastClaudeSwitch survives a malformed backup", () => {
  const dataDir = fakeDataDir();
  const file = path.join(dataDir, "backups", "claude-session.previous.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  assert.equal(lastClaudeSwitch(dataDir), null);
});

test("lastClaudeSwitch tolerates a backup with no profile half", () => {
  const dataDir = fakeDataDir();
  const file = path.join(dataDir, "backups", "claude-session.previous.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ credentials: "{}" }));
  assert.equal(lastClaudeSwitch(dataDir), null);
});
