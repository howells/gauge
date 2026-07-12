import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCli = path.join(root, "src", "cli.ts");

interface Fixture {
  cwd: string;
  dataRoot: string;
  home: string;
  root: string;
}

function fixture(): Fixture {
  const fixtureRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "gauge-migration-cli-"),
  );
  const cwd = path.join(fixtureRoot, "cwd");
  const home = path.join(fixtureRoot, "home");
  const dataRoot = path.join(home, ".gauge");
  fs.mkdirSync(cwd);
  fs.mkdirSync(dataRoot, { mode: 0o700, recursive: true });
  fs.writeFileSync(
    path.join(dataRoot, "personal.json"),
    JSON.stringify({
      addedAt: "2026-01-01T00:00:00.000Z",
      name: "personal",
      provider: "claude",
    }),
    { mode: 0o600 },
  );
  return { cwd, dataRoot, home, root: fixtureRoot };
}

function run(fixtureValue: Fixture, args: string[]) {
  const env = { ...process.env };
  for (const name of [
    "CODEX_HOME",
    "GAUGE_CURSOR_COOKIE",
    "GAUGE_CURSOR_COOKIE_FILE",
    "GAUGE_CURSOR_STORAGE_STATE_FILE",
    "GAUGE_CURSOR_STORAGE_STATE_JSON",
    "GAUGE_STORAGE_STATE_FILE",
    "GAUGE_STORAGE_STATE_JSON",
  ]) {
    delete env[name];
  }
  const result = spawnSync(process.execPath, [tsxCli, sourceCli, ...args], {
    cwd: fixtureValue.cwd,
    encoding: "utf8",
    env: { ...env, HOME: fixtureValue.home },
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function json(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

test("account commands return exact MIGRATION_REQUIRED recovery steps", (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { force: true, recursive: true }));

  for (const { args, command } of [
    { args: ["status", "--format", "json"], command: "status" },
    { args: ["list", "--format", "json"], command: "list" },
    { args: ["--format", "json"], command: "status" },
  ]) {
    const result = run(state, args);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, "");
    const envelope = json(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, command);
    assert.deepEqual(envelope.error, {
      code: "MIGRATION_REQUIRED",
      message:
        "Gauge account state must be migrated before this command can run.",
      details: {
        next_steps: [
          "gauge migrate --dry-run --format json",
          "gauge migrate --format json",
        ],
      },
    });
  }
});

test("describe and doctor remain available while legacy state exists", (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { force: true, recursive: true }));

  const describe = run(state, ["describe", "--format", "json"]);
  assert.equal(describe.status, 0);
  assert.equal(json(describe.stdout).command, "describe");

  const doctor = run(state, ["doctor", "--format", "json"]);
  assert.equal(doctor.status, 0);
  const report = json(doctor.stdout).data as {
    failed: number;
    warnings: number;
  };
  assert.equal(report.failed, 0);
  assert.ok(report.warnings > 0);
  assert.equal(fs.existsSync(path.join(state.dataRoot, "personal.json")), true);
});

test("migrate dry-run plans without writes and real migrate commits", (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { force: true, recursive: true }));
  const legacyPath = path.join(state.dataRoot, "personal.json");

  const dryRun = run(state, ["migrate", "--dry-run", "--format", "json"]);
  assert.equal(dryRun.status, 0);
  const dryEnvelope = json(dryRun.stdout);
  assert.equal((dryEnvelope.meta as { dry_run: boolean }).dry_run, true);
  assert.deepEqual(
    (dryEnvelope.data as { accounts: Array<{ id: unknown }> }).accounts.map(
      (account) => account.id,
    ),
    [{ name: "personal", provider: "claude" }],
  );
  assert.equal(fs.existsSync(legacyPath), true);

  const migrated = run(state, ["migrate", "--format", "json"]);
  assert.equal(migrated.status, 0);
  assert.deepEqual(json(migrated.stdout).data, {
    action: "migrate",
    migrated: 1,
  });
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(
    fs.existsSync(
      path.join(
        state.dataRoot,
        "accounts",
        "v3",
        "claude",
        "personal",
        "config.json",
      ),
    ),
    true,
  );
});

test("doctor exits one for failed checks and does not mutate state", (t) => {
  const state = fixture();
  t.after(() => fs.rmSync(state.root, { force: true, recursive: true }));
  fs.chmodSync(state.dataRoot, 0o755);
  const before = fs.readFileSync(
    path.join(state.dataRoot, "personal.json"),
    "utf8",
  );

  const result = run(state, ["doctor", "--format", "json"]);
  assert.equal(result.status, 1);
  const envelope = json(result.stdout);
  assert.ok((envelope.data as { failed: number }).failed > 0);
  assert.equal(
    fs.readFileSync(path.join(state.dataRoot, "personal.json"), "utf8"),
    before,
  );
});
