import fs from "node:fs";
import {
  type AccountConfigV3,
  type AccountId,
  encodeAccountId,
  type Provider,
} from "./domain/account.js";
import { getDataDir } from "./paths.js";
import {
  type AccountPaths,
  AccountRepository,
} from "./persistence/account-repository.js";
import type { PlaywrightStorageState } from "./storage-state.js";
import {
  parseStorageStateJsonValue,
  readStorageStateFile,
} from "./storage-state.js";

export interface AccountDetails extends AccountConfigV3 {
  accountPath: string;
  authKey: string;
  hasProfileDir: boolean;
  hasStorageState: boolean;
  profileDir: string;
  storagePath: string;
}

function accountRepository(): AccountRepository {
  return new AccountRepository({ dataRoot: getDataDir() });
}

function accountId(name: string, provider: Provider = "claude"): AccountId {
  return { name, provider };
}

/** Return all configured v3 accounts in deterministic provider/name order. */
export function listAccounts(): AccountConfigV3[] {
  return accountRepository()
    .list()
    .map((record) => record.config);
}

/** Check whether a provider-qualified account exists. */
export function accountExists(name: string, provider?: Provider): boolean {
  return fs.existsSync(
    accountRepository().pathsFor(accountId(name, provider)).directory,
  );
}

/** Add or update account configuration through the v3 repository. */
export function saveAccount(
  name: string,
  options: {
    codexHome?: string;
    provider?: Provider;
    renewsAt?: string | null;
  } = {},
): void {
  const repository = accountRepository();
  const id = accountId(name, options.provider);
  const write = {
    ...(options.codexHome !== undefined && { codexHome: options.codexHome }),
    ...(options.renewsAt !== undefined && { renewsAt: options.renewsAt }),
  };
  if (fs.existsSync(repository.pathsFor(id).directory)) {
    repository.refresh(id, write);
  } else {
    repository.add(id, write);
  }
}

/** Atomically expose a complete configured account. */
export function createAccount(
  name: string,
  options: {
    codexHome?: string;
    provider?: Provider;
    profileSource?: string;
    renewsAt?: string | null;
    storageState?: PlaywrightStorageState;
  } = {},
): void {
  accountRepository().add(accountId(name, options.provider), {
    codexHome: options.codexHome,
    renewsAt: options.renewsAt,
    profileSource: options.profileSource,
    storageState: options.storageState,
  });
}

/** Atomically replace validated account config and credential files. */
export function refreshAccount(
  name: string,
  options: {
    codexHome?: string;
    provider?: Provider;
    renewsAt?: string | null;
    storageState?: PlaywrightStorageState;
  },
): void {
  accountRepository().refresh(accountId(name, options.provider), {
    codexHome: options.codexHome,
    renewsAt: options.renewsAt,
    storageState: options.storageState,
  });
}

/** Import validated Playwright storage state into an existing account. */
export function importStorageState(
  name: string,
  options: { json?: string; filePath?: string },
  provider?: Provider,
): string {
  const repository = accountRepository();
  const id = accountId(name, provider);
  const normalized =
    options.json === undefined
      ? readStorageStateFile(options.filePath ?? "")
      : JSON.stringify(parseStorageStateJsonValue(options.json));
  repository.refresh(id, {
    storageState: JSON.parse(normalized) as unknown,
  });
  return repository.pathsFor(id).storageState;
}

/** Return all paths owned by a provider-qualified account. */
export function getAccountArtifacts(
  name: string,
  provider?: Provider,
): {
  accountPath: string;
  authKey: string;
  profileDir: string;
  storagePath: string;
} {
  const id = accountId(name, provider);
  const paths = accountRepository().pathsFor(id);
  return mapPaths(id, paths);
}

/** List configured accounts with local artifact readiness. */
export function listAccountDetails(provider?: Provider): AccountDetails[] {
  return accountRepository()
    .list()
    .filter(
      (record) => provider === undefined || record.id.provider === provider,
    )
    .map((record) => ({
      ...record.config,
      ...mapPaths(record.id, record.paths),
      hasProfileDir: record.hasProfile,
      hasStorageState: record.hasStorageState,
    }));
}

/** Tombstone and remove a provider-qualified account. */
export function removeAccount(name: string, provider?: Provider): boolean {
  return accountRepository().remove(accountId(name, provider));
}

function mapPaths(
  id: AccountId,
  paths: AccountPaths,
): {
  accountPath: string;
  authKey: string;
  profileDir: string;
  storagePath: string;
} {
  return {
    accountPath: paths.config,
    authKey: encodeAccountId(id),
    profileDir: paths.profile,
    storagePath: paths.storageState,
  };
}
