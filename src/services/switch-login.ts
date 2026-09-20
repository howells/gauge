import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { codexHomesRoot } from "./codex-home.js";

export interface CodexSwitchTarget {
  /** The configured account name, as it appears on the dashboard. */
  name: string;
  /** The home gauge keeps for it. */
  home: string;
}

export const codexSwitchTargets = (dataDir: string): CodexSwitchTarget[] => {
  const root = codexHomesRoot(dataDir);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  return names
    .map((name) => ({ home: path.join(root, name), name }))
    .filter((target) => fs.existsSync(path.join(target.home, "auth.json")))
    .sort((left, right) => left.name.localeCompare(right.name));
};

export interface CodexSwitchResult {
  backedUp: string | null;
  name: string;
  target: string;
}

export const switchCodexLogin = (
  name: string,
  dataDir: string,
  homeDir: string = os.homedir()
): CodexSwitchResult => {
  const target = codexSwitchTargets(dataDir).find(
    (candidate) => candidate.name === name
  );
  if (!target) {
    throw new Error(`No stored Codex home for account "${name}".`);
  }

  const source = path.join(target.home, "auth.json");
  const contents = fs.readFileSync(source, "utf-8");
  // Parsed, not merely read: writing an unparseable auth.json over a working one
  // trades a wrong account for no account.
  JSON.parse(contents);

  const activeHome = process.env.CODEX_HOME ?? path.join(homeDir, ".codex");
  const destination = path.join(activeHome, "auth.json");
  fs.mkdirSync(activeHome, { recursive: true });

  let backedUp: string | null = null;
  if (fs.existsSync(destination)) {
    backedUp = path.join(activeHome, "auth.json.gauge-previous");
    fs.copyFileSync(destination, backedUp);
  }
  fs.writeFileSync(destination, contents, { mode: 0o600 });

  return { backedUp, name, target: destination };
};
