import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { z } from "zod";

import { AccountIdSchema } from "./domain/account.js";
import type { AccountId, Provider } from "./domain/account.js";
import {
  AccountRepository,
  isMigratableProfileEntry,
} from "./persistence/account-repository.js";
import { atomicReplace } from "./persistence/atomic-replace.js";
import { CLIError } from "./security.js";
import { parseStorageStateJsonValue } from "./storage-state.js";
import type { PlaywrightStorageState } from "./storage-state.js";

const LegacyConfigSchema = z.strictObject({
  addedAt: z.iso.datetime(),
  codexHome: z.string().min(1).optional(),
  name: z.string(),
  provider: z.enum(["claude", "codex", "cursor"]).optional(),
  renewsAt: z.iso.datetime().optional(),
});

interface LegacyMigrationEntry {
  config: z.infer<typeof LegacyConfigSchema>;
  destination: string;
  id: AccountId;
  profileSource?: string;
  source: string;
  storageSource?: string;
  storageState?: PlaywrightStorageState;
}

export interface LegacyMigrationPlan {
  accounts: {
    destination: string;
    id: AccountId;
    source: string;
  }[];
}

interface MigrationJournalEntry {
  fingerprint?: string;
  id: AccountId;
  source: string;
  status: "pending" | "committed" | "cleaned";
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
  schema_version: 1;
}

export interface MigrationOptions {
  afterAccountCommit?: (id: AccountId) => void;
  afterSourceRemoval?: (source: string) => void;
  randomId?: () => string;
}

const expectedConfig = (
  entry: LegacyMigrationEntry
): Record<string, unknown> => ({
  addedAt: entry.config.addedAt,
  name: entry.id.name,
  provider: entry.id.provider,
  schema_version: 3,
  ...(entry.config.codexHome !== undefined && {
    codexHome: entry.config.codexHome,
  }),
  ...(entry.config.renewsAt !== undefined && {
    renewsAt: entry.config.renewsAt,
  }),
});

const directoryManifest = (directory: string, relative = ""): string[] =>
  fs
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const absolute = path.join(directory, name);
      const child = relative ? path.join(relative, name) : name;
      const status = fs.lstatSync(absolute);
      // Skip transient Chrome singleton locks/sockets — they are not copied,
      // so they must not contribute to the fingerprint either.
      if (!isMigratableProfileEntry(status)) {
        return [];
      }
      if (status.isDirectory()) {
        return [`directory:${child}`, ...directoryManifest(absolute, child)];
      }
      return [
        `file:${child}:${createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`,
      ];
    });

const hashValue = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const entryFingerprint = (entry: LegacyMigrationEntry): string =>
  hashValue({
    config: expectedConfig(entry),
    profile:
      entry.profileSource === undefined
        ? null
        : directoryManifest(entry.profileSource),
    storage: entry.storageState ?? null,
  });

const destinationFingerprint = (
  repository: AccountRepository,
  id: AccountId
): string => {
  const account = repository.get(id);
  return hashValue({
    config: account.config,
    profile: account.hasProfile
      ? directoryManifest(account.paths.profile)
      : null,
    storage: account.hasStorageState
      ? parseStorageStateJsonValue(
          fs.readFileSync(account.paths.storageState, "utf-8")
        )
      : null,
  });
};

const migratableNames = (directory: string): string[] =>
  fs
    .readdirSync(directory)
    .filter((name) =>
      isMigratableProfileEntry(fs.lstatSync(path.join(directory, name)))
    )
    .sort();

const directoriesMatch = (left: string, right: string): boolean => {
  // Compare only migratable entries — transient Chrome singleton artifacts are
  // never copied, so a committed profile legitimately lacks them.
  const leftNames = migratableNames(left);
  const rightNames = migratableNames(right);
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) {
    return false;
  }
  return leftNames.every((name) => {
    const leftPath = path.join(left, name);
    const rightPath = path.join(right, name);
    const leftStatus = fs.lstatSync(leftPath);
    const rightStatus = fs.lstatSync(rightPath);
    if (leftStatus.isDirectory() && rightStatus.isDirectory()) {
      return directoriesMatch(leftPath, rightPath);
    }
    return (
      leftStatus.isFile() &&
      rightStatus.isFile() &&
      fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath))
    );
  });
};

const V3_ROOT_FILES = new Set([
  // Reader preferences, written by v3 and never migrated from anything.
  "display.json",
  "migration-v3.json",
  // The Claude Code session displaced by a switch, kept so it can be undone.
  // Shipped at the root in 4.0.0; written under `backups/` since.
  "claude-session.previous.json",
]);

export const isLegacyConfigFilename = (filename: string): boolean =>
  filename.endsWith(".json") &&
  !filename.startsWith(".") &&
  !V3_ROOT_FILES.has(filename) &&
  !filename.endsWith("-storage.json");

const writeJournal = (journalPath: string, journal: MigrationJournal): void => {
  atomicReplace(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(journalPath, 0o600);
};

const readJournal = (journalPath: string): MigrationJournal | null => {
  if (!fs.existsSync(journalPath)) {
    return null;
  }
  const value = JSON.parse(fs.readFileSync(journalPath, "utf-8")) as unknown;
  const schema = z.strictObject({
    entries: z.array(
      z.strictObject({
        fingerprint: z.string().length(64).optional(),
        id: AccountIdSchema,
        source: z.string(),
        status: z.enum(["pending", "committed", "cleaned"]),
      })
    ),
    schema_version: z.literal(1),
  });
  return schema.parse(value);
};

const missingJournalEntry = (id: AccountId): never => {
  throw migrationConflict("migration-v3.json");
};

const identityKey = (id: AccountId): string => `${id.provider}\0${id.name}`;

const findJournalEntry = (
  journal: MigrationJournal,
  id: AccountId
): MigrationJournalEntry =>
  // Entries are built from this same journal (directly, or through
  // buildJournalEntries), so the lookup always resolves.
  journal.entries.find(
    (candidate) => identityKey(candidate.id) === identityKey(id)
  ) ?? missingJournalEntry(id);

const removeSource = (source: string): void => {
  const status = fs.lstatSync(source);
  if (status.isDirectory()) {
    fs.rmSync(source, { recursive: true });
  } else {
    fs.unlinkSync(source);
  }
};

const removeSourceIfExists = (source: string): void => {
  if (fs.existsSync(source)) {
    removeSource(source);
  }
};

const migrationConflict = (source: string, cause?: unknown): CLIError =>
  new CLIError("Legacy account state conflicts with the v3 identity layout.", {
    code: "MIGRATION_CONFLICT",
    details: {
      source,
      ...(cause instanceof Error && { reason: cause.message }),
    },
  });

const assertDestinationMatches = (
  repository: AccountRepository,
  entry: LegacyMigrationEntry
): void => {
  const existing = repository.get(entry.id);
  const expectedConfig = {
    addedAt: entry.config.addedAt,
    name: entry.id.name,
    provider: entry.id.provider,
    schema_version: 3,
    ...(entry.config.codexHome !== undefined && {
      codexHome: entry.config.codexHome,
    }),
    ...(entry.config.renewsAt !== undefined && {
      renewsAt: entry.config.renewsAt,
    }),
  };
  if (JSON.stringify(existing.config) !== JSON.stringify(expectedConfig)) {
    throw migrationConflict(entry.source);
  }
  if (entry.storageState === undefined) {
    if (existing.hasStorageState) {
      throw migrationConflict(entry.source);
    }
  } else {
    if (!existing.hasStorageState) {
      throw migrationConflict(entry.source);
    }
    const actualStorage = parseStorageStateJsonValue(
      fs.readFileSync(existing.paths.storageState, "utf-8")
    );
    if (JSON.stringify(actualStorage) !== JSON.stringify(entry.storageState)) {
      throw migrationConflict(entry.source);
    }
  }
  if (entry.profileSource === undefined) {
    if (existing.hasProfile) {
      throw migrationConflict(entry.source);
    }
  } else if (
    !existing.hasProfile ||
    !directoriesMatch(entry.profileSource, existing.paths.profile)
  ) {
    throw migrationConflict(entry.source);
  }
};

const assertCommittedDestination = (
  repository: AccountRepository,
  entry: LegacyMigrationEntry,
  fingerprint?: string
): void => {
  if (fs.existsSync(entry.source)) {
    assertDestinationMatches(repository, entry);
  } else {
    const actual = destinationFingerprint(repository, entry.id);
    if (fingerprint !== undefined && actual !== fingerprint) {
      throw migrationConflict(entry.source);
    }
  }
};

const buildEntry = (root: string, filename: string): LegacyMigrationEntry => {
  const source = path.join(root, filename);
  const sourceStatus = fs.lstatSync(source);
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) {
    throw migrationConflict(source);
  }
  let config: z.infer<typeof LegacyConfigSchema>;
  try {
    config = LegacyConfigSchema.parse(
      JSON.parse(fs.readFileSync(source, "utf-8")) as unknown
    );
  } catch (error) {
    throw migrationConflict(source, error);
  }
  const provider: Provider = config.provider ?? "claude";
  const id = AccountIdSchema.parse({ name: config.name, provider });
  const legacyKey = provider === "claude" ? id.name : `${provider}-${id.name}`;
  if (filename !== `${legacyKey}.json`) {
    throw migrationConflict(source);
  }
  const storageSource = path.join(root, `${legacyKey}-storage.json`);
  const profileSource = path.join(root, `profile-${legacyKey}`);
  let storageState: PlaywrightStorageState | undefined;
  if (fs.existsSync(storageSource)) {
    const status = fs.lstatSync(storageSource);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw migrationConflict(storageSource);
    }
    storageState = parseStorageStateJsonValue(
      fs.readFileSync(storageSource, "utf-8")
    );
  }
  if (fs.existsSync(profileSource)) {
    const status = fs.lstatSync(profileSource);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw migrationConflict(profileSource);
    }
  }
  return {
    config,
    destination: path.join(root, "accounts", "v3", provider, id.name),
    id,
    ...(fs.existsSync(profileSource) && { profileSource }),
    source,
    ...(fs.existsSync(storageSource) && { storageSource }),
    ...(storageState && { storageState }),
  };
};

const buildJournalEntries = (
  root: string,
  journal: MigrationJournal
): LegacyMigrationEntry[] =>
  journal.entries.map((journalEntry) => {
    const source = path.resolve(journalEntry.source);
    if (
      path.dirname(source) !== root ||
      !isLegacyConfigFilename(path.basename(source))
    ) {
      throw migrationConflict(journalEntry.source);
    }
    if (fs.existsSync(source)) {
      const entry = buildEntry(root, path.basename(source));
      if (identityKey(entry.id) !== identityKey(journalEntry.id)) {
        throw migrationConflict(source);
      }
      return entry;
    }
    if (journalEntry.status === "pending") {
      throw migrationConflict(source);
    }
    const legacyKey = path.basename(source, ".json");
    const destination = path.join(
      root,
      "accounts",
      "v3",
      journalEntry.id.provider,
      journalEntry.id.name
    );
    const configPath = path.join(destination, "config.json");
    if (!fs.existsSync(configPath)) {
      throw migrationConflict(source);
    }
    const committedConfig = JSON.parse(
      fs.readFileSync(configPath, "utf-8")
    ) as Record<string, unknown>;
    const config = LegacyConfigSchema.parse({
      addedAt: committedConfig.addedAt,
      ...(committedConfig.codexHome !== undefined && {
        codexHome: committedConfig.codexHome,
      }),
      name: committedConfig.name,
      provider: committedConfig.provider,
      ...(committedConfig.renewsAt !== undefined && {
        renewsAt: committedConfig.renewsAt,
      }),
    });
    const storageSource = path.join(root, `${legacyKey}-storage.json`);
    const profileSource = path.join(root, `profile-${legacyKey}`);
    return {
      config,
      destination,
      id: journalEntry.id,
      ...(fs.existsSync(profileSource) && { profileSource }),
      source,
      ...(fs.existsSync(storageSource) && { storageSource }),
    };
  });

const assertJournalFingerprints = (
  journal: MigrationJournal,
  entries: LegacyMigrationEntry[]
): void => {
  for (const entry of entries) {
    const journalEntry = findJournalEntry(journal, entry.id);
    if (
      journalEntry.fingerprint &&
      fs.existsSync(entry.source) &&
      journalEntry.fingerprint !== entryFingerprint(entry)
    ) {
      throw migrationConflict(entry.source);
    }
  }
};

const assertRealDirectory = (root: string): void => {
  const status = fs.lstatSync(root);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw migrationConflict(root);
  }
};

const buildEntries = (dataRoot: string): LegacyMigrationEntry[] => {
  const root = path.resolve(dataRoot);
  if (!fs.existsSync(root)) {
    return [];
  }
  assertRealDirectory(root);
  return fs
    .readdirSync(root)
    .filter(isLegacyConfigFilename)
    .sort()
    .map((filename) => buildEntry(root, filename));
};

export const planLegacyMigration = (dataRoot: string): LegacyMigrationPlan => ({
  accounts: buildEntries(dataRoot).map(({ destination, id, source }) => ({
    destination,
    id,
    source,
  })),
});

export const migrateLegacyAccounts = (
  dataRoot: string,
  options: MigrationOptions = {}
): { migrated: number } => {
  const root = path.resolve(dataRoot);
  const journalPath = path.join(root, "migration-v3.json");
  const existingJournal = readJournal(journalPath);
  const entries = existingJournal
    ? buildJournalEntries(root, existingJournal)
    : buildEntries(root);
  if (entries.length === 0 && !existingJournal) {
    return { migrated: 0 };
  }
  const repository = new AccountRepository({
    dataRoot: root,
    randomId: options.randomId,
  });
  const journal: MigrationJournal = existingJournal ?? {
    entries: entries.map((entry) => ({
      fingerprint: entryFingerprint(entry),
      id: entry.id,
      source: entry.source,
      status: "pending",
    })),
    schema_version: 1,
  };
  assertJournalFingerprints(journal, entries);

  // Validate the complete destination set before creating the journal or
  // committing any account. A conflict in a later account must not make an
  // earlier account visible.
  for (const entry of entries) {
    const journalEntry = findJournalEntry(journal, entry.id);
    if (journalEntry.status === "pending" && fs.existsSync(entry.destination)) {
      assertDestinationMatches(repository, entry);
    } else if (journalEntry.status !== "pending") {
      assertCommittedDestination(repository, entry, journalEntry.fingerprint);
    }
  }
  writeJournal(journalPath, journal);

  for (const entry of entries) {
    const journalEntry = findJournalEntry(journal, entry.id);
    if (journalEntry.status === "pending") {
      if (!fs.existsSync(entry.destination)) {
        repository.add(entry.id, {
          addedAt: entry.config.addedAt,
          codexHome: entry.config.codexHome,
          profileSource: entry.profileSource,
          renewsAt: entry.config.renewsAt,
          storageState: entry.storageState,
        });
      }
      journalEntry.status = "committed";
      writeJournal(journalPath, journal);
      options.afterAccountCommit?.(entry.id);
    }
  }

  for (const entry of entries) {
    const journalEntry = findJournalEntry(journal, entry.id);
    if (journalEntry.status === "cleaned") {
      continue;
    }
    removeSourceIfExists(entry.source);
    options.afterSourceRemoval?.(entry.source);
    if (entry.storageSource !== undefined) {
      removeSourceIfExists(entry.storageSource);
    }
    if (entry.profileSource !== undefined) {
      removeSourceIfExists(entry.profileSource);
    }
    journalEntry.status = "cleaned";
    writeJournal(journalPath, journal);
  }
  fs.unlinkSync(journalPath);
  return { migrated: journal.entries.length };
};

const findTombstones = (accountsRoot: string): string[] => {
  if (!fs.existsSync(accountsRoot)) {
    return [];
  }
  const results: string[] = [];
  for (const provider of fs.readdirSync(accountsRoot)) {
    const providerPath = path.join(accountsRoot, provider);
    if (!fs.lstatSync(providerPath).isDirectory()) {
      continue;
    }
    for (const name of fs.readdirSync(providerPath)) {
      if (name.includes(".tombstone-")) {
        results.push(path.join(providerPath, name));
      }
    }
  }
  return results.sort();
};

export const inspectLegacyState = (
  dataRoot: string
): {
  journal: boolean;
  legacy: boolean;
  tombstones: string[];
} => {
  const root = path.resolve(dataRoot);
  if (!fs.existsSync(root)) {
    return { journal: false, legacy: false, tombstones: [] };
  }
  assertRealDirectory(root);
  const names = fs.readdirSync(root);
  const tombstones = findTombstones(path.join(root, "accounts", "v3"));
  return {
    journal: fs.existsSync(path.join(root, "migration-v3.json")),
    legacy: names.some(isLegacyConfigFilename),
    tombstones,
  };
};
