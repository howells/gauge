import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export interface MachineLogin {
  /** Where the identity was read from, for a reader who wants to check. */
  source: string;
  /** The signed-in address, when the surface records one in the clear. */
  email: string | null;
  /** The account identifier, when that is all the surface records. */
  accountId: string | null;
  /** The tool, as a person would name it. */
  surface: "Claude Code" | "Claude app" | "Codex";
}

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const emailFromJwt = (token: string | null): string | null => {
  if (!token || token.split(".").length !== 3) {
    return null;
  }
  try {
    const [, payload] = token.split(".");
    const padded = (payload ?? "").padEnd(
      Math.ceil((payload ?? "").length / 4) * 4,
      "="
    );
    const claims = record(
      JSON.parse(Buffer.from(padded, "base64url").toString("utf-8"))
    );
    if (!claims) {
      return null;
    }
    const profile = record(claims["https://api.openai.com/profile"]);
    return text(claims.email) ?? text(profile?.email);
  } catch {
    return null;
  }
};

const claudeCodeLogin = (home: string): MachineLogin | null => {
  const file = path.join(home, ".claude.json");
  const oauth = record(record(readJson(file))?.oauthAccount);
  if (!oauth) {
    return null;
  }
  return {
    accountId: text(oauth.accountUuid),
    email: text(oauth.emailAddress),
    source: "~/.claude.json",
    surface: "Claude Code",
  };
};

const claudeDesktopLogin = (home: string): MachineLogin | null => {
  if (process.platform !== "darwin") {
    return null;
  }
  const file = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "cowork-enabled-cli-ops.json"
  );
  const owner = text(record(readJson(file))?.ownerAccountId);
  if (!owner) {
    return null;
  }
  return {
    accountId: owner,
    email: null,
    source: "Application Support/Claude",
    surface: "Claude app",
  };
};

const codexLogin = (home: string): MachineLogin | null => {
  const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex");
  const auth = record(readJson(path.join(codexHome, "auth.json")));
  if (!auth) {
    return null;
  }
  const tokens = record(auth.tokens);
  return {
    accountId: text(tokens?.account_id),
    email:
      emailFromJwt(text(tokens?.id_token)) ??
      emailFromJwt(text(tokens?.access_token)),
    source: codexHome.replace(home, "~"),
    surface: "Codex",
  };
};

export const claudeAccountNamesByUuid = (
  dataDir: string
): Map<string, string> => {
  const names = new Map<string, string>();
  const root = path.join(dataDir, "accounts", "v3", "claude");
  let accounts: string[];
  try {
    accounts = fs.readdirSync(root);
  } catch {
    return names;
  }
  const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  // Two shapes, because the state stores the id both ways. Inside a
  // JSON-encoded blob the key sits against its value and arrives escaped; as a
  // browser storage entry the key is a `name` field and the id is the separate
  // `value` beside it, so no adjacency pattern can see the pair at once.
  const adjacent = new RegExp(
    `account_?[Uu]uid\\\\?"?\\s*:\\s*\\\\?"?(${UUID})`,
    "gu"
  );
  const entry = new RegExp(
    `"name"\\s*:\\s*"[^"]*(?:account|owner)[^"]*"\\s*,\\s*"value"\\s*:\\s*"(${UUID})"`,
    "giu"
  );
  for (const account of accounts) {
    let raw: string;
    try {
      raw = fs.readFileSync(
        path.join(root, account, "storage-state.json"),
        "utf-8"
      );
    } catch {
      continue;
    }
    for (const pattern of [adjacent, entry]) {
      for (const match of raw.matchAll(pattern)) {
        const uuid = match[1]?.toLowerCase();
        // First writer wins: the account whose own state carries the id owns it.
        if (uuid && !names.has(uuid)) {
          names.set(uuid, account);
        }
      }
    }
  }
  return names;
};

export const readMachineLogins = (
  homeDir: string = os.homedir()
): MachineLogin[] =>
  [
    claudeCodeLogin(homeDir),
    claudeDesktopLogin(homeDir),
    codexLogin(homeDir),
  ].filter((login): login is MachineLogin => login !== null);
