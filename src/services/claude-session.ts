import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * The Claude Code CLI's signed-in session, and moving it between accounts.
 *
 * Unlike Codex — whose whole session is a directory gauge already keeps one of
 * per account — Claude Code splits its login in two: the tokens live in the
 * macOS keychain under `Claude Code-credentials`, and the profile that names the
 * account lives in `~/.claude.json` as `oauthAccount`. Neither is anything gauge
 * holds from adding an account, because what it stores for Claude is browser
 * state for reading usage, not the CLI's own OAuth.
 *
 * So switching has to be earned rather than assumed: gauge captures whatever
 * session it finds signed in, and can afterwards put any captured session back.
 * Until an account has been seen once there is nothing to restore, and the view
 * says so rather than offering a switch that would sign somebody out.
 */
const SERVICE = "Claude Code-credentials";

export interface ClaudeSession {
  /** The keychain payload, verbatim. */
  credentials: string;
  /** The keychain item's account attribute, so a restore rebuilds it exactly. */
  keychainAccount: string;
  /** `oauthAccount` from ~/.claude.json — the half that names the account. */
  profile: Record<string, unknown>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The keychain item's account attribute, needed to rewrite it in place. */
function keychainAccount(): string | null {
  const found = spawnSync(
    "security",
    ["find-generic-password", "-s", SERVICE],
    {
      encoding: "utf8",
    },
  );
  if (found.status !== 0) return null;
  return /"acct"<blob>="([^"]*)"/u.exec(found.stdout)?.[1] ?? null;
}

/** The session currently signed in on this machine, if there is one. */
export function readClaudeSession(
  homeDir: string = os.homedir(),
): ClaudeSession | null {
  if (process.platform !== "darwin") return null;
  const account = keychainAccount();
  if (!account) return null;
  const secret = spawnSync(
    "security",
    ["find-generic-password", "-s", SERVICE, "-w"],
    { encoding: "utf8" },
  );
  if (secret.status !== 0) return null;
  const credentials = secret.stdout.trim();
  if (credentials === "") return null;
  const profile = record(
    record(readJson(path.join(homeDir, ".claude.json")))?.oauthAccount,
  );
  if (!profile) return null;
  return { credentials, keychainAccount: account, profile };
}

function sessionFile(dataDir: string, name: string): string {
  return path.join(
    dataDir,
    "accounts",
    "v3",
    "claude",
    name,
    "cli-session.json",
  );
}

/** Every configured account gauge has captured a CLI session for. */
export function capturedClaudeSessions(dataDir: string): string[] {
  const root = path.join(dataDir, "accounts", "v3", "claude");
  try {
    return fs
      .readdirSync(root)
      .filter((name) => fs.existsSync(sessionFile(dataDir, name)))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

/**
 * Keep the signed-in session under the account it belongs to.
 *
 * Called whenever the dashboard is drawn, so that simply using the tools builds
 * the set of accounts that can later be switched to — no capture step for anyone
 * to remember. Stored `0600` beside the browser state gauge already keeps for
 * the same account: this is the same class of material, held the same way.
 */
export function captureClaudeSession(
  dataDir: string,
  name: string,
  session: ClaudeSession,
): void {
  const file = sessionFile(dataDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
}

export interface ClaudeSwitchResult {
  backedUp: string | null;
  name: string;
}

/**
 * Sign the Claude Code CLI in as a previously captured account.
 *
 * Both halves move together or the CLI ends up authenticated as one account
 * while displaying another. The keychain payload is parsed before anything is
 * written, and the session being replaced is captured to a backup file first —
 * a switch that cannot be undone would be a worse trade than a stale token.
 */
export function switchClaudeSession(
  name: string,
  dataDir: string,
  homeDir: string = os.homedir(),
): ClaudeSwitchResult {
  const stored = record(readJson(sessionFile(dataDir, name)));
  const credentials = stored?.credentials;
  const profile = record(stored?.profile);
  if (typeof credentials !== "string" || !profile) {
    throw new Error(`No captured Claude Code session for "${name}".`);
  }
  // Parsed, not merely copied: writing an unreadable blob into the keychain
  // trades a wrong account for no account.
  JSON.parse(credentials);

  let backedUp: string | null = null;
  const current = readClaudeSession(homeDir);
  if (current) {
    backedUp = path.join(dataDir, "claude-session.previous.json");
    fs.mkdirSync(path.dirname(backedUp), { recursive: true });
    fs.writeFileSync(backedUp, `${JSON.stringify(current, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  const account =
    typeof stored?.keychainAccount === "string" && stored.keychainAccount !== ""
      ? stored.keychainAccount
      : (current?.keychainAccount ?? os.userInfo().username);
  const written = spawnSync(
    "security",
    [
      "add-generic-password",
      "-U",
      "-s",
      SERVICE,
      "-a",
      account,
      "-w",
      credentials,
    ],
    { encoding: "utf8" },
  );
  if (written.status !== 0) {
    throw new Error(
      `Keychain refused the session: ${(written.stderr || "unknown error").trim()}`,
    );
  }

  const configFile = path.join(homeDir, ".claude.json");
  const config = record(readJson(configFile)) ?? {};
  config.oauthAccount = profile;
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  return { backedUp, name };
}
