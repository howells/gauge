import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const codexHomesRoot = (dataDir: string): string =>
  path.join(dataDir, "codex-homes");

export const managedCodexHome = (dataDir: string, name: string): string =>
  path.join(codexHomesRoot(dataDir), name);

export const codexHomeHasLogin = (home: string): boolean =>
  fs.existsSync(path.join(home, "auth.json"));

export const createCodexHome = (home: string): void => {
  fs.mkdirSync(home, { mode: 0o700, recursive: true });
};

export const resolveCodexHomeInput = (
  raw: string,
  homeDir: string = os.homedir()
): string => {
  const expanded =
    raw === "~"
      ? homeDir
      : raw.startsWith("~/")
        ? path.join(homeDir, raw.slice(2))
        : raw;
  return path.resolve(expanded);
};
