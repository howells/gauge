import fs from "node:fs";

import { encodeAccountId } from "./domain/account.js";
import type { AccountConfigV3, AccountId, Provider } from "./domain/account.js";
import { getDataDir } from "./paths.js";
import { AccountRepository } from "./persistence/account-repository.js";
import type { AccountPaths } from "./persistence/account-repository.js";
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

const accountRepository = (): AccountRepository =>
  new AccountRepository({ dataRoot: getDataDir() });

const accountId = (name: string, provider: Provider = "claude"): AccountId => ({
  name,
  provider,
});

export const listAccounts = (): AccountConfigV3[] =>
  accountRepository()
    .list()
    .map((record) => record.config);

export const accountExists = (name: string, provider?: Provider): boolean =>
  fs.existsSync(
    accountRepository().pathsFor(accountId(name, provider)).directory
  );

export const saveAccount = (
  name: string,
  options: {
    codexHome?: string;
    provider?: Provider;
    renewsAt?: string | null;
  } = {}
): void => {
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
};

export const createAccount = (
  name: string,
  options: {
    codexHome?: string;
    provider?: Provider;
    profileSource?: string;
    renewsAt?: string | null;
    storageState?: PlaywrightStorageState;
  } = {}
): void => {
  accountRepository().add(accountId(name, options.provider), {
    codexHome: options.codexHome,
    profileSource: options.profileSource,
    renewsAt: options.renewsAt,
    storageState: options.storageState,
  });
};

export const refreshAccount = (
  name: string,
  options: {
    codexHome?: string;
    provider?: Provider;
    renewsAt?: string | null;
    storageState?: PlaywrightStorageState;
  }
): void => {
  accountRepository().refresh(accountId(name, options.provider), {
    codexHome: options.codexHome,
    renewsAt: options.renewsAt,
    storageState: options.storageState,
  });
};

export const importStorageState = (
  name: string,
  options: { json?: string; filePath?: string },
  provider?: Provider
): string => {
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
};

export const removeAccount = (name: string, provider?: Provider): boolean =>
  accountRepository().remove(accountId(name, provider));

const mapPaths = (
  id: AccountId,
  paths: AccountPaths
): {
  accountPath: string;
  authKey: string;
  profileDir: string;
  storagePath: string;
} => ({
  accountPath: paths.config,
  authKey: encodeAccountId(id),
  profileDir: paths.profile,
  storagePath: paths.storageState,
});

export const getAccountArtifacts = (
  name: string,
  provider?: Provider
): {
  accountPath: string;
  authKey: string;
  profileDir: string;
  storagePath: string;
} => {
  const id = accountId(name, provider);
  const paths = accountRepository().pathsFor(id);
  return mapPaths(id, paths);
};

export const listAccountDetails = (provider?: Provider): AccountDetails[] =>
  accountRepository()
    .list()
    .filter(
      (record) => provider === undefined || record.id.provider === provider
    )
    .map((record) => ({
      ...record.config,
      ...mapPaths(record.id, record.paths),
      hasProfileDir: record.hasProfile,
      hasStorageState: record.hasStorageState,
    }));
