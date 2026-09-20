import os from "node:os";
import path from "node:path";

import { assertSafeIdentifier } from "./security.js";

export const getDataDir = (): string => path.join(os.homedir(), ".gauge");

export const assertSafeName = (name: string): void => {
  assertSafeIdentifier(name, "Account name");
};

export const getAccountPath = (name: string): string => {
  assertSafeName(name);
  return path.join(getDataDir(), `${name}.json`);
};

export const getStorageStatePath = (name: string): string => {
  assertSafeName(name);
  return path.join(getDataDir(), `${name}-storage.json`);
};

export const getProfileDir = (name: string): string => {
  assertSafeName(name);
  return path.join(getDataDir(), `profile-${name}`);
};
