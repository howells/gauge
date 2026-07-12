import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  inspectLegacyState,
  migrateLegacyAccounts,
  planLegacyMigration,
} from "../src/migrate.js";
import { AccountRepository } from "../src/persistence/account-repository.js";
import { CLIError } from "../src/security.js";

function dataRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gauge-migrate-"));
}

function writeLegacy(
  root: string,
  filename: string,
  config: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(root, `${filename}.json`),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

test("legacy migration preflight detects v2 state without mutating it", () => {
  const root = dataRoot();
  writeLegacy(root, "personal", {
    name: "personal",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  const before = fs.readdirSync(root);

  assert.deepEqual(inspectLegacyState(root), {
    journal: false,
    legacy: true,
    tombstones: [],
  });
  const plan = planLegacyMigration(root);
  assert.deepEqual(plan.accounts, [
    {
      destination: path.join(root, "accounts", "v3", "claude", "personal"),
      id: { provider: "claude", name: "personal" },
      source: path.join(root, "personal.json"),
    },
  ]);
  assert.deepEqual(fs.readdirSync(root), before);
});

test("migration rejects provider and name conflicts before writing", () => {
  const root = dataRoot();
  writeLegacy(root, "codex-work", {
    provider: "cursor",
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });

  assert.throws(
    () => planLegacyMigration(root),
    (error: unknown) =>
      error instanceof CLIError && error.code === "MIGRATION_CONFLICT",
  );
  assert.equal(fs.existsSync(path.join(root, "accounts")), false);
  assert.equal(fs.existsSync(path.join(root, "migration-v3.json")), false);
});

test("migration validates referenced storage state during dry-run", () => {
  const root = dataRoot();
  writeLegacy(root, "cursor-work", {
    provider: "cursor",
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(path.join(root, "cursor-work-storage.json"), "not json");

  assert.throws(() => planLegacyMigration(root), /storage state/i);
  assert.deepEqual(fs.readdirSync(root).sort(), [
    "cursor-work-storage.json",
    "cursor-work.json",
  ]);
});

test("migration commits v3 directories, copies profiles, and cleans legacy sources", () => {
  const root = dataRoot();
  writeLegacy(root, "cursor-work", {
    provider: "cursor",
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(
    path.join(root, "cursor-work-storage.json"),
    JSON.stringify({ cookies: [], origins: [] }),
  );
  fs.mkdirSync(path.join(root, "profile-cursor-work"));
  fs.writeFileSync(path.join(root, "profile-cursor-work", "cache"), "data");

  const result = migrateLegacyAccounts(root, {
    randomId: () => "migration",
  });

  assert.equal(result.migrated, 1);
  const destination = path.join(root, "accounts", "v3", "cursor", "work");
  assert.equal(fs.existsSync(path.join(destination, "config.json")), true);
  assert.equal(
    fs.existsSync(path.join(destination, "storage-state.json")),
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(destination, "profile", "cache"), "utf8"),
    "data",
  );
  assert.equal(fs.existsSync(path.join(root, "cursor-work.json")), false);
  assert.equal(
    fs.existsSync(path.join(root, "cursor-work-storage.json")),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, "profile-cursor-work")), false);
  assert.equal(fs.existsSync(path.join(root, "migration-v3.json")), false);
});

test("migration skips transient Chrome singleton artifacts inside profiles", () => {
  const root = dataRoot();
  writeLegacy(root, "cursor-work", {
    provider: "cursor",
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(
    path.join(root, "cursor-work-storage.json"),
    JSON.stringify({ cookies: [], origins: [] }),
  );
  const profileDir = path.join(root, "profile-cursor-work");
  fs.mkdirSync(profileDir);
  fs.writeFileSync(path.join(profileDir, "cache"), "data");
  const nestedDir = path.join(profileDir, "nested");
  fs.mkdirSync(nestedDir);
  fs.writeFileSync(path.join(nestedDir, "inner"), "nested-data");
  fs.symlinkSync(
    "150.0.7871.47:1",
    path.join(profileDir, "RunningChromeVersion"),
  );
  fs.symlinkSync(
    "nonexistent-target",
    path.join(profileDir, "SingletonCookie"),
  );

  const result = migrateLegacyAccounts(root, {
    randomId: () => "migration",
  });

  assert.equal(result.migrated, 1);
  const destination = path.join(root, "accounts", "v3", "cursor", "work");
  const destinationProfile = path.join(destination, "profile");
  assert.equal(
    fs.readFileSync(path.join(destinationProfile, "cache"), "utf8"),
    "data",
  );
  assert.equal(
    fs.readFileSync(path.join(destinationProfile, "nested", "inner"), "utf8"),
    "nested-data",
  );
  assert.equal(
    fs.existsSync(path.join(destinationProfile, "RunningChromeVersion")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(destinationProfile, "SingletonCookie")),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, "cursor-work.json")), false);
  assert.equal(
    fs.existsSync(path.join(root, "cursor-work-storage.json")),
    false,
  );
  assert.equal(fs.existsSync(profileDir), false);
  assert.equal(fs.existsSync(path.join(root, "migration-v3.json")), false);
});

test("migration resumes idempotently after interruption without deleting sources early", () => {
  const root = dataRoot();
  for (const name of ["one", "two"]) {
    writeLegacy(root, name, {
      name,
      addedAt: "2026-01-01T00:00:00.000Z",
    });
  }
  let commits = 0;

  assert.throws(
    () =>
      migrateLegacyAccounts(root, {
        afterAccountCommit: () => {
          commits += 1;
          if (commits === 1) throw new Error("injected interruption");
        },
        randomId: () => "migration",
      }),
    /injected interruption/,
  );
  assert.equal(fs.existsSync(path.join(root, "one.json")), true);
  assert.equal(fs.existsSync(path.join(root, "two.json")), true);
  assert.equal(
    fs.statSync(path.join(root, "migration-v3.json")).mode & 0o777,
    0o600,
  );

  const result = migrateLegacyAccounts(root, {
    randomId: () => "migration-resume",
  });
  assert.equal(result.migrated, 2);
  assert.equal(fs.existsSync(path.join(root, "one.json")), false);
  assert.equal(fs.existsSync(path.join(root, "two.json")), false);
  assert.deepEqual(
    ["one", "two"].map((name) =>
      fs.existsSync(
        path.join(root, "accounts", "v3", "claude", name, "config.json"),
      ),
    ),
    [true, true],
  );
});

test("migration resumes cleanup after the legacy config was already removed", () => {
  const root = dataRoot();
  writeLegacy(root, "cursor-work", {
    provider: "cursor",
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(
    path.join(root, "cursor-work-storage.json"),
    JSON.stringify({ cookies: [], origins: [] }),
  );
  let interrupted = false;

  assert.throws(
    () =>
      migrateLegacyAccounts(root, {
        afterSourceRemoval: (source) => {
          if (!interrupted && source.endsWith("cursor-work.json")) {
            interrupted = true;
            throw new Error("injected cleanup interruption");
          }
        },
        randomId: () => "migration",
      }),
    /injected cleanup interruption/,
  );
  assert.equal(fs.existsSync(path.join(root, "cursor-work.json")), false);
  assert.equal(
    fs.existsSync(path.join(root, "cursor-work-storage.json")),
    true,
  );
  assert.equal(fs.existsSync(path.join(root, "migration-v3.json")), true);

  assert.deepEqual(migrateLegacyAccounts(root), { migrated: 1 });
  assert.equal(
    fs.existsSync(path.join(root, "cursor-work-storage.json")),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, "migration-v3.json")), false);
});

test("migration recovery fingerprints committed artifacts after source removal", () => {
  const root = dataRoot();
  writeLegacy(root, "cursor-work", {
    provider: "cursor",
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(
    path.join(root, "cursor-work-storage.json"),
    JSON.stringify({ cookies: [], origins: [] }),
  );
  assert.throws(
    () =>
      migrateLegacyAccounts(root, {
        afterSourceRemoval: (source) => {
          if (source.endsWith("cursor-work.json")) {
            throw new Error("injected cleanup interruption");
          }
        },
      }),
    /injected cleanup interruption/,
  );
  fs.writeFileSync(
    path.join(root, "accounts", "v3", "cursor", "work", "storage-state.json"),
    JSON.stringify({
      cookies: [
        {
          domain: ".cursor.com",
          expires: -1,
          httpOnly: true,
          name: "session",
          path: "/",
          sameSite: "Lax",
          secure: true,
          value: "tampered",
        },
      ],
      origins: [],
    }),
  );

  assert.throws(
    () => migrateLegacyAccounts(root),
    (error: unknown) =>
      error instanceof CLIError && error.code === "MIGRATION_CONFLICT",
  );
  assert.equal(fs.existsSync(path.join(root, "migration-v3.json")), true);
  assert.equal(
    fs.existsSync(path.join(root, "cursor-work-storage.json")),
    true,
  );
});

test("migration rejects a differing existing v3 destination before cleanup", () => {
  const root = dataRoot();
  writeLegacy(root, "work", {
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
    renewsAt: "2026-02-01T00:00:00.000Z",
  });
  const destination = path.join(root, "accounts", "v3", "claude", "work");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(
    path.join(destination, "config.json"),
    JSON.stringify({
      schema_version: 3,
      provider: "claude",
      name: "work",
      addedAt: "2026-01-01T00:00:00.000Z",
      renewsAt: "2026-03-01T00:00:00.000Z",
    }),
  );

  assert.throws(
    () => migrateLegacyAccounts(root),
    (error: unknown) =>
      error instanceof CLIError && error.code === "MIGRATION_CONFLICT",
  );
  assert.equal(fs.existsSync(path.join(root, "work.json")), true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(destination, "config.json"), "utf8"))
      .renewsAt,
    "2026-03-01T00:00:00.000Z",
  );
});

test("migration preflights every destination before committing any account", () => {
  const root = dataRoot();
  writeLegacy(root, "alpha", {
    addedAt: "2025-01-01T00:00:00.000Z",
    name: "alpha",
  });
  writeLegacy(root, "zulu", {
    addedAt: "2025-01-02T00:00:00.000Z",
    name: "zulu",
  });
  const repository = new AccountRepository({ dataRoot: root });
  repository.add(
    { provider: "claude", name: "zulu" },
    { addedAt: "2024-01-01T00:00:00.000Z" },
  );

  assert.throws(
    () => migrateLegacyAccounts(root),
    (error: unknown) =>
      error instanceof CLIError && error.code === "MIGRATION_CONFLICT",
  );
  assert.equal(
    fs.existsSync(path.join(root, "accounts", "v3", "claude", "alpha")),
    false,
  );
  assert.equal(fs.existsSync(path.join(root, "migration-v3.json")), false);
  assert.equal(fs.existsSync(path.join(root, "alpha.json")), true);
  assert.equal(fs.existsSync(path.join(root, "zulu.json")), true);
});

test("migration accepts only a byte-equivalent existing destination", () => {
  const root = dataRoot();
  const profile = path.join(root, "profile-work");
  fs.mkdirSync(path.join(profile, "nested"), { recursive: true });
  fs.writeFileSync(path.join(profile, "nested", "cache"), "same-profile");
  writeLegacy(root, "work", {
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  const storageState = { cookies: [], origins: [] };
  fs.writeFileSync(
    path.join(root, "work-storage.json"),
    JSON.stringify(storageState),
  );
  new AccountRepository({ dataRoot: root }).add(
    { provider: "claude", name: "work" },
    {
      addedAt: "2026-01-01T00:00:00.000Z",
      profileSource: profile,
      storageState,
    },
  );

  assert.deepEqual(migrateLegacyAccounts(root), { migrated: 1 });
  assert.equal(fs.existsSync(path.join(root, "work.json")), false);
  assert.equal(
    fs.readFileSync(
      path.join(
        root,
        "accounts",
        "v3",
        "claude",
        "work",
        "profile",
        "nested",
        "cache",
      ),
      "utf8",
    ),
    "same-profile",
  );
});

test("migration recovery rejects unsafe journal sources and missing committed destinations", () => {
  for (const journal of [
    {
      id: { provider: "claude", name: "work" },
      source: path.join(os.tmpdir(), "outside-work.json"),
      status: "committed",
    },
    {
      id: { provider: "claude", name: "work" },
      source: path.join(dataRoot(), "work.json"),
      status: "committed",
    },
  ] as const) {
    const root = dataRoot();
    const entry = journal.source.endsWith("outside-work.json")
      ? journal
      : { ...journal, source: path.join(root, "work.json") };
    fs.writeFileSync(
      path.join(root, "migration-v3.json"),
      JSON.stringify({ schema_version: 1, entries: [entry] }),
      { mode: 0o600 },
    );
    assert.throws(
      () => migrateLegacyAccounts(root),
      (error: unknown) =>
        error instanceof CLIError && error.code === "MIGRATION_CONFLICT",
    );
  }
});

test("migration rejects symlinked configs, storage state, profiles, and roots", () => {
  const cases = ["config", "storage", "profile"] as const;
  for (const artifact of cases) {
    const root = dataRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-outside-"));
    if (artifact === "config") {
      fs.writeFileSync(
        path.join(outside, "config.json"),
        JSON.stringify({ name: "work", addedAt: "2026-01-01T00:00:00.000Z" }),
      );
      fs.symlinkSync(
        path.join(outside, "config.json"),
        path.join(root, "work.json"),
      );
    } else {
      writeLegacy(root, "work", {
        name: "work",
        addedAt: "2026-01-01T00:00:00.000Z",
      });
      const suffix =
        artifact === "storage" ? "work-storage.json" : "profile-work";
      const target = path.join(outside, artifact);
      if (artifact === "storage") fs.writeFileSync(target, "{}");
      else fs.mkdirSync(target);
      fs.symlinkSync(
        target,
        path.join(root, suffix),
        artifact === "profile" ? "dir" : "file",
      );
    }
    assert.throws(
      () => planLegacyMigration(root),
      (error: unknown) =>
        error instanceof CLIError && error.code === "MIGRATION_CONFLICT",
    );
  }

  const realRoot = dataRoot();
  const linkedRoot = `${realRoot}-link`;
  fs.symlinkSync(realRoot, linkedRoot, "dir");
  assert.throws(() => inspectLegacyState(linkedRoot));
});

test("migration rejects a journal that does not match the legacy sources", () => {
  const root = dataRoot();
  writeLegacy(root, "work", {
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  fs.writeFileSync(
    path.join(root, "migration-v3.json"),
    JSON.stringify({
      schema_version: 1,
      entries: [
        {
          id: { provider: "claude", name: "different" },
          source: path.join(root, "different.json"),
          status: "pending",
        },
      ],
    }),
    { mode: 0o600 },
  );

  assert.throws(
    () => migrateLegacyAccounts(root),
    (error: unknown) =>
      error instanceof CLIError && error.code === "MIGRATION_CONFLICT",
  );
  assert.equal(fs.existsSync(path.join(root, "work.json")), true);
});

test("migration rejects a journal fingerprint that differs from its source", () => {
  const root = dataRoot();
  writeLegacy(root, "work", {
    name: "work",
    addedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.throws(
    () =>
      migrateLegacyAccounts(root, {
        afterAccountCommit: () => {
          throw new Error("injected interruption");
        },
      }),
    /injected interruption/,
  );
  const journalPath = path.join(root, "migration-v3.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as {
    entries: Array<{ fingerprint: string }>;
  };
  const [entry] = journal.entries;
  assert.ok(entry);
  entry.fingerprint = "0".repeat(64);
  fs.writeFileSync(journalPath, JSON.stringify(journal), { mode: 0o600 });

  assert.throws(
    () => migrateLegacyAccounts(root),
    (error: unknown) =>
      error instanceof CLIError && error.code === "MIGRATION_CONFLICT",
  );
  assert.equal(fs.existsSync(path.join(root, "work.json")), true);
});
