import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * Which account each tool on *this machine* is signed into.
 *
 * Distinct from everything else gauge reports. The dashboard answers "how much
 * is left on each account I have configured"; this answers "and which of them
 * am I actually typing into right now" — a different question, and one you
 * cannot answer from usage figures, because being signed in and having quota
 * are unrelated facts.
 *
 * It matters because the surfaces disagree quietly. Measured on one machine:
 * the Claude Code CLI signed into one account, the Claude desktop app into a
 * different one, and the Codex CLI into a third. Nothing on screen said so.
 */
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

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The email inside a JWT, without verifying or keeping the token.
 *
 * Codex records its identity only in the token it was issued, so the address has
 * to come out of the claims. Nothing is trusted from this beyond a display
 * string: it is never used to authorize anything, and the token itself never
 * leaves this function.
 */
function emailFromJwt(token: string | null): string | null {
  if (!token || token.split(".").length !== 3) return null;
  try {
    const [, payload] = token.split(".");
    const padded = (payload ?? "").padEnd(
      Math.ceil((payload ?? "").length / 4) * 4,
      "=",
    );
    const claims = record(
      JSON.parse(Buffer.from(padded, "base64url").toString("utf8")),
    );
    if (!claims) return null;
    const profile = record(claims["https://api.openai.com/profile"]);
    return text(claims.email) ?? text(profile?.email);
  } catch {
    return null;
  }
}

/** The Claude Code CLI's signed-in account, from its own state file. */
function claudeCodeLogin(home: string): MachineLogin | null {
  const file = path.join(home, ".claude.json");
  const oauth = record(record(readJson(file))?.oauthAccount);
  if (!oauth) return null;
  return {
    accountId: text(oauth.accountUuid),
    email: text(oauth.emailAddress),
    source: "~/.claude.json",
    surface: "Claude Code",
  };
}

/**
 * The Claude desktop app's signed-in account — identifier only.
 *
 * Its OAuth token cache is opaque on disk, so the address cannot be read the way
 * the CLI's can. The account identifier is still worth reporting: on its own it
 * names nothing, but compared against the CLI's it answers the question actually
 * being asked, which is whether the two surfaces are the same account.
 *
 * macOS path only. Absent elsewhere, which reads the same as not installed.
 */
function claudeDesktopLogin(home: string): MachineLogin | null {
  if (process.platform !== "darwin") return null;
  const file = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "cowork-enabled-cli-ops.json",
  );
  const owner = text(record(readJson(file))?.ownerAccountId);
  if (!owner) return null;
  return {
    accountId: owner,
    email: null,
    source: "Application Support/Claude",
    surface: "Claude app",
  };
}

/** The Codex CLI's signed-in account, from the home it would actually use. */
function codexLogin(home: string): MachineLogin | null {
  const codexHome = process.env.CODEX_HOME ?? path.join(home, ".codex");
  const auth = record(readJson(path.join(codexHome, "auth.json")));
  if (!auth) return null;
  const tokens = record(auth.tokens);
  return {
    accountId: text(tokens?.account_id),
    email:
      emailFromJwt(text(tokens?.id_token)) ??
      emailFromJwt(text(tokens?.access_token)),
    source: codexHome.replace(home, "~"),
    surface: "Codex",
  };
}

/** Every tool on this machine whose signed-in account can be read locally. */
export function readMachineLogins(
  homeDir: string = os.homedir(),
): MachineLogin[] {
  return [
    claudeCodeLogin(homeDir),
    claudeDesktopLogin(homeDir),
    codexLogin(homeDir),
  ].filter((login): login is MachineLogin => login !== null);
}
