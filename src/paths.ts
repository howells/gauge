import os from "node:os";
import path from "node:path";
import { assertSafeIdentifier } from "./security.js";

/** Return the ~/.gauge data directory path. */
export function getDataDir(): string {
  return path.join(os.homedir(), ".gauge");
}

/** Validate that an account name is safe for use as a filename. */
export function assertSafeName(name: string): void {
  assertSafeIdentifier(name, "Account name");
}

/** Return the path to an account's config JSON file. */
export function getAccountPath(name: string): string {
  assertSafeName(name);
  return path.join(getDataDir(), `${name}.json`);
}

/** Return the path to an account's Playwright storage-state file. */
export function getStorageStatePath(name: string): string {
  assertSafeName(name);
  return path.join(getDataDir(), `${name}-storage.json`);
}

/** Return the path to an account's Chrome profile directory. */
export function getProfileDir(name: string): string {
  assertSafeName(name);
  return path.join(getDataDir(), `profile-${name}`);
}
