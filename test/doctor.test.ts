import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AccountRepository } from "../src/persistence/account-repository.js";
import { runDoctorChecks } from "../src/services/doctor.js";

test("doctor is read-only and reports a missing data root as ready", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-doctor-"));
  const root = path.join(parent, ".gauge");
  const report = runDoctorChecks({
    chromePath: null,
    dataRoot: root,
    env: {},
    nodeVersion: "20.18.0",
  });

  assert.equal(fs.existsSync(root), false);
  assert.equal(report.failed, 0);
  assert.ok(
    report.checks.some(
      (check) => check.id === "runtime/node" && check.status === "pass",
    ),
  );
  assert.ok(
    report.checks.some(
      (check) => check.id === "runtime/chrome" && check.status === "warning",
    ),
  );
});

test("doctor reports legacy migration and unsafe data-root failures without credentials", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-doctor-"));
  const realRoot = path.join(parent, "real");
  const linkedRoot = path.join(parent, ".gauge");
  fs.mkdirSync(realRoot, { mode: 0o777 });
  fs.writeFileSync(
    path.join(realRoot, "work.json"),
    JSON.stringify({ name: "work", addedAt: "2026-01-01T00:00:00.000Z" }),
  );
  fs.symlinkSync(realRoot, linkedRoot, "dir");

  const report = runDoctorChecks({
    chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    dataRoot: linkedRoot,
    env: { GAUGE_CURSOR_COOKIE: "super-secret-cookie" },
    nodeVersion: "20.18.0",
  });
  const serialized = JSON.stringify(report);

  assert.ok(report.failed > 0);
  assert.ok(report.checks.some((check) => check.id === "state/migration"));
  assert.doesNotMatch(serialized, /super-secret-cookie/);
});

test("doctor fails unsupported Node versions", () => {
  const report = runDoctorChecks({
    chromePath: null,
    dataRoot: path.join(os.tmpdir(), "does-not-exist-gauge"),
    env: {},
    nodeVersion: "18.20.0",
  });

  assert.ok(report.failed > 0);
  assert.ok(
    report.checks.some(
      (check) => check.id === "runtime/node" && check.status === "fail",
    ),
  );
});

test("doctor checks v3 identity, credential artifacts, profiles, and tombstones", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-doctor-"));
  fs.chmodSync(root, 0o700);
  const accounts = new AccountRepository({ dataRoot: root });
  accounts.add(
    { provider: "cursor", name: "work" },
    { storageState: { cookies: [], origins: [] } },
  );
  const directory = path.join(root, "accounts", "v3", "cursor", "work");
  fs.chmodSync(path.join(directory, "storage-state.json"), 0o644);
  fs.symlinkSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "gauge-profile-")),
    path.join(directory, "profile"),
    "dir",
  );
  fs.mkdirSync(
    path.join(root, "accounts", "v3", "cursor", ".old.tombstone-operation"),
  );

  const report = runDoctorChecks({
    chromePath: "/chrome",
    dataRoot: root,
    env: {},
    nodeVersion: "24.0.0",
  });

  assert.ok(
    report.checks.some(
      (check) =>
        check.id === "account/storage-state" && check.status === "fail",
    ),
  );
  assert.ok(
    report.checks.some(
      (check) => check.id === "account/profile" && check.status === "fail",
    ),
  );
  assert.ok(
    report.checks.some(
      (check) =>
        check.id === "accounts/tombstone" && check.status === "warning",
    ),
  );
});

test("doctor detects ambient and configured Codex readiness without credentials", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-doctor-"));
  const root = path.join(parent, ".gauge");
  const codexHome = path.join(parent, ".codex");
  fs.mkdirSync(root, { mode: 0o700 });
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "super-secret-token" } }),
    { mode: 0o600 },
  );
  new AccountRepository({ dataRoot: root }).add(
    { provider: "codex", name: "work" },
    { codexHome },
  );

  const report = runDoctorChecks({
    chromePath: null,
    dataRoot: root,
    env: {},
    home: parent,
    nodeVersion: "22.0.0",
  });
  const serialized = JSON.stringify(report);

  assert.ok(
    report.checks.some(
      (check) =>
        check.id === "readiness/codex-ambient" && check.status === "pass",
    ),
  );
  assert.ok(
    report.checks.some(
      (check) =>
        check.id === "readiness/codex-configured" && check.status === "pass",
    ),
  );
  assert.doesNotMatch(serialized, /super-secret-token/);
});

test("doctor rejects malformed storage state and unusable Codex auth", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-doctor-"));
  const root = path.join(parent, ".gauge");
  const accounts = new AccountRepository({ dataRoot: root });
  accounts.add(
    { provider: "cursor", name: "work" },
    { storageState: { cookies: [], origins: [] } },
  );
  fs.writeFileSync(
    path.join(root, "accounts", "v3", "cursor", "work", "storage-state.json"),
    "not-json",
    { mode: 0o600 },
  );
  const codexHome = path.join(parent, ".codex");
  fs.mkdirSync(codexHome, { mode: 0o700 });
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"tokens":{}}', {
    mode: 0o600,
  });

  const report = runDoctorChecks({
    chromePath: null,
    dataRoot: root,
    env: { CODEX_HOME: codexHome },
    home: parent,
    nodeVersion: "22.0.0",
  });

  assert.ok(
    report.checks.some(
      (check) =>
        check.id === "account/storage-state" && check.status === "fail",
    ),
  );
  assert.ok(
    report.checks.some(
      (check) =>
        check.id === "readiness/codex-ambient" && check.status === "warning",
    ),
  );
});
