import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SERVICE = "Claude Code-credentials";

export interface ClaudeSession {
  /** The keychain payload, verbatim. */
  credentials: string;
  /** The keychain item's account attribute, so a restore rebuilds it exactly. */
  keychainAccount: string;
  /** `oauthAccount` from ~/.claude.json — the half that names the account. */
  profile: Record<string, unknown>;
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const keychainAccount = (): string | null => {
  const found = spawnSync(
    "security",
    ["find-generic-password", "-s", SERVICE],
    {
      encoding: "utf-8",
    }
  );
  if (found.status !== 0) {
    return null;
  }
  return /"acct"<blob>="([^"]*)"/u.exec(found.stdout)?.[1] ?? null;
};

export const readClaudeSession = (
  homeDir: string = os.homedir()
): ClaudeSession | null => {
  if (process.platform !== "darwin") {
    return null;
  }
  const account = keychainAccount();
  if (!account) {
    return null;
  }
  const secret = spawnSync(
    "security",
    ["find-generic-password", "-s", SERVICE, "-w"],
    { encoding: "utf-8" }
  );
  if (secret.status !== 0) {
    return null;
  }
  const credentials = secret.stdout.trim();
  if (credentials === "") {
    return null;
  }
  const profile = record(
    record(readJson(path.join(homeDir, ".claude.json")))?.oauthAccount
  );
  if (!profile) {
    return null;
  }
  return { credentials, keychainAccount: account, profile };
};

const sessionFile = (dataDir: string, name: string): string =>
  path.join(dataDir, "accounts", "v3", "claude", name, "cli-session.json");

export const capturedClaudeSessions = (dataDir: string): string[] => {
  const root = path.join(dataDir, "accounts", "v3", "claude");
  try {
    return fs
      .readdirSync(root)
      .filter((name) => fs.existsSync(sessionFile(dataDir, name)))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};

export const captureClaudeSession = (
  dataDir: string,
  name: string,
  session: ClaudeSession
): void => {
  const file = sessionFile(dataDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
};

export interface ClaudeSwitchResult {
  backedUp: string | null;
  name: string;
}

export interface LastClaudeSwitch {
  /** The address of the account the machine was switched away from. */
  previousEmail: string | null;
  /** Its account UUID, for joining against configured account names. */
  previousUuid: string | null;
  /** When the switch happened. */
  switchedAt: Date;
}

const switchLog = (dataDir: string): string =>
  path.join(dataDir, "backups", "claude-switch-log.json");

const SWITCH_LOG_LIMIT = 50;

const appendSwitchLog = (dataDir: string, entry: LastClaudeSwitch): void => {
  const file = switchLog(dataDir);
  let previous: unknown = null;
  try {
    previous = readJson(file);
  } catch {
    previous = null;
  }
  const list = Array.isArray(previous)
    ? previous.slice(-(SWITCH_LOG_LIMIT - 1))
    : [];
  list.push({
    previousEmail: entry.previousEmail,
    previousUuid: entry.previousUuid,
    switchedAt: entry.switchedAt.toISOString(),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
};

export const claudeSwitchesWithin = (
  dataDir: string,
  now: Date,
  maxAgeMs: number
): LastClaudeSwitch[] => {
  const raw = readJson(switchLog(dataDir));
  if (!Array.isArray(raw)) {
    return [];
  }
  const cutoff = now.getTime() - maxAgeMs;
  const byIdentity = new Map<string, LastClaudeSwitch>();
  for (const item of raw) {
    const entry = record(item);
    const email =
      typeof entry?.previousEmail === "string" ? entry.previousEmail : null;
    const uuid =
      typeof entry?.previousUuid === "string" ? entry.previousUuid : null;
    const iso = typeof entry?.switchedAt === "string" ? entry.switchedAt : null;
    if (!iso) {
      continue;
    }
    const switchedAt = new Date(iso);
    const time = switchedAt.getTime();
    if (!Number.isFinite(time) || time < cutoff || time > now.getTime()) {
      continue;
    }
    byIdentity.set(`${uuid ?? ""}|${email ?? ""}`, {
      previousEmail: email,
      previousUuid: uuid,
      switchedAt,
    });
  }
  return [...byIdentity.values()].sort(
    (left, right) => left.switchedAt.getTime() - right.switchedAt.getTime()
  );
};

export const switchClaudeSession = (
  name: string,
  dataDir: string,
  homeDir: string = os.homedir()
): ClaudeSwitchResult => {
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
    backedUp = path.join(dataDir, "backups", "claude-session.previous.json");
    fs.mkdirSync(path.dirname(backedUp), { recursive: true });
    fs.writeFileSync(backedUp, `${JSON.stringify(current, null, 2)}\n`, {
      mode: 0o600,
    });
    const currentProfile = record(current.profile);
    const email =
      typeof currentProfile?.emailAddress === "string"
        ? currentProfile.emailAddress
        : null;
    const uuid =
      typeof currentProfile?.accountUuid === "string"
        ? currentProfile.accountUuid
        : null;
    appendSwitchLog(dataDir, {
      previousEmail: email,
      previousUuid: uuid,
      switchedAt: new Date(),
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
    { encoding: "utf-8" }
  );
  if (written.status !== 0) {
    throw new Error(
      `Keychain refused the session: ${(written.stderr || "unknown error").trim()}`
    );
  }

  const configFile = path.join(homeDir, ".claude.json");
  const config = record(readJson(configFile)) ?? {};
  config.oauthAccount = profile;
  fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });

  return { backedUp, name };
};

export const claudeAccessTokenFor = (
  name: string,
  dataDir: string,
  liveAccountName?: string
): string | null => {
  const fromSession = (session: ClaudeSession | null): string | null => {
    if (!session) {
      return null;
    }
    try {
      const parsed = record(JSON.parse(session.credentials));
      const oauth = record(parsed?.claudeAiOauth);
      const token = oauth?.accessToken;
      return typeof token === "string" && token !== "" ? token : null;
    } catch {
      return null;
    }
  };
  if (liveAccountName === name) {
    const live = fromSession(readClaudeSession());
    if (live) {
      return live;
    }
  }
  return fromSession(
    record(readJson(sessionFile(dataDir, name))) as ClaudeSession | null
  );
};
