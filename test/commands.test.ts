import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  normalizeRenewalInput,
  refreshWrites,
  runAddCommand,
} from "../src/commands.js";

test("runAddCommand dry-runs provider-scoped Cursor accounts", async () => {
  const result = await runAddCommand("work", {
    dryRun: true,
    provider: "cursor",
    storageStateJson: JSON.stringify({ cookies: [], origins: [] }),
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.data.provider, "cursor");
  assert.equal(result.data.auth_mode, "headless-storage-state");
  assert.match(
    JSON.stringify(result.data.writes),
    /accounts\/v3\/cursor\/work/,
  );
});

test("runAddCommand dry-runs provider-scoped Codex accounts", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test-token" } }),
    { mode: 0o600 },
  );
  const result = await runAddCommand("work", {
    codexHome,
    dryRun: true,
    provider: "codex",
    renewsAt: "2026-07-12",
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.data.provider, "codex");
  assert.equal(result.data.auth_mode, "codex-home");
  assert.equal(result.data.renews_at, "2026-07-12T00:00:00.000Z");
  assert.match(JSON.stringify(result.data.writes), /accounts\/v3\/codex\/work/);
});

test("Codex dry-run validates referenced credentials without creating Gauge state", async () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");

  await assert.rejects(
    () =>
      runAddCommand("invalid", {
        codexHome,
        dryRun: true,
        provider: "codex",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_CODEX_AUTH",
  );
});

test("refresh dry-run reports Codex renewal config writes", () => {
  const writes = refreshWrites(
    "codex",
    { name: "work", provider: "codex", renews_at: "2026-07-12T00:00:00.000Z" },
    {},
    {
      accountPath: "/tmp/codex-work.json",
      authKey: "codex-work",
      profileDir: "/tmp/profile-codex-work",
      storagePath: "/tmp/codex-work-storage.json",
    },
  );

  assert.deepEqual(writes, ["/tmp/codex-work.json"]);
  assert.deepEqual(
    refreshWrites(
      "codex",
      { name: "work", provider: "codex" },
      {},
      {
        accountPath: "/tmp/codex-work.json",
        authKey: "codex-work",
        profileDir: "/tmp/profile-codex-work",
        storagePath: "/tmp/codex-work-storage.json",
      },
    ),
    [],
  );
  assert.deepEqual(
    refreshWrites(
      "claude",
      { name: "work", provider: "claude", renews_at: null },
      {},
      {
        accountPath: "/tmp/work.json",
        authKey: "work",
        profileDir: "/tmp/profile-work",
        storagePath: "/tmp/work-storage.json",
      },
    ),
    ["/tmp/work-storage.json", "/tmp/work.json"],
  );
});

test("manual renewal accepts null clearing values", () => {
  assert.equal(normalizeRenewalInput("none"), null);
  assert.equal(normalizeRenewalInput("null"), null);
  assert.equal(normalizeRenewalInput(" "), null);
  assert.equal(normalizeRenewalInput(null), null);
  assert.equal(normalizeRenewalInput(undefined), undefined);
  assert.throws(() => normalizeRenewalInput(123), /date string or null/);
});

test("manual renewal rejects invalid timestamps", () => {
  assert.throws(() => normalizeRenewalInput("not-a-date"), {
    message: /Invalid renews_at/,
  });
});

test("runAddCommand rejects unsupported providers at the wire boundary", async () => {
  await assert.rejects(
    () =>
      runAddCommand("work", {
        dryRun: true,
        provider: "unknown",
      }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "INVALID_WIRE_INPUT",
  );
});
