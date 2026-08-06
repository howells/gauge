import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * The version this repo declares, so the version assertions below check that the
 * CLI reports what we ship rather than that the number never changes. Frozen
 * literals here failed on the first bump after they were written — the one
 * moment a packaging assertion most needs to be trusted.
 */
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version as string;
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const sourceCli = path.join(root, "src", "cli.ts");
const builtCli = path.join(root, "dist", "cli.js");

interface Fixture {
  cwd: string;
  home: string;
  root: string;
}

interface RunResult {
  status: number | null;
  stderr: string;
  stdout: string;
}

function createFixture(): Fixture {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-cli-"));
  const cwd = path.join(fixtureRoot, "cwd");
  const home = path.join(fixtureRoot, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(home);
  return { cwd, home, root: fixtureRoot };
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
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
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
}

function runSource(fixture: Fixture, args: string[]): RunResult {
  const result = spawnSync(process.execPath, [tsxCli, sourceCli, ...args], {
    cwd: fixture.cwd,
    encoding: "utf8",
    env: isolatedEnv(fixture.home),
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function parseJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function accountDir(fixture: Fixture): string {
  const directory = path.join(fixture.home, ".gauge");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function writeAccount(
  fixture: Fixture,
  account: Record<string, unknown>,
): void {
  const provider = String(account.provider ?? "claude");
  const name = String(account.name);
  const directory = path.join(
    accountDir(fixture),
    "accounts",
    "v3",
    provider,
    name,
  );
  fs.mkdirSync(directory, { mode: 0o700, recursive: true });
  fs.writeFileSync(
    path.join(directory, "config.json"),
    JSON.stringify({
      schema_version: 3,
      addedAt: "2026-01-01T00:00:00.000Z",
      ...account,
    }),
    { mode: 0o600 },
  );
}

test("source CLI exposes stable help and package version", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const help = runSource(fixture, ["--help"]);
  assert.equal(help.status, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /^Usage: gauge \[options\] \[command\]/);
  for (const command of [
    "status",
    "list",
    "describe",
    "add",
    "refresh",
    "remove",
  ]) {
    assert.match(help.stdout, new RegExp(`\\b${command}\\b`));
  }

  const version = runSource(fixture, ["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stderr, "");
  assert.equal(version.stdout, `${packageVersion}\n`);
});

test("root and status aliases return the same empty structured status", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const rootStatus = runSource(fixture, ["--format", "json"]);
  const namedStatus = runSource(fixture, ["status", "--format", "json"]);
  assert.equal(rootStatus.status, 0);
  assert.equal(namedStatus.status, 0);
  assert.equal(rootStatus.stderr, "");
  assert.equal(namedStatus.stderr, "");

  const rootEnvelope = parseJson(rootStatus.stdout);
  const namedEnvelope = parseJson(namedStatus.stdout);
  assert.equal(rootEnvelope.ok, true);
  assert.equal(rootEnvelope.command, "status");
  assert.deepEqual(rootEnvelope.data, {
    accounts: [],
    recommendation: null,
    summary: { total: 0, succeeded: 0, failed: 0, timed_out: 0 },
  });
  assert.equal((rootEnvelope.meta as { result: string }).result, "complete");
  assert.deepEqual(namedEnvelope.data, rootEnvelope.data);
});

test("describe supports the non-TTY JSON default and field masks", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = runSource(fixture, [
    "describe",
    "add",
    "--fields",
    "commands.command,commands.kind,commands.safety.dry_run",
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const envelope = parseJson(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "describe");
  assert.deepEqual(envelope.data, {
    commands: [
      {
        command: "add",
        kind: "mutating",
        safety: { dry_run: true },
      },
    ],
  });
});

test("list emits JSON and paginated NDJSON envelopes", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  writeAccount(fixture, { name: "alpha", provider: "claude" });
  writeAccount(fixture, {
    codexHome: "/tmp/codex-beta",
    name: "beta",
    provider: "codex",
  });

  const jsonResult = runSource(fixture, ["list", "--format", "json"]);
  assert.equal(jsonResult.status, 0);
  const jsonEnvelope = parseJson(jsonResult.stdout);
  assert.equal(jsonEnvelope.ok, true);
  assert.equal(jsonEnvelope.command, "list");
  assert.equal(
    (jsonEnvelope.data as { accounts: unknown[] }).accounts.length,
    2,
  );

  const ndjsonResult = runSource(fixture, [
    "list",
    "--format",
    "ndjson",
    "--page-size",
    "1",
    "--page-all",
  ]);
  assert.equal(ndjsonResult.status, 0);
  assert.equal(ndjsonResult.stderr, "");
  const pages = ndjsonResult.stdout.trim().split("\n").map(parseJson);
  assert.equal(pages.length, 2);
  assert.deepEqual(
    pages.map(
      (page) => (page.meta as { page_info: { index: number } }).page_info.index,
    ),
    [1, 2],
  );
  assert.deepEqual(
    pages.map(
      (page) =>
        (page.data as { accounts: Array<{ name: string }> }).accounts[0]?.name,
    ),
    ["alpha", "beta"],
  );
});

test("add dry-run reports writes without creating account artifacts", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const codexHome = path.join(fixture.root, "codex-home");
  fs.mkdirSync(codexHome);
  fs.writeFileSync(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: "test-token" } }),
    { mode: 0o600 },
  );

  const result = runSource(fixture, [
    "add",
    "codex",
    "work",
    "--codex-home",
    codexHome,
    "--dry-run",
    "--format",
    "json",
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const envelope = parseJson(result.stdout);
  const data = envelope.data as {
    action: string;
    auth_mode: string;
    name: string;
    provider: string;
    writes: string[];
  };
  assert.deepEqual(
    {
      action: data.action,
      auth_mode: data.auth_mode,
      name: data.name,
      provider: data.provider,
    },
    {
      action: "add",
      auth_mode: "codex-home",
      name: "work",
      provider: "codex",
    },
  );
  assert.equal(
    data.writes[0],
    path.join(
      fixture.home,
      ".gauge",
      "accounts",
      "v3",
      "codex",
      "work",
      "config.json",
    ),
  );
  assert.equal(fs.existsSync(path.join(fixture.home, ".gauge")), false);
  assert.equal((envelope.meta as { dry_run: boolean }).dry_run, true);
});

test("refresh and remove dry-runs characterize existing Codex account changes", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  writeAccount(fixture, {
    codexHome: "/tmp/codex-work",
    name: "work",
    provider: "codex",
  });
  const accountPath = path.join(
    accountDir(fixture),
    "accounts",
    "v3",
    "codex",
    "work",
  );
  const configPath = path.join(accountPath, "config.json");
  const before = fs.readFileSync(configPath, "utf8");

  const refresh = runSource(fixture, [
    "refresh",
    "codex",
    "work",
    "--renews-at",
    "2026-07-12",
    "--dry-run",
    "--format",
    "json",
  ]);
  assert.equal(refresh.status, 0);
  const refreshEnvelope = parseJson(refresh.stdout);
  assert.deepEqual(refreshEnvelope.data, {
    action: "refresh",
    name: "work",
    provider: "codex",
    auth_mode: "codex-home",
    renews_at: "2026-07-12T00:00:00.000Z",
    writes: [configPath],
  });
  assert.equal((refreshEnvelope.meta as { dry_run: boolean }).dry_run, true);

  const remove = runSource(fixture, [
    "remove",
    "codex",
    "work",
    "--dry-run",
    "--format",
    "json",
  ]);
  assert.equal(remove.status, 0);
  const removeEnvelope = parseJson(remove.stdout);
  const removeData = removeEnvelope.data as {
    action: string;
    deletes: string[];
    name: string;
    provider: string;
  };
  assert.equal(removeData.action, "remove");
  assert.equal(removeData.name, "work");
  assert.equal(removeData.provider, "codex");
  assert.deepEqual(removeData.deletes, [
    configPath,
    path.join(accountPath, "storage-state.json"),
    path.join(accountPath, "profile"),
  ]);
  assert.equal(fs.readFileSync(configPath, "utf8"), before);
});

test("structured argument errors preserve error code and exit status", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = runSource(fixture, [
    "add",
    "work",
    "--provider",
    "alien",
    "--dry-run",
    "--format",
    "json",
  ]);
  assert.equal(result.status, 2);
  assert.equal(result.stderr, "");
  const envelope = parseJson(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.command, "add");
  assert.equal((envelope.error as { code: string }).code, "INVALID_WIRE_INPUT");
});

test("raw mutation payloads reject unknown properties before writes", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));

  const result = runSource(fixture, [
    "add",
    "--json",
    JSON.stringify({ name: "work", unexpected: true }),
    "--dry-run",
    "--format",
    "json",
  ]);
  assert.equal(result.status, 2);
  const envelope = parseJson(result.stdout);
  assert.equal((envelope.error as { code: string }).code, "INVALID_WIRE_INPUT");
  assert.equal(fs.existsSync(path.join(fixture.home, ".gauge")), false);
});

test("structured errors omit absolute input paths by default", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  const missing = path.join(fixture.home, "credentials", "missing.json");

  const result = runSource(fixture, [
    "add",
    "work",
    "--storage-state-file",
    missing,
    "--dry-run",
    "--format",
    "json",
  ]);

  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout, new RegExp(fixture.home));
  assert.doesNotMatch(result.stdout, /missing\.json/);
});

test("status account filters report provider-qualified ambiguity before acquisition", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  writeAccount(fixture, { name: "work", provider: "claude" });
  writeAccount(fixture, {
    codexHome: "/tmp/codex-work",
    name: "work",
    provider: "codex",
  });

  const result = runSource(fixture, [
    "status",
    "--account",
    "work",
    "--format",
    "json",
  ]);
  assert.equal(result.status, 2);
  const envelope = parseJson(result.stdout);
  assert.deepEqual(envelope.error, {
    code: "AMBIGUOUS_ACCOUNT",
    message: 'Account name "work" is ambiguous.',
    details: { candidates: ["claude:work", "codex:work"] },
  });
});

test("filtered all-failed quick status emits snapshot data and exits one", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  writeAccount(fixture, { name: "work", provider: "cursor" });

  const result = runSource(fixture, [
    "status",
    "--provider",
    "cursor",
    "--account",
    "work",
    "--quick",
    "--format",
    "json",
  ]);
  assert.equal(result.status, 1);
  const envelope = parseJson(result.stdout);
  assert.equal(envelope.ok, false);
  assert.equal((envelope.meta as { result: string }).result, "failed");
  assert.deepEqual(Object.keys(envelope.data as object).sort(), [
    "recommendation",
    "summary",
  ]);
  assert.deepEqual((envelope.data as { summary: unknown }).summary, {
    total: 1,
    succeeded: 0,
    failed: 1,
    timed_out: 0,
  });
});

test("built package bin executes via its shebang", (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { force: true, recursive: true }));
  // Says what to do about it. As a bare `false !== true` this reported the one
  // thing the reader already knew — something is wrong — while the fix, and the
  // fact that this test reads a build artifact at all, had to be inferred.
  assert.equal(
    fs.existsSync(builtCli),
    true,
    `No built CLI at ${builtCli}. This test runs the packaged bin, so run \`pnpm build\` first.`,
  );

  const result = spawnSync(builtCli, ["--version"], {
    cwd: fixture.cwd,
    encoding: "utf8",
    env: isolatedEnv(fixture.home),
    timeout: 10_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${packageVersion}\n`);
});
