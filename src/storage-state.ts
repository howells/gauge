import fs from "node:fs";

import { PlaywrightStorageStateSchema } from "./domain/storage-state-schema.js";
import type { PlaywrightStorageState } from "./domain/storage-state-schema.js";
import { CLIError } from "./security.js";

export type { PlaywrightStorageState };

const invalidStorageState = (error: unknown): CLIError =>
  new CLIError("Storage state payload is not valid Playwright state.", {
    code: "INVALID_STORAGE_STATE",
    details: error instanceof Error ? error.message : String(error),
    exitCode: 2,
  });

export const parseStorageStateObject = (
  storageState: unknown
): PlaywrightStorageState => {
  try {
    return PlaywrightStorageStateSchema.parse(storageState);
  } catch (error) {
    throw invalidStorageState(error);
  }
};

export const parseStorageStateJsonValue = (
  storageStateJson: string
): PlaywrightStorageState => {
  try {
    return parseStorageStateObject(JSON.parse(storageStateJson) as unknown);
  } catch (error) {
    if (error instanceof CLIError) {
      throw error;
    }
    throw invalidStorageState(error);
  }
};

const parseStorageStateJson = (storageStateJson: string): string =>
  JSON.stringify(parseStorageStateJsonValue(storageStateJson), null, 2);

export const readStorageStateFile = (filePath: string): string => {
  try {
    return parseStorageStateJson(fs.readFileSync(filePath, "utf-8"));
  } catch (error) {
    if (error instanceof CLIError) {
      throw error;
    }

    throw new CLIError("Unable to read the requested storage state file.", {
      code: "INVALID_STORAGE_STATE",
      details: {
        reason: "The file is missing, unreadable, or not a regular JSON file.",
      },
      exitCode: 2,
    });
  }
};
