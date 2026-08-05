import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Point a tool on this machine at a different account gauge already holds.
 *
 * Distinct from `refresh`, which renews the credentials of one account. This
 * changes *which* account a tool is signed into, and it only works where gauge
 * already has the material to do it with: the Codex CLI keeps its whole session
 * in a `CODEX_HOME` directory, and gauge has been keeping one of those per
 * account since accounts were added. Switching is therefore a file move between
 * two directories gauge owns — no browser, no login, no token minted.
 *
 * The Claude Code CLI is deliberately absent. Its session lives in the macOS
 * keychain under `Claude Code-credentials`, and gauge stores browser cookies for
 * reading usage rather than the CLI's own OAuth tokens — so there is nothing to
 * restore, and inventing a switch that silently signed somebody out would be
 * worse than not having one.
 */
export interface CodexSwitchTarget {
  /** The configured account name, as it appears on the dashboard. */
  name: string;
  /** The home gauge keeps for it. */
  home: string;
}

/** The accounts a Codex switch could move to, newest credentials first. */
export function codexSwitchTargets(dataDir: string): CodexSwitchTarget[] {
  const root = path.join(dataDir, "codex-homes");
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
}

export interface CodexSwitchResult {
  backedUp: string | null;
  name: string;
  target: string;
}

/**
 * Make `name` the account the Codex CLI uses by default.
 *
 * The active session is whichever `auth.json` sits in `CODEX_HOME` — `~/.codex`
 * unless the environment says otherwise — so the switch copies the account's
 * stored credentials over it.
 *
 * Two safeguards, because this replaces a working login. The candidate is parsed
 * before anything is written, so a truncated or half-written file fails without
 * touching the live session; and whatever was there is copied aside first, so a
 * switch is always reversible even if the account switched away from turns out
 * to be the only one signed in.
 */
export function switchCodexLogin(
  name: string,
  dataDir: string,
  homeDir: string = os.homedir(),
): CodexSwitchResult {
  const target = codexSwitchTargets(dataDir).find(
    (candidate) => candidate.name === name,
  );
  if (!target) {
    throw new Error(`No stored Codex home for account "${name}".`);
  }

  const source = path.join(target.home, "auth.json");
  const contents = fs.readFileSync(source, "utf8");
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
}
