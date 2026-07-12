import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  type AccountId,
  AccountIdSchema,
  type Provider,
} from "./domain/account.js";
import {
  AccountRepository,
  isMigratableProfileEntry,
} from "./persistence/account-repository.js";
import { atomicReplace } from "./persistence/atomic-replace.js";
import { CLIError } from "./security.js";
import {
  type PlaywrightStorageState,
  parseStorageStateJsonValue,
} from "./storage-state.js";

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
  accounts: Array<{
    destination: string;
    id: AccountId;
    source: string;
  }>;
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

/** Inspect legacy and recovery markers without creating or changing paths. */
export function inspectLegacyState(dataRoot: string): {
  journal: boolean;
  legacy: boolean;
  tombstones: string[];
} {
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
}

/** Validate and return the complete legacy-to-v3 mapping without writes. */
export function planLegacyMigration(dataRoot: string): LegacyMigrationPlan {
  return {
    accounts: buildEntries(dataRoot).map(({ destination, id, source }) => ({
      destination,
      id,
      source,
    })),
  };
}

/** Migrate all legacy accounts through staged account-directory commits. */
export function migrateLegacyAccounts(
  dataRoot: string,
  options: MigrationOptions = {},
): { migrated: number } {
  const root = path.resolve(dataRoot);
  const journalPath = path.join(root, "migration-v3.json");
  const existingJournal = readJournal(journalPath);
  const entries = existingJournal
    ? buildJournalEntries(root, existingJournal)
    : buildEntries(root);
  if (entries.length === 0 && !existingJournal) return { migrated: 0 };
  const repository = new AccountRepository({
    dataRoot: root,
    randomId: options.randomId,
  });
  const journal: MigrationJournal = existingJournal ?? {
    schema_version: 1,
    entries: entries.map((entry) => ({
      fingerprint: entryFingerprint(entry),
      id: entry.id,
      source: entry.source,
      status: "pending",
    })),
  };
  assertJournalMatches(journal, entries);

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
    if (entry.storageSource) removeSourceIfExists(entry.storageSource);
    if (entry.profileSource) removeSourceIfExists(entry.profileSource);
    journalEntry.status = "cleaned";
    writeJournal(journalPath, journal);
  }
  fs.unlinkSync(journalPath);
  return { migrated: journal.entries.length };
}

function buildJournalEntries(
  root: string,
  journal: MigrationJournal,
): LegacyMigrationEntry[] {
  return journal.entries.map((journalEntry) => {
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
      journalEntry.id.name,
    );
    const configPath = path.join(destination, "config.json");
    if (!fs.existsSync(configPath)) throw migrationConflict(source);
    const committedConfig = JSON.parse(
      fs.readFileSync(configPath, "utf8"),
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
}

function buildEntries(dataRoot: string): LegacyMigrationEntry[] {
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
}

function assertDestinationMatches(
  repository: AccountRepository,
  entry: LegacyMigrationEntry,
): void {
  const existing = repository.get(entry.id);
  const expectedConfig = {
    schema_version: 3,
    provider: entry.id.provider,
    name: entry.id.name,
    addedAt: entry.config.addedAt,
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
    if (existing.hasStorageState) throw migrationConflict(entry.source);
  } else {
    if (!existing.hasStorageState) throw migrationConflict(entry.source);
    const actualStorage = parseStorageStateJsonValue(
      fs.readFileSync(existing.paths.storageState, "utf8"),
    );
    if (JSON.stringify(actualStorage) !== JSON.stringify(entry.storageState)) {
      throw migrationConflict(entry.source);
    }
  }
  if (entry.profileSource === undefined) {
    if (existing.hasProfile) throw migrationConflict(entry.source);
  } else if (
    !existing.hasProfile ||
    !directoriesMatch(entry.profileSource, existing.paths.profile)
  ) {
    throw migrationConflict(entry.source);
  }
}

function assertCommittedDestination(
  repository: AccountRepository,
  entry: LegacyMigrationEntry,
  fingerprint?: string,
): void {
  if (fs.existsSync(entry.source)) {
    assertDestinationMatches(repository, entry);
  } else {
    const actual = destinationFingerprint(repository, entry.id);
    if (fingerprint && actual !== fingerprint) {
      throw migrationConflict(entry.source);
    }
  }
}

function entryFingerprint(entry: LegacyMigrationEntry): string {
  return hashValue({
    config: expectedConfig(entry),
    profile: entry.profileSource
      ? directoryManifest(entry.profileSource)
      : null,
    storage: entry.storageState ?? null,
  });
}

function destinationFingerprint(
  repository: AccountRepository,
  id: AccountId,
): string {
  const account = repository.get(id);
  return hashValue({
    config: account.config,
    profile: account.hasProfile
      ? directoryManifest(account.paths.profile)
      : null,
    storage: account.hasStorageState
      ? parseStorageStateJsonValue(
          fs.readFileSync(account.paths.storageState, "utf8"),
        )
      : null,
  });
}

function expectedConfig(entry: LegacyMigrationEntry): Record<string, unknown> {
  return {
    schema_version: 3,
    provider: entry.id.provider,
    name: entry.id.name,
    addedAt: entry.config.addedAt,
    ...(entry.config.codexHome !== undefined && {
      codexHome: entry.config.codexHome,
    }),
    ...(entry.config.renewsAt !== undefined && {
      renewsAt: entry.config.renewsAt,
    }),
  };
}

function directoryManifest(directory: string, relative = ""): string[] {
  return fs
    .readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const absolute = path.join(directory, name);
      const child = relative ? path.join(relative, name) : name;
      const status = fs.lstatSync(absolute);
      // Skip transient Chrome singleton locks/sockets — they are not copied,
      // so they must not contribute to the fingerprint either.
      if (!isMigratableProfileEntry(status)) return [];
      if (status.isDirectory()) {
        return [`directory:${child}`, ...directoryManifest(absolute, child)];
      }
      return [
        `file:${child}:${createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`,
      ];
    });
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function migratableNames(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((name) =>
      isMigratableProfileEntry(fs.lstatSync(path.join(directory, name))),
    )
    .sort();
}

function directoriesMatch(left: string, right: string): boolean {
  // Compare only migratable entries — transient Chrome singleton artifacts are
  // never copied, so a committed profile legitimately lacks them.
  const leftNames = migratableNames(left);
  const rightNames = migratableNames(right);
  if (JSON.stringify(leftNames) !== JSON.stringify(rightNames)) return false;
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
}

function buildEntry(root: string, filename: string): LegacyMigrationEntry {
  const source = path.join(root, filename);
  const sourceStatus = fs.lstatSync(source);
  if (sourceStatus.isSymbolicLink() || !sourceStatus.isFile()) {
    throw migrationConflict(source);
  }
  let config: z.infer<typeof LegacyConfigSchema>;
  try {
    config = LegacyConfigSchema.parse(
      JSON.parse(fs.readFileSync(source, "utf8")) as unknown,
    );
  } catch (error) {
    throw migrationConflict(source, error);
  }
  const provider: Provider = config.provider ?? "claude";
  const id = AccountIdSchema.parse({ provider, name: config.name });
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
      fs.readFileSync(storageSource, "utf8"),
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
}

function isLegacyConfigFilename(filename: string): boolean {
  return (
    filename.endsWith(".json") &&
    !filename.startsWith(".") &&
    filename !== "migration-v3.json" &&
    !filename.endsWith("-storage.json")
  );
}

function writeJournal(journalPath: string, journal: MigrationJournal): void {
  atomicReplace(journalPath, `${JSON.stringify(journal, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(journalPath, 0o600);
}

function readJournal(journalPath: string): MigrationJournal | null {
  if (!fs.existsSync(journalPath)) return null;
  const value = JSON.parse(fs.readFileSync(journalPath, "utf8")) as unknown;
  const schema = z.strictObject({
    schema_version: z.literal(1),
    entries: z.array(
      z.strictObject({
        fingerprint: z.string().length(64).optional(),
        id: AccountIdSchema,
        source: z.string(),
        status: z.enum(["pending", "committed", "cleaned"]),
      }),
    ),
  });
  return schema.parse(value);
}

function assertJournalMatches(
  journal: MigrationJournal,
  entries: LegacyMigrationEntry[],
): void {
  const expected = entries.map((entry) => identityKey(entry.id)).sort();
  const actual = journal.entries.map((entry) => identityKey(entry.id)).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw migrationConflict("migration-v3.json");
  }
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
}

function findJournalEntry(
  journal: MigrationJournal,
  id: AccountId,
): MigrationJournalEntry {
  const entry = journal.entries.find(
    (candidate) => identityKey(candidate.id) === identityKey(id),
  );
  if (!entry) throw migrationConflict("migration-v3.json");
  return entry;
}

function identityKey(id: AccountId): string {
  return `${id.provider}\0${id.name}`;
}

function removeSource(source: string): void {
  const status = fs.lstatSync(source);
  if (status.isDirectory()) {
    fs.rmSync(source, { recursive: true });
  } else {
    fs.unlinkSync(source);
  }
}

function removeSourceIfExists(source: string): void {
  if (fs.existsSync(source)) removeSource(source);
}

function assertRealDirectory(root: string): void {
  const status = fs.lstatSync(root);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw migrationConflict(root);
  }
}

function migrationConflict(source: string, cause?: unknown): CLIError {
  return new CLIError(
    "Legacy account state conflicts with the v3 identity layout.",
    {
      code: "MIGRATION_CONFLICT",
      details: {
        source,
        ...(cause instanceof Error && { reason: cause.message }),
      },
    },
  );
}

function findTombstones(accountsRoot: string): string[] {
  if (!fs.existsSync(accountsRoot)) return [];
  const results: string[] = [];
  for (const provider of fs.readdirSync(accountsRoot)) {
    const providerPath = path.join(accountsRoot, provider);
    if (!fs.lstatSync(providerPath).isDirectory()) continue;
    for (const name of fs.readdirSync(providerPath)) {
      if (name.includes(".tombstone-")) {
        results.push(path.join(providerPath, name));
      }
    }
  }
  return results.sort();
}
