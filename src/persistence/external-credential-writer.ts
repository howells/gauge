import fs from "node:fs";
import path from "node:path";
import { CLIError } from "../security.js";
import { type AtomicReplaceOptions, atomicReplace } from "./atomic-replace.js";

export type CredentialRefreshPolicy = "never" | "refresh-if-stale";

export interface CodexCredentialUpdate {
  accessToken: string;
  homePath: string;
  idToken?: string;
  lastRefresh: string;
  refreshToken?: string;
}

export type ExternalCredentialWriteResult =
  | { applied: true; authPath: string }
  | {
      applied: false;
      error: {
        code: "CREDENTIAL_REFRESH_DISABLED";
        message: string;
        retryable: false;
      };
    };

type ReplaceFile = (
  destinationPath: string,
  content: string,
  options?: AtomicReplaceOptions,
) => void;

interface ExternalCredentialWriterOptions {
  allowedCodexHomes: readonly string[];
  replaceFile?: ReplaceFile;
}

/** Apply pending OAuth token updates only to explicitly allowlisted Codex homes. */
export class ExternalCredentialWriter {
  readonly #allowedHomes: Map<string, string>;
  readonly #replaceFile: ReplaceFile;

  constructor(options: ExternalCredentialWriterOptions) {
    this.#allowedHomes = new Map(
      options.allowedCodexHomes.map((homePath) => {
        const resolvedPath = path.resolve(homePath);
        return [resolvedPath, canonicalAllowedHome(resolvedPath)];
      }),
    );
    this.#replaceFile = options.replaceFile ?? atomicReplace;
  }

  apply(
    update: CodexCredentialUpdate,
    policy: CredentialRefreshPolicy,
  ): ExternalCredentialWriteResult {
    if (policy === "never") {
      return {
        applied: false,
        error: {
          code: "CREDENTIAL_REFRESH_DISABLED",
          message: "Credential refresh is disabled by policy.",
          retryable: false,
        },
      };
    }
    const requestedHome = path.resolve(update.homePath);
    if (isSymlink(requestedHome)) {
      throw homeSymlinkError();
    }
    const allowedHome = this.#allowedHomes.get(requestedHome);
    if (!allowedHome) {
      throw homeNotAllowedError();
    }
    const homePath = fs.realpathSync(requestedHome);
    if (homePath !== allowedHome) {
      throw homeNotAllowedError();
    }
    const authPath = path.join(homePath, "auth.json");
    const status = fs.lstatSync(authPath);
    if (status.isSymbolicLink()) {
      throw new CLIError("Codex auth file must not be a symlink.", {
        code: "CODEX_AUTH_SYMLINK",
        exitCode: 1,
      });
    }
    if (!status.isFile()) {
      throw new CLIError("Codex auth file must be a regular file.", {
        code: "CODEX_AUTH_NOT_REGULAR",
        exitCode: 1,
      });
    }
    const auth = parseAuth(fs.readFileSync(authPath, "utf8"));
    const existingTokens = isRecord(auth.tokens) ? auth.tokens : {};
    auth.tokens = {
      ...existingTokens,
      access_token: update.accessToken,
      ...(update.idToken !== undefined && { id_token: update.idToken }),
      last_refresh: update.lastRefresh,
      ...(update.refreshToken !== undefined && {
        refresh_token: update.refreshToken,
      }),
    };
    const existingMode = status.mode & 0o777;
    const mode =
      existingMode !== 0 && (existingMode & 0o077) === 0 ? existingMode : 0o600;
    this.#replaceFile(authPath, `${JSON.stringify(auth, null, 2)}\n`, {
      mode,
    });
    return { applied: true, authPath };
  }
}

/** Validate an externally owned Codex home without changing it or exposing credentials. */
export function validateCodexHome(homePath: string): {
  authPath: string;
  homePath: string;
} {
  const resolvedHome = path.resolve(homePath);
  let homeStatus: fs.Stats;
  try {
    homeStatus = fs.lstatSync(resolvedHome);
  } catch {
    throw new CLIError("Codex home must be an existing directory.", {
      code: "INVALID_CODEX_HOME",
      exitCode: 2,
    });
  }
  if (homeStatus.isSymbolicLink()) throw homeSymlinkError();
  if (!homeStatus.isDirectory()) {
    throw new CLIError("Codex home must be an existing directory.", {
      code: "INVALID_CODEX_HOME",
      exitCode: 2,
    });
  }
  const canonicalHome = fs.realpathSync(resolvedHome);
  const authPath = path.join(canonicalHome, "auth.json");
  let authStatus: fs.Stats;
  try {
    authStatus = fs.lstatSync(authPath);
  } catch {
    throw new CLIError("Codex auth file is missing.", {
      code: "INVALID_CODEX_AUTH",
      exitCode: 2,
    });
  }
  if (authStatus.isSymbolicLink()) {
    throw new CLIError("Codex auth file must not be a symlink.", {
      code: "CODEX_AUTH_SYMLINK",
      exitCode: 2,
    });
  }
  if (!authStatus.isFile()) {
    throw new CLIError("Codex auth file must be a regular file.", {
      code: "CODEX_AUTH_NOT_REGULAR",
      exitCode: 2,
    });
  }
  const auth = parseAuth(fs.readFileSync(authPath, "utf8"));
  const tokens = isRecord(auth.tokens) ? auth.tokens : {};
  if (
    !(
      typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0
    ) &&
    !(
      typeof tokens.access_token === "string" && tokens.access_token.length > 0
    ) &&
    !(typeof tokens.accessToken === "string" && tokens.accessToken.length > 0)
  ) {
    throw new CLIError("Codex auth file contains no usable access token.", {
      code: "INVALID_CODEX_AUTH",
      exitCode: 2,
    });
  }
  return { authPath, homePath: canonicalHome };
}

function canonicalAllowedHome(homePath: string): string {
  const resolvedPath = path.resolve(homePath);
  assertHomeNotSymlink(resolvedPath);
  return fs.realpathSync(resolvedPath);
}

function assertHomeNotSymlink(homePath: string): void {
  if (fs.lstatSync(homePath).isSymbolicLink()) {
    throw homeSymlinkError();
  }
}

function isSymlink(homePath: string): boolean {
  try {
    return fs.lstatSync(homePath).isSymbolicLink();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

function homeSymlinkError(): CLIError {
  return new CLIError("Codex home must not be a symlink.", {
    code: "CODEX_HOME_SYMLINK",
    exitCode: 1,
  });
}

function homeNotAllowedError(): CLIError {
  return new CLIError("Codex home is not explicitly allowed.", {
    code: "CODEX_HOME_NOT_ALLOWED",
    exitCode: 1,
  });
}

function parseAuth(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new CLIError("Codex auth file is not valid JSON.", {
      code: "INVALID_CODEX_AUTH",
      exitCode: 1,
    });
  }
  if (!isRecord(parsed)) {
    throw new CLIError("Codex auth file must contain a JSON object.", {
      code: "INVALID_CODEX_AUTH",
      exitCode: 1,
    });
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
