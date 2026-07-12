import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type AccountConfigV3,
  AccountConfigV3Schema,
  type AccountId,
  AccountIdSchema,
  type Provider,
} from "../domain/account.js";
import { CLIError } from "../security.js";
import {
  type PlaywrightStorageState,
  parseStorageStateObject,
} from "../storage-state.js";
import { atomicReplace } from "./atomic-replace.js";

export interface AccountRecord {
  config: AccountConfigV3;
  hasProfile: boolean;
  hasStorageState: boolean;
  id: AccountId;
  paths: AccountPaths;
}

export interface AccountPaths {
  config: string;
  directory: string;
  profile: string;
  storageState: string;
}

export interface AccountWrite {
  addedAt?: string;
  codexHome?: string;
  profileSource?: string;
  renewsAt?: string | null;
  storageState?: unknown;
}

export interface AccountRepositoryOptions {
  dataRoot: string;
  now?: () => Date;
  randomId?: () => string;
  removeTree?: (target: string) => void;
  replaceFile?: (target: string, content: string, mode: number) => void;
}

const PROVIDERS: Provider[] = ["claude", "codex", "cursor"];

/** Own Gauge's provider-scoped v3 account tree. */
export class AccountRepository {
  readonly #dataRoot: string;
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #removeTree: (target: string) => void;
  readonly #replaceFile: (
    target: string,
    content: string,
    mode: number,
  ) => void;

  constructor(options: AccountRepositoryOptions) {
    this.#dataRoot = path.resolve(options.dataRoot);
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
    this.#removeTree =
      options.removeTree ??
      ((target) => fs.rmSync(target, { recursive: true }));
    this.#replaceFile =
      options.replaceFile ??
      ((target, content, mode) => atomicReplace(target, content, { mode }));
  }

  get accountsRoot(): string {
    return path.join(this.#dataRoot, "accounts", "v3");
  }

  pathsFor(rawId: AccountId): AccountPaths {
    const id = AccountIdSchema.parse(rawId);
    const directory = path.join(this.accountsRoot, id.provider, id.name);
    return {
      config: path.join(directory, "config.json"),
      directory,
      profile: path.join(directory, "profile"),
      storageState: path.join(directory, "storage-state.json"),
    };
  }

  add(rawId: AccountId, write: AccountWrite = {}): AccountRecord {
    const id = AccountIdSchema.parse(rawId);
    const paths = this.pathsFor(id);
    const storageState = parseOptionalStorageState(write.storageState);
    this.#ensureProviderDirectory(id.provider);
    if (readStatus(paths.directory)) {
      throw new CLIError(
        `Account "${id.provider}:${id.name}" already exists.`,
        { code: "ACCOUNT_EXISTS", exitCode: 2 },
      );
    }

    const stage = path.join(
      path.dirname(paths.directory),
      `.${id.name}.stage-${this.#randomId()}`,
    );
    if (readStatus(stage)) {
      throw new CLIError("Account staging path already exists.", {
        code: "ACCOUNT_STAGE_CONFLICT",
      });
    }

    fs.mkdirSync(stage, { mode: 0o700 });
    try {
      const config = buildConfig(
        id,
        write,
        write.addedAt === undefined ? this.#now() : new Date(write.addedAt),
      );
      writeStagedFile(
        path.join(stage, "config.json"),
        `${JSON.stringify(config, null, 2)}\n`,
      );
      if (storageState) {
        writeStagedFile(
          path.join(stage, "storage-state.json"),
          `${JSON.stringify(storageState, null, 2)}\n`,
        );
      }
      if (write.profileSource !== undefined) {
        const profileStatus = fs.lstatSync(write.profileSource);
        if (profileStatus.isSymbolicLink() || !profileStatus.isDirectory()) {
          throw unsafeAccountPath(write.profileSource);
        }
        fs.cpSync(write.profileSource, path.join(stage, "profile"), {
          recursive: true,
          filter: (source) => isMigratableProfileEntry(fs.lstatSync(source)),
        });
      }
      flushDirectory(stage);
      fs.renameSync(stage, paths.directory);
      flushDirectory(path.dirname(paths.directory));
    } catch (error) {
      removeIfExists(stage);
      throw error;
    }

    return this.get(id);
  }

  refresh(rawId: AccountId, write: AccountWrite): AccountRecord {
    const id = AccountIdSchema.parse(rawId);
    const current = this.get(id);
    const storageState = parseOptionalStorageState(write.storageState);
    const nextConfig = buildConfig(
      id,
      {
        codexHome: write.codexHome ?? current.config.codexHome,
        renewsAt:
          write.renewsAt === undefined
            ? current.config.renewsAt
            : write.renewsAt,
      },
      new Date(current.config.addedAt),
    );

    const replacements = [
      ...(storageState
        ? [
            {
              content: `${JSON.stringify(storageState, null, 2)}\n`,
              target: current.paths.storageState,
            },
          ]
        : []),
      {
        content: `${JSON.stringify(nextConfig, null, 2)}\n`,
        target: current.paths.config,
      },
    ];
    const previous = replacements.map(({ target }) => ({
      content: fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null,
      target,
    }));
    let committed = 0;
    try {
      for (const replacement of replacements) {
        this.#replaceFile(replacement.target, replacement.content, 0o600);
        committed += 1;
      }
    } catch (error) {
      for (const replacement of previous.slice(0, committed).reverse()) {
        if (replacement.content === null) {
          removeIfExists(replacement.target);
        } else {
          atomicReplace(replacement.target, replacement.content, {
            mode: 0o600,
          });
        }
      }
      throw error;
    }
    return this.get(id);
  }

  replaceStorageState(rawId: AccountId, value: unknown): AccountRecord {
    const current = this.get(rawId);
    const storageState = parseStorageStateObject(value);
    this.#replaceFile(
      current.paths.storageState,
      `${JSON.stringify(storageState, null, 2)}\n`,
      0o600,
    );
    return this.get(rawId);
  }

  remove(rawId: AccountId): boolean {
    const id = AccountIdSchema.parse(rawId);
    const paths = this.pathsFor(id);
    const status = readStatus(paths.directory);
    if (!status) {
      return false;
    }
    assertDirectoryNotSymlink(status, paths.directory);
    const tombstone = path.join(
      path.dirname(paths.directory),
      `.${id.name}.tombstone-${this.#randomId()}`,
    );
    fs.renameSync(paths.directory, tombstone);
    flushDirectory(path.dirname(paths.directory));
    this.#removeTree(tombstone);
    return true;
  }

  get(rawId: AccountId): AccountRecord {
    const id = AccountIdSchema.parse(rawId);
    const paths = this.pathsFor(id);
    const status = readStatus(paths.directory);
    if (!status) {
      throw new CLIError(`Account "${id.provider}:${id.name}" was not found.`, {
        code: "ACCOUNT_NOT_FOUND",
        exitCode: 2,
      });
    }
    assertDirectoryNotSymlink(status, paths.directory);
    const configStatus = fs.lstatSync(paths.config);
    if (!configStatus.isFile() || configStatus.isSymbolicLink()) {
      throw unsafeAccountPath(paths.config);
    }
    const config = AccountConfigV3Schema.parse(
      JSON.parse(fs.readFileSync(paths.config, "utf8")) as unknown,
    );
    if (config.provider !== id.provider || config.name !== id.name) {
      throw new CLIError("Account config identity does not match its path.", {
        code: "ACCOUNT_IDENTITY_MISMATCH",
      });
    }
    return {
      config,
      hasProfile: isDirectory(paths.profile),
      hasStorageState: isRegularFile(paths.storageState),
      id,
      paths,
    };
  }

  list(): AccountRecord[] {
    const dataRootStatus = readStatus(this.#dataRoot);
    if (!dataRootStatus) {
      return [];
    }
    assertDirectoryNotSymlink(dataRootStatus, this.#dataRoot);
    const accountsRootStatus = readStatus(this.accountsRoot);
    if (!accountsRootStatus) {
      return [];
    }
    assertDirectoryNotSymlink(accountsRootStatus, this.accountsRoot);
    const records: AccountRecord[] = [];
    for (const provider of PROVIDERS) {
      const providerPath = path.join(this.accountsRoot, provider);
      const providerStatus = readStatus(providerPath);
      if (!providerStatus) {
        continue;
      }
      assertDirectoryNotSymlink(providerStatus, providerPath);
      for (const name of fs.readdirSync(providerPath).sort()) {
        if (name.startsWith(".")) {
          continue;
        }
        records.push(this.get({ provider, name }));
      }
    }
    return records;
  }

  #ensureProviderDirectory(provider: Provider): void {
    this.#ensureAccountsRoot();
    ensureOwnedDirectory(path.join(this.accountsRoot, provider));
  }

  #ensureAccountsRoot(): void {
    ensureOwnedDirectory(this.#dataRoot);
    ensureOwnedDirectory(path.join(this.#dataRoot, "accounts"));
    ensureOwnedDirectory(this.accountsRoot);
  }
}

function buildConfig(
  id: AccountId,
  write: AccountWrite,
  addedAt: Date,
): AccountConfigV3 {
  return AccountConfigV3Schema.parse({
    schema_version: 3,
    provider: id.provider,
    name: id.name,
    addedAt: addedAt.toISOString(),
    ...(write.codexHome !== undefined && { codexHome: write.codexHome }),
    ...(write.renewsAt !== undefined &&
      write.renewsAt !== null && { renewsAt: write.renewsAt }),
  });
}

function parseOptionalStorageState(
  value: unknown,
): PlaywrightStorageState | undefined {
  return value === undefined ? undefined : parseStorageStateObject(value);
}

function ensureOwnedDirectory(directory: string): void {
  const status = readStatus(directory);
  if (!status) {
    fs.mkdirSync(directory, { mode: 0o700 });
    return;
  }
  assertDirectoryNotSymlink(status, directory);
  fs.chmodSync(directory, 0o700);
}

function assertDirectoryNotSymlink(status: fs.Stats, target: string): void {
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw unsafeAccountPath(target);
  }
}

/**
 * Whether a profile entry is real data worth migrating/copying.
 *
 * A live Chrome/Chromium profile is littered with transient singleton
 * artifacts — `SingletonLock`, `SingletonSocket`, `SingletonCookie`,
 * `RunningChromeVersion` — that are symlinks or sockets, not profile data, and
 * that Chrome recreates on its next launch. We never copy or fingerprint them:
 * copying a socket throws and copying a symlink out of the profile is exactly
 * the escape we want to avoid. Only regular files and directories migrate.
 */
export function isMigratableProfileEntry(status: fs.Stats): boolean {
  return status.isFile() || status.isDirectory();
}

function unsafeAccountPath(target: string): CLIError {
  return new CLIError(
    "Gauge account data paths must be real directories and regular files.",
    {
      code: "UNSAFE_ACCOUNT_PATH",
      details: { target },
    },
  );
}

function writeStagedFile(target: string, content: string): void {
  const descriptor = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function flushDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeIfExists(target: string): void {
  try {
    fs.rmSync(target, { recursive: true });
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
}

function readStatus(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function isRegularFile(target: string): boolean {
  const status = readStatus(target);
  return Boolean(status?.isFile() && !status.isSymbolicLink());
}

function isDirectory(target: string): boolean {
  const status = readStatus(target);
  return Boolean(status?.isDirectory() && !status.isSymbolicLink());
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
