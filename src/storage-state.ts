import fs from "node:fs";
import {
  type PlaywrightStorageState,
  PlaywrightStorageStateSchema,
} from "./domain/storage-state-schema.js";
import { CLIError } from "./security.js";

export type { PlaywrightStorageState };

/** Validate a parsed value as a strict Playwright storage state. */
export function parseStorageStateObject(
  storageState: unknown,
): PlaywrightStorageState {
  try {
    return PlaywrightStorageStateSchema.parse(storageState);
  } catch (error) {
    throw invalidStorageState(error);
  }
}

/** Parse JSON text and validate it as a strict Playwright storage state. */
export function parseStorageStateJsonValue(
  storageStateJson: string,
): PlaywrightStorageState {
  try {
    return parseStorageStateObject(JSON.parse(storageStateJson) as unknown);
  } catch (error) {
    if (error instanceof CLIError) throw error;
    throw invalidStorageState(error);
  }
}

/** Parse and normalize a raw JSON string as Playwright storage state. */
function parseStorageStateJson(storageStateJson: string): string {
  return JSON.stringify(parseStorageStateJsonValue(storageStateJson), null, 2);
}

/** Read and validate a Playwright storage-state JSON file from disk. */
export function readStorageStateFile(filePath: string): string {
  try {
    return parseStorageStateJson(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error instanceof CLIError) {
      throw error;
    }

    throw new CLIError("Unable to read the requested storage state file.", {
      code: "INVALID_STORAGE_STATE",
      exitCode: 2,
      details: {
        reason: "The file is missing, unreadable, or not a regular JSON file.",
      },
    });
  }
}

function invalidStorageState(error: unknown): CLIError {
  return new CLIError("Storage state payload is not valid Playwright state.", {
    code: "INVALID_STORAGE_STATE",
    exitCode: 2,
    details: error instanceof Error ? error.message : String(error),
  });
}
