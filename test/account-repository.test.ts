import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AccountRepository } from "../src/persistence/account-repository.js";

function repository(
  overrides: Partial<ConstructorParameters<typeof AccountRepository>[0]> = {},
): { dataRoot: string; repository: AccountRepository } {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-accounts-"));
  return {
    dataRoot,
    repository: new AccountRepository({
      dataRoot,
      now: () => new Date("2026-07-11T12:00:00.000Z"),
      randomId: () => "operation",
      ...overrides,
    }),
  };
}

test("AccountRepository stores provider-scoped accounts in the exact v3 layout", () => {
  const { dataRoot, repository: accounts } = repository();

  accounts.add({ provider: "claude", name: "codex-work" });
  accounts.add(
    { provider: "codex", name: "work" },
    { codexHome: "/tmp/codex-work" },
  );

  assert.equal(
    fs.existsSync(
      path.join(
        dataRoot,
        "accounts",
        "v3",
        "claude",
        "codex-work",
        "config.json",
      ),
    ),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(dataRoot, "accounts", "v3", "codex", "work", "config.json"),
    ),
    true,
  );
  assert.deepEqual(
    accounts.list().map((account) => account.id),
    [
      { provider: "claude", name: "codex-work" },
      { provider: "codex", name: "work" },
    ],
  );
});

test("AccountRepository validates storage state before exposing a staged add", () => {
  const { dataRoot, repository: accounts } = repository();

  assert.throws(() =>
    accounts.add(
      { provider: "cursor", name: "work" },
      { storageState: { cookies: [{ name: "broken" }], origins: [] } },
    ),
  );

  assert.equal(
    fs.existsSync(path.join(dataRoot, "accounts", "v3", "cursor", "work")),
    false,
  );
  const providerDirectory = path.join(dataRoot, "accounts", "v3", "cursor");
  assert.deepEqual(
    fs.existsSync(providerDirectory) ? fs.readdirSync(providerDirectory) : [],
    [],
  );
});

test("AccountRepository refresh preserves the committed file when replacement fails", () => {
  const { dataRoot, repository: accounts } = repository();
  const id = { provider: "claude", name: "work" } as const;
  accounts.add(id, {
    storageState: { cookies: [], origins: [] },
  });
  const storagePath = path.join(
    dataRoot,
    "accounts",
    "v3",
    "claude",
    "work",
    "storage-state.json",
  );
  const before = fs.readFileSync(storagePath, "utf8");

  const failing = new AccountRepository({
    dataRoot,
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    randomId: () => "refresh",
    replaceFile: () => {
      throw new Error("injected replacement failure");
    },
  });

  assert.throws(
    () => failing.refresh(id, { storageState: { cookies: [], origins: [] } }),
    /injected replacement failure/,
  );
  assert.equal(fs.readFileSync(storagePath, "utf8"), before);
});

test("AccountRepository refresh rolls back an earlier replacement when a later one fails", () => {
  const { dataRoot, repository: accounts } = repository();
  const id = { provider: "claude", name: "work" } as const;
  accounts.add(id, {
    renewsAt: "2026-07-12T00:00:00.000Z",
    storageState: { cookies: [], origins: [] },
  });
  const before = accounts.get(id);
  const beforeConfig = fs.readFileSync(before.paths.config, "utf8");
  const beforeStorage = fs.readFileSync(before.paths.storageState, "utf8");
  let replacements = 0;
  const failing = new AccountRepository({
    dataRoot,
    replaceFile: (target, content, mode) => {
      replacements += 1;
      if (replacements === 2) throw new Error("injected second-write failure");
      fs.writeFileSync(target, content, { mode });
    },
  });

  assert.throws(
    () =>
      failing.refresh(id, {
        renewsAt: "2026-08-01T00:00:00.000Z",
        storageState: {
          cookies: [
            {
              domain: ".claude.ai",
              expires: -1,
              httpOnly: true,
              name: "session",
              path: "/",
              sameSite: "Lax",
              secure: true,
              value: "new",
            },
          ],
          origins: [],
        },
      }),
    /injected second-write failure/,
  );
  assert.equal(fs.readFileSync(before.paths.config, "utf8"), beforeConfig);
  assert.equal(
    fs.readFileSync(before.paths.storageState, "utf8"),
    beforeStorage,
  );
});

test("AccountRepository hides an account before recursive tombstone cleanup", () => {
  const removed: string[] = [];
  const { dataRoot, repository: initial } = repository();
  const id = { provider: "cursor", name: "work" } as const;
  initial.add(id);

  const accounts = new AccountRepository({
    dataRoot,
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    randomId: () => "remove",
    removeTree: (target) => {
      removed.push(target);
      throw new Error("injected cleanup failure");
    },
  });

  assert.throws(() => accounts.remove(id), /injected cleanup failure/);
  assert.deepEqual(accounts.list(), []);
  assert.equal(
    fs.existsSync(path.join(dataRoot, "accounts", "v3", "cursor", "work")),
    false,
  );
  assert.match(removed[0] ?? "", /\.work\.tombstone-remove$/);
  assert.equal(fs.existsSync(removed[0] ?? ""), true);
});

test("AccountRepository creates owner-only directories and files", () => {
  const { dataRoot, repository: accounts } = repository();
  accounts.add(
    { provider: "claude", name: "work" },
    {
      storageState: { cookies: [], origins: [] },
    },
  );

  const directory = path.join(dataRoot, "accounts", "v3", "claude", "work");
  const config = path.join(directory, "config.json");
  const storageState = path.join(directory, "storage-state.json");
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  assert.equal(fs.statSync(storageState).mode & 0o777, 0o600);
});

test("AccountRepository rejects symlinked data roots", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-accounts-"));
  const realRoot = path.join(parent, "real");
  const linkedRoot = path.join(parent, "linked");
  fs.mkdirSync(realRoot);
  fs.symlinkSync(realRoot, linkedRoot, "dir");
  const accounts = new AccountRepository({ dataRoot: linkedRoot });

  assert.throws(
    () => accounts.add({ provider: "claude", name: "work" }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "UNSAFE_ACCOUNT_PATH",
  );
  assert.deepEqual(fs.readdirSync(realRoot), []);
});

test("AccountRepository rejects duplicate and missing account operations", () => {
  const { repository: accounts } = repository();
  const id = { provider: "claude", name: "work" } as const;
  accounts.add(id);

  assert.throws(() => accounts.add(id));
  assert.throws(() => accounts.get({ provider: "claude", name: "missing" }));
  assert.throws(() =>
    accounts.refresh({ provider: "claude", name: "missing" }, {}),
  );
  assert.equal(accounts.remove({ provider: "claude", name: "missing" }), false);
});

test("AccountRepository lists an existing data root without an accounts tree", () => {
  const { repository: accounts } = repository();
  assert.deepEqual(accounts.list(), []);
});

test("AccountRepository rollback removes a newly introduced storage file", () => {
  const { dataRoot, repository: accounts } = repository();
  const id = { provider: "claude", name: "work" } as const;
  accounts.add(id);
  const record = accounts.get(id);
  let replacements = 0;
  const failing = new AccountRepository({
    dataRoot,
    replaceFile: (target, content, mode) => {
      replacements += 1;
      if (replacements === 2) throw new Error("config replacement failed");
      fs.writeFileSync(target, content, { mode });
    },
  });

  assert.throws(
    () =>
      failing.refresh(id, {
        storageState: { cookies: [], origins: [] },
      }),
    /config replacement failed/,
  );
  assert.equal(fs.existsSync(record.paths.storageState), false);
});

test("AccountRepository add() excludes non-file profile entries from the copy", () => {
  const { repository: accounts } = repository();
  const id = { provider: "claude", name: "work" } as const;
  const profileSource = fs.mkdtempSync(
    path.join(os.tmpdir(), "gauge-profile-source-"),
  );
  fs.writeFileSync(path.join(profileSource, "cache"), "data");
  fs.symlinkSync(
    "nonexistent-target",
    path.join(profileSource, "SingletonLock"),
  );

  const record = accounts.add(id, { profileSource });

  assert.equal(
    fs.readFileSync(path.join(record.paths.profile, "cache"), "utf8"),
    "data",
  );
  assert.equal(
    fs.existsSync(path.join(record.paths.profile, "SingletonLock")),
    false,
  );
});
