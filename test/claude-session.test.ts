import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claudeSwitchesWithin } from "../src/services/claude-session.js";

function fakeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gauge-claude-session-"));
}

function writeSwitchLog(
  dataDir: string,
  entries: Array<Record<string, unknown>>,
): void {
  const file = path.join(dataDir, "backups", "claude-switch-log.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries));
}

const NOW = new Date("2026-09-02T14:00:00Z");
const HOUR = 60 * 60 * 1000;

test("claudeSwitchesWithin reads every recent displaced account", () => {
  const dataDir = fakeDataDir();
  writeSwitchLog(dataDir, [
    {
      previousUuid: "gmail-uuid",
      previousEmail: "person@gmail.com",
      switchedAt: "2026-09-02T12:00:00.000Z",
    },
    {
      previousUuid: "work-uuid",
      previousEmail: "person@work.com",
      switchedAt: "2026-09-02T13:30:00.000Z",
    },
  ]);

  const switches = claudeSwitchesWithin(dataDir, NOW, 24 * HOUR);
  assert.equal(switches.length, 2);
  // Oldest first, so the dashboard's "most recent switch" is the last entry.
  assert.equal(switches[0]?.previousUuid, "gmail-uuid");
  assert.equal(switches[1]?.previousUuid, "work-uuid");
  assert.equal(
    switches[1]?.switchedAt.getTime(),
    Date.parse("2026-09-02T13:30:00.000Z"),
  );
});

test("claudeSwitchesWithin drops switches older than the window", () => {
  const dataDir = fakeDataDir();
  writeSwitchLog(dataDir, [
    {
      previousUuid: "old-uuid",
      previousEmail: "old@example.com",
      switchedAt: "2026-08-30T12:00:00.000Z",
    },
    {
      previousUuid: "new-uuid",
      previousEmail: "new@example.com",
      switchedAt: "2026-09-02T13:00:00.000Z",
    },
  ]);

  const switches = claudeSwitchesWithin(dataDir, NOW, 24 * HOUR);
  assert.equal(switches.length, 1);
  assert.equal(switches[0]?.previousUuid, "new-uuid");
});

test("claudeSwitchesWithin deduplicates a repeated account", () => {
  const dataDir = fakeDataDir();
  writeSwitchLog(dataDir, [
    {
      previousUuid: "gmail-uuid",
      previousEmail: "person@gmail.com",
      switchedAt: "2026-09-02T10:00:00.000Z",
    },
    {
      previousUuid: "gmail-uuid",
      previousEmail: "person@gmail.com",
      switchedAt: "2026-09-02T13:00:00.000Z",
    },
  ]);

  const switches = claudeSwitchesWithin(dataDir, NOW, 24 * HOUR);
  assert.equal(switches.length, 1);
  assert.equal(
    switches[0]?.switchedAt.getTime(),
    Date.parse("2026-09-02T13:00:00.000Z"),
  );
});

test("claudeSwitchesWithin survives a missing or malformed log", () => {
  assert.deepEqual(claudeSwitchesWithin(fakeDataDir(), NOW, 24 * HOUR), []);

  const dataDir = fakeDataDir();
  writeSwitchLog(dataDir, [{ switchedAt: "not-a-date" }, "junk", null]);
  assert.deepEqual(claudeSwitchesWithin(dataDir, NOW, 24 * HOUR), []);
});
