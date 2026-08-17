import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Where gauge keeps a `CODEX_HOME` per account, and how one gets made.
 *
 * The Codex CLI has no concept of accounts: it reads whichever `auth.json` sits
 * in `CODEX_HOME`, and a second account is therefore a second directory. gauge
 * has been keeping one per account since accounts were added — this file owns
 * that layout so provisioning a home and switching to one cannot come to
 * disagree about where homes live.
 */

/** The directory holding every Codex home gauge manages. */
export function codexHomesRoot(dataDir: string): string {
  return path.join(dataDir, "codex-homes");
}

/** The Codex home gauge manages for one account, whether or not it exists. */
export function managedCodexHome(dataDir: string, name: string): string {
  return path.join(codexHomesRoot(dataDir), name);
}

/** Whether a Codex home already holds a login gauge could read usage from. */
export function codexHomeHasLogin(home: string): boolean {
  return fs.existsSync(path.join(home, "auth.json"));
}

/**
 * Make an empty Codex home for the Codex CLI to log in to.
 *
 * Private to this user, because what lands here is an OAuth refresh token. The
 * mode is set on creation rather than after, so there is no window in which the
 * directory exists and is readable by anyone else.
 */
export function createCodexHome(home: string): void {
  fs.mkdirSync(home, { mode: 0o700, recursive: true });
}

/**
 * A path as a person typed it, as an absolute path.
 *
 * `~` is a shell expansion, and a prompt inside a running process never sees a
 * shell — so a typed `~/.codex` would otherwise be created as a directory
 * literally called `~`, next to wherever gauge happened to be run from.
 */
export function resolveCodexHomeInput(
  raw: string,
  homeDir: string = os.homedir(),
): string {
  const expanded =
    raw === "~"
      ? homeDir
      : raw.startsWith("~/")
        ? path.join(homeDir, raw.slice(2))
        : raw;
  return path.resolve(expanded);
}
