import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountConfigV3Schema } from "../domain/account.js";
import { validateCodexHome } from "../persistence/external-credential-writer.js";
import { parseStorageStateJsonValue } from "../storage-state.js";

type DoctorStatus = "pass" | "warning" | "fail";

interface DoctorCheck {
  id: string;
  message: string;
  status: DoctorStatus;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  failed: number;
  warnings: number;
}

export interface DoctorOptions {
  chromePath: string | null;
  dataRoot: string;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  home?: string;
  nodeVersion: string;
}

/** Run local readiness checks without network access or filesystem writes. */
export function runDoctorChecks(options: DoctorOptions): DoctorReport {
  const checks: DoctorCheck[] = [];
  const major = Number.parseInt(options.nodeVersion.split(".")[0] ?? "0", 10);
  checks.push(
    major >= 20
      ? pass("runtime/node", `Node ${major} is supported.`)
      : fail("runtime/node", "Gauge requires Node 20 or newer."),
  );
  checks.push(
    options.chromePath
      ? pass(
          "runtime/chrome",
          "Chrome is available for interactive authentication.",
        )
      : warning(
          "runtime/chrome",
          "Chrome is unavailable; headless credential inputs remain usable.",
        ),
  );

  inspectDataRoot(options.dataRoot, checks);
  checks.push(
    readinessCheck(
      "readiness/codex-ambient",
      hasSafeCodexAuth(
        options.env.CODEX_HOME ??
          path.join(options.home ?? os.homedir(), ".codex"),
      ),
      "Ambient Codex discovery",
    ),
  );
  checks.push(
    readinessCheck(
      "readiness/cursor-ambient",
      Boolean(
        options.env.GAUGE_CURSOR_COOKIE ||
          options.env.GAUGE_CURSOR_COOKIE_FILE ||
          options.env.GAUGE_CURSOR_STORAGE_STATE_FILE ||
          options.env.GAUGE_CURSOR_STORAGE_STATE_JSON,
      ),
      "Ambient Cursor discovery",
    ),
  );

  return {
    checks,
    failed: checks.filter((check) => check.status === "fail").length,
    warnings: checks.filter((check) => check.status === "warning").length,
  };
}

function inspectDataRoot(dataRoot: string, checks: DoctorCheck[]): void {
  if (!fs.existsSync(dataRoot)) {
    checks.push(
      pass("data/root", "Gauge data root will be created on first mutation."),
    );
    checks.push(pass("state/migration", "No legacy migration is required."));
    return;
  }
  const rootStatus = fs.lstatSync(dataRoot);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    checks.push(fail("data/root", "Gauge data root must be a real directory."));
    checks.push(
      fail("state/migration", "Migration state cannot be inspected safely."),
    );
    return;
  } else if ((rootStatus.mode & 0o077) !== 0) {
    checks.push(
      fail("data/permissions", "Gauge data root must be owner-only (0700)."),
    );
  } else {
    checks.push(pass("data/root", "Gauge data root is safe."));
  }

  const readableRoot = rootStatus.isSymbolicLink()
    ? fs.realpathSync(dataRoot)
    : dataRoot;
  const rootNames = fs.readdirSync(readableRoot);
  const legacy = rootNames.some(
    (name) =>
      name.endsWith(".json") &&
      name !== "migration-v3.json" &&
      !name.endsWith("-storage.json"),
  );
  const journal = rootNames.includes("migration-v3.json");
  checks.push(
    legacy || journal
      ? warning(
          "state/migration",
          journal
            ? "A v3 migration journal requires resumption."
            : "Legacy account state requires explicit migration.",
        )
      : pass("state/migration", "No legacy migration is required."),
  );
  inspectV3Accounts(path.join(readableRoot, "accounts", "v3"), checks);
}

function inspectV3Accounts(accountsRoot: string, checks: DoctorCheck[]): void {
  if (!fs.existsSync(accountsRoot)) {
    return;
  }
  const rootStatus = fs.lstatSync(accountsRoot);
  if (rootStatus.isSymbolicLink() || !rootStatus.isDirectory()) {
    checks.push(fail("accounts/root", "The v3 account root is unsafe."));
    return;
  }
  for (const provider of fs.readdirSync(accountsRoot)) {
    const providerPath = path.join(accountsRoot, provider);
    const providerStatus = fs.lstatSync(providerPath);
    if (providerStatus.isSymbolicLink() || !providerStatus.isDirectory()) {
      checks.push(
        fail("accounts/provider", "An account provider directory is unsafe."),
      );
      continue;
    }
    for (const name of fs.readdirSync(providerPath)) {
      if (name.startsWith(".")) {
        if (name.includes(".tombstone-")) {
          checks.push(
            warning(
              "accounts/tombstone",
              "An invisible account tombstone is ready for cleanup.",
            ),
          );
        }
        continue;
      }
      inspectAccount(path.join(providerPath, name), provider, name, checks);
    }
  }
}

function inspectAccount(
  directory: string,
  provider: string,
  name: string,
  checks: DoctorCheck[],
): void {
  const directoryStatus = fs.lstatSync(directory);
  const configPath = path.join(directory, "config.json");
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    checks.push(fail("account/path", "An account path is unsafe."));
    return;
  }
  if ((directoryStatus.mode & 0o077) !== 0) {
    checks.push(
      fail("account/permissions", "An account directory must be owner-only."),
    );
  }
  try {
    const configStatus = fs.lstatSync(configPath);
    const config = AccountConfigV3Schema.parse(
      JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown,
    );
    if (
      configStatus.isSymbolicLink() ||
      !configStatus.isFile() ||
      (configStatus.mode & 0o077) !== 0 ||
      config.provider !== provider ||
      config.name !== name
    ) {
      throw new Error("unsafe config");
    }
    checks.push(pass("account/config", "A configured account is valid."));
    inspectAccountArtifacts(
      directory,
      config.provider,
      config.codexHome,
      checks,
    );
  } catch {
    checks.push(fail("account/config", "A configured account is invalid."));
  }
}

function inspectAccountArtifacts(
  directory: string,
  provider: "claude" | "codex" | "cursor",
  codexHome: string | undefined,
  checks: DoctorCheck[],
): void {
  const storageState = path.join(directory, "storage-state.json");
  if (provider !== "codex") {
    inspectCredentialFile(
      storageState,
      "account/storage-state",
      "Account storage state",
      true,
      checks,
    );
  } else {
    checks.push(
      readinessCheck(
        "readiness/codex-configured",
        codexHome !== undefined && hasSafeCodexAuth(codexHome),
        "Configured Codex credentials",
      ),
    );
  }

  const profile = path.join(directory, "profile");
  const profileStatus = lstatIfPresent(profile);
  if (profileStatus) {
    checks.push(
      profileStatus.isDirectory() && !profileStatus.isSymbolicLink()
        ? pass("account/profile", "Browser profile cache is a real directory.")
        : fail("account/profile", "Browser profile cache is unsafe."),
    );
  }
}

function inspectCredentialFile(
  filePath: string,
  id: string,
  label: string,
  required: boolean,
  checks: DoctorCheck[],
): void {
  const status = lstatIfPresent(filePath);
  if (!status) {
    checks.push(
      required
        ? warning(id, `${label} is missing; refresh is required.`)
        : pass(id, `${label} is not configured.`),
    );
    return;
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (status.mode & 0o077) !== 0
  ) {
    checks.push(fail(id, `${label} must be a protected regular file (0600).`));
    return;
  }
  try {
    parseStorageStateJsonValue(fs.readFileSync(filePath, "utf8"));
    checks.push(pass(id, `${label} is valid protected Playwright state.`));
  } catch {
    checks.push(fail(id, `${label} contains invalid Playwright state.`));
  }
}

function lstatIfPresent(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function hasSafeCodexAuth(homePath: string): boolean {
  try {
    const validated = validateCodexHome(homePath);
    const homeStatus = fs.statSync(validated.homePath);
    const authStatus = fs.statSync(validated.authPath);
    return (homeStatus.mode & 0o077) === 0 && (authStatus.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function readinessCheck(
  id: string,
  ready: boolean,
  label: string,
): DoctorCheck {
  return ready
    ? pass(id, `${label} is configured.`)
    : warning(id, `${label} is not configured.`);
}

function pass(id: string, message: string): DoctorCheck {
  return { id, message, status: "pass" };
}

function warning(id: string, message: string): DoctorCheck {
  return { id, message, status: "warning" };
}

function fail(id: string, message: string): DoctorCheck {
  return { id, message, status: "fail" };
}
