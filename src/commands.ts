import fs from "node:fs";
import {
  accountExists,
  getAccountArtifacts,
  importStorageState,
  listAccountDetails,
  removeAccount,
  saveAccount,
} from "./accounts.js";
import { addAccount, addCursorAccount, fetchAllUsage } from "./api.js";
import { markCurrentAccounts } from "./current-account.js";
import { claudeToUnified, formatDashboard } from "./display.js";
import type { CommandResult, OutputOptions } from "./output.js";
import { fetchCodexAccounts, fetchCursorAccounts } from "./provider-usage.js";
import { describeCommands } from "./schema.js";
import { CLIError } from "./security.js";
import type { Provider, UnifiedAccount } from "./types.js";

interface CommandOptions extends OutputOptions {
  codexHome?: string;
  dryRun?: boolean;
  inputFile?: string;
  json?: string;
  provider?: string;
  quick?: boolean;
  quiet?: boolean;
  renewsAt?: string;
  signal?: AbortSignal;
  storageStateFile?: string;
  storageStateJson?: string;
}

interface MutationPayload {
  codex_home?: string;
  name: string;
  provider?: string;
  renews_at?: string | null;
  storage_state_file?: string;
  storage_state_json?: string;
}

interface RecommendationWindow {
  basis:
    | "available_session"
    | "available_weekly"
    | "blocked_until_available"
    | "session_not_started"
    | "unknown";
  label: string;
  milliseconds: number | null;
  until: string | null;
}

/** Fetch usage for all accounts and build a status/recommendation result. */
export async function runStatusCommand(
  options: CommandOptions,
): Promise<CommandResult> {
  const quiet = options.quiet ?? false;

  // Codex + Cursor use local provider auth, independent of Claude browser state.
  if (!quiet) process.stdout.write("  Fetching codex...\n");
  const allConfigs = listAccountDetails();
  const codexConfigs = allConfigs.filter(
    (account) => account.provider === "codex",
  );
  const cursorConfigs = allConfigs.filter(
    (account) => account.provider === "cursor",
  );

  const codexAccounts = await fetchCodexAccounts(codexConfigs);

  if (!quiet) process.stdout.write("  Fetching cursor...\n");
  const cursorAccounts = await fetchCursorAccounts(cursorConfigs);

  // Claude via Playwright (sequential per account)
  const claudeConfigs = allConfigs.filter(
    (account) => account.provider === "claude",
  );
  const claudeRaw =
    claudeConfigs.length > 0
      ? await fetchAllUsage(
          claudeConfigs.map((account) => ({
            authKey: account.authKey,
            name: account.name,
            renewsAt: account.renewsAt,
          })),
          { quiet },
        )
      : [];
  const claudeAccounts = claudeRaw.map(claudeToUnified);

  const groups = markCurrentAccounts(
    {
      ...(claudeAccounts.length > 0 && { claude: claudeAccounts }),
      ...(codexAccounts.length > 0 && { codex: codexAccounts }),
      ...(cursorAccounts.length > 0 && { cursor: cursorAccounts }),
    },
    allConfigs,
  );

  const allAccounts = Object.values(groups).flat().filter(Boolean);
  const statusAccounts = allAccounts.map(addStatusNameAlias);
  const statusGroups = mapStatusGroups(groups);
  const recommendation =
    claudeRaw.length > 0 ? pickRecommendation(claudeRaw) : null;

  if (allAccounts.length === 0) {
    return {
      command: "status",
      data: { accounts: [], recommendation: null },
      human: "\nNo accounts configured.\nAdd one with: gauge add <name>\n",
    };
  }

  return {
    command: "status",
    data: {
      accounts: statusAccounts,
      groups: statusGroups,
      recommendation,
    },
    human: formatDashboard(groups),
  };
}

/** List all configured accounts with their local artifact details. */
export function runListCommand(): CommandResult {
  const accounts = listAccountDetails();
  const human =
    accounts.length === 0
      ? "\nNo accounts configured.\nAdd one with: gauge add <name>\n"
      : `\nConfigured accounts:\n${accounts
          .map((account) => `  • ${account.provider}:${account.name}`)
          .join("\n")}\n`;

  return {
    command: "list",
    data: { accounts },
    human,
    paginated: {
      itemName: "accounts",
      items: accounts,
    },
  };
}

/** Return the runtime CLI schema, optionally filtered to a single command. */
export function runDescribeCommand(commandName?: string): CommandResult {
  const data = describeCommands(commandName);
  return {
    command: "describe",
    data,
    human: `${JSON.stringify(data, null, 2)}\n`,
    paginated: Array.isArray(data.commands)
      ? {
          itemName: "commands",
          items: data.commands,
          summary: {
            generated_at: data.generated_at,
            global_options: data.global_options,
            runtime: data.runtime,
            security_posture: data.security_posture,
          },
        }
      : undefined,
  };
}

/** Add a new account via browser login or headless storage-state import. */
export async function runAddCommand(
  name: string | undefined,
  options: CommandOptions,
): Promise<CommandResult> {
  const payload = resolveMutationPayload(name, options);
  const provider = resolveProvider(payload.provider);
  if (accountExists(payload.name, provider)) {
    throw new CLIError(`Account "${payload.name}" already exists.`, {
      code: "ACCOUNT_EXISTS",
      exitCode: 2,
      details: { hint: `Use gauge refresh ${payload.name}` },
    });
  }

  const storageStateMode = resolveStorageStateMode(payload, options);
  const artifacts = getAccountArtifacts(payload.name, provider);
  if (options.dryRun) {
    return {
      command: "add",
      data: {
        action: "add",
        name: payload.name,
        provider,
        auth_mode: resolveAuthMode(provider, storageStateMode),
        ...(payload.renews_at !== undefined && {
          renews_at: payload.renews_at,
        }),
        writes: [
          artifacts.accountPath,
          ...(storageStateMode ? [artifacts.storagePath] : []),
        ],
      },
      dryRun: true,
      human: `Dry run: would add "${payload.name}" via ${resolveAuthMode(
        provider,
        storageStateMode,
      )}.\n`,
    };
  }

  if (provider === "codex") {
    const codexHome = payload.codex_home ?? options.codexHome;
    if (!codexHome) {
      throw new CLIError("Codex accounts require codex_home.", {
        code: "CODEX_HOME_REQUIRED",
        exitCode: 2,
        details: { hint: "Use --codex-home /path/to/codex-home" },
      });
    }
    saveAccount(payload.name, {
      codexHome,
      provider,
      renewsAt: payload.renews_at,
    });
    return {
      command: "add",
      data: {
        action: "add",
        name: payload.name,
        provider,
        auth_mode: "codex-home",
        account_saved: true,
      },
      human: `Account "${payload.name}" added from Codex home.\n`,
    };
  }

  if (storageStateMode) {
    saveAccount(payload.name, { provider, renewsAt: payload.renews_at });
    importStorageState(payload.name, storageStateMode, provider);
    return {
      command: "add",
      data: {
        action: "add",
        name: payload.name,
        provider,
        auth_mode: "headless-storage-state",
        account_saved: true,
      },
      human: `Account "${payload.name}" added from storage state.\n`,
    };
  }

  if (provider === "cursor") {
    const success = await addCursorAccount(payload.name, {
      authKey: artifacts.authKey,
      quiet: options.quiet,
      signal: options.signal,
    });
    if (!success) {
      throw new CLIError(`Failed to add Cursor account "${payload.name}".`, {
        code: "ADD_FAILED",
        exitCode: 1,
      });
    }
    saveAccount(payload.name, { provider, renewsAt: payload.renews_at });
    return {
      command: "add",
      data: {
        action: "add",
        name: payload.name,
        provider,
        auth_mode: "browser",
        account_saved: true,
      },
      human: `✓ Account "${payload.name}" added successfully.\n`,
    };
  }

  const success = await addAccount(payload.name, {
    quiet: options.quiet,
    signal: options.signal,
  });
  if (!success) {
    throw new CLIError(`Failed to add account "${payload.name}".`, {
      code: "ADD_FAILED",
      exitCode: 1,
    });
  }

  saveAccount(payload.name, { provider, renewsAt: payload.renews_at });
  return {
    command: "add",
    data: {
      action: "add",
      name: payload.name,
      provider,
      auth_mode: "browser",
      account_saved: true,
    },
    human: `✓ Account "${payload.name}" added successfully.\n`,
  };
}

/** Re-authenticate an existing account via browser or storage-state import. */
export async function runRefreshCommand(
  name: string | undefined,
  options: CommandOptions,
): Promise<CommandResult> {
  const payload = resolveMutationPayload(name, options);
  const provider = resolveProvider(payload.provider);
  if (!accountExists(payload.name, provider)) {
    throw new CLIError(`Account "${payload.name}" not found.`, {
      code: "ACCOUNT_NOT_FOUND",
      exitCode: 2,
      details: { hint: `Use gauge add ${payload.name}` },
    });
  }

  const storageStateMode = resolveStorageStateMode(payload, options);
  const artifacts = getAccountArtifacts(payload.name, provider);
  const writes = refreshWrites(provider, payload, options, artifacts);
  if (options.dryRun) {
    return {
      command: "refresh",
      data: {
        action: "refresh",
        name: payload.name,
        provider,
        auth_mode: resolveAuthMode(provider, storageStateMode),
        ...(payload.renews_at !== undefined && {
          renews_at: payload.renews_at,
        }),
        writes,
      },
      dryRun: true,
      human: `Dry run: would refresh "${payload.name}" via ${resolveAuthMode(
        provider,
        storageStateMode,
      )}.\n`,
    };
  }

  if (provider === "codex") {
    const codexHome = payload.codex_home ?? options.codexHome;
    if (codexHome || payload.renews_at !== undefined) {
      saveAccount(payload.name, {
        ...(codexHome !== undefined && { codexHome }),
        provider,
        renewsAt: payload.renews_at,
      });
    }
    return {
      command: "refresh",
      data: {
        action: "refresh",
        name: payload.name,
        provider,
        auth_mode: "codex-home",
        session_refreshed: true,
      },
      human: codexHome
        ? `Account "${payload.name}" Codex home updated.\n`
        : `Account "${payload.name}" uses Codex home auth.\n`,
    };
  }

  if (storageStateMode) {
    importStorageState(payload.name, storageStateMode, provider);
    if (payload.renews_at !== undefined) {
      saveAccount(payload.name, { provider, renewsAt: payload.renews_at });
    }
    return {
      command: "refresh",
      data: {
        action: "refresh",
        name: payload.name,
        provider,
        auth_mode: "headless-storage-state",
        session_refreshed: true,
      },
      human: `Account "${payload.name}" refreshed from storage state.\n`,
    };
  }

  if (provider === "cursor") {
    const success = await addCursorAccount(payload.name, {
      authKey: artifacts.authKey,
      quiet: options.quiet,
      signal: options.signal,
    });
    if (!success) {
      throw new CLIError(
        `Failed to refresh Cursor account "${payload.name}".`,
        {
          code: "REFRESH_FAILED",
          exitCode: 1,
        },
      );
    }
    if (payload.renews_at !== undefined) {
      saveAccount(payload.name, { provider, renewsAt: payload.renews_at });
    }
    return {
      command: "refresh",
      data: {
        action: "refresh",
        name: payload.name,
        provider,
        auth_mode: "browser",
        session_refreshed: true,
      },
      human: `✓ Account "${payload.name}" refreshed successfully.\n`,
    };
  }

  const success = await addAccount(payload.name, {
    quiet: options.quiet,
    signal: options.signal,
  });
  if (!success) {
    throw new CLIError(`Failed to refresh account "${payload.name}".`, {
      code: "REFRESH_FAILED",
      exitCode: 1,
    });
  }
  if (payload.renews_at !== undefined) {
    saveAccount(payload.name, { provider, renewsAt: payload.renews_at });
  }

  return {
    command: "refresh",
    data: {
      action: "refresh",
      name: payload.name,
      provider,
      auth_mode: "browser",
      session_refreshed: true,
    },
    human: `✓ Account "${payload.name}" refreshed successfully.\n`,
  };
}

/** Remove an account and all its local auth artifacts. */
export function runRemoveCommand(
  name: string | undefined,
  options: CommandOptions,
): CommandResult {
  const payload = resolveMutationPayload(name, options);
  const provider = resolveProvider(payload.provider);
  if (!accountExists(payload.name, provider)) {
    throw new CLIError(`Account "${payload.name}" not found.`, {
      code: "ACCOUNT_NOT_FOUND",
      exitCode: 2,
    });
  }

  const artifacts = getAccountArtifacts(payload.name, provider);
  if (options.dryRun) {
    return {
      command: "remove",
      data: {
        action: "remove",
        name: payload.name,
        provider,
        deletes: [
          artifacts.accountPath,
          artifacts.storagePath,
          artifacts.profileDir,
        ],
      },
      dryRun: true,
      human: `Dry run: would remove "${payload.name}" and its local auth artifacts.\n`,
    };
  }

  if (!removeAccount(payload.name, provider)) {
    throw new CLIError(`Account "${payload.name}" not found.`, {
      code: "ACCOUNT_NOT_FOUND",
      exitCode: 2,
    });
  }

  return {
    command: "remove",
    data: {
      action: "remove",
      name: payload.name,
      provider,
      removed: true,
    },
    human: `✓ Account "${payload.name}" removed.\n`,
  };
}

function resolveMutationPayload(
  name: string | undefined,
  options: CommandOptions,
): MutationPayload {
  const rawPayload = loadRawPayload(options);
  return {
    codex_home: rawPayload?.codex_home ?? options.codexHome,
    name: rawPayload?.name ?? name ?? "",
    provider: rawPayload?.provider ?? options.provider,
    renews_at: normalizeRenewalInput(
      rawPayload && Object.hasOwn(rawPayload, "renews_at")
        ? rawPayload.renews_at
        : options.renewsAt,
    ),
    storage_state_file:
      rawPayload?.storage_state_file ?? options.storageStateFile,
    storage_state_json:
      normalizeStorageStateJson(
        rawPayload?.storage_state_json ?? options.storageStateJson,
      ) ?? getStorageStateJsonEnv(),
  };
}

function normalizeRenewalInput(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new CLIError("renews_at must be a date string or null.", {
      code: "INVALID_RENEWAL",
      exitCode: 2,
    });
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none" || trimmed === "null") return null;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    throw new CLIError(`Invalid renews_at timestamp "${value}".`, {
      code: "INVALID_RENEWAL",
      exitCode: 2,
      details: { expected: "ISO timestamp or YYYY-MM-DD" },
    });
  }
  return new Date(timestamp).toISOString();
}

function resolveProvider(raw: string | undefined): Provider {
  const provider = raw ?? "claude";
  if (provider === "claude" || provider === "codex" || provider === "cursor") {
    return provider;
  }
  throw new CLIError(`Unsupported provider "${provider}".`, {
    code: "UNSUPPORTED_PROVIDER",
    exitCode: 2,
    details: { supported: ["claude", "codex", "cursor"] },
  });
}

function resolveAuthMode(
  provider: Provider,
  storageStateMode: { filePath?: string; json?: string } | null,
): string {
  if (provider === "codex") return "codex-home";
  if (storageStateMode) return "headless-storage-state";
  return "browser";
}

function loadRawPayload(options: CommandOptions): MutationPayload | null {
  let rawJson = options.json ?? null;
  if (!rawJson && options.inputFile) {
    rawJson =
      options.inputFile === "-"
        ? fs.readFileSync(0, "utf8")
        : fs.readFileSync(options.inputFile, "utf8");
  }

  if (!rawJson) {
    return null;
  }

  try {
    return JSON.parse(rawJson) as MutationPayload;
  } catch (error) {
    throw new CLIError("Raw payload is not valid JSON.", {
      code: "INVALID_JSON_INPUT",
      exitCode: 2,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveStorageStateMode(
  payload: MutationPayload,
  options: CommandOptions,
): { filePath?: string; json?: string } | null {
  const filePath =
    payload.storage_state_file ??
    options.storageStateFile ??
    getStorageStateFileEnv();
  const json =
    normalizeStorageStateJson(payload.storage_state_json) ??
    normalizeStorageStateJson(options.storageStateJson) ??
    getStorageStateJsonEnv();

  if (!(filePath || json)) {
    return null;
  }

  return { filePath, json };
}

function refreshWrites(
  provider: Provider,
  payload: MutationPayload,
  options: CommandOptions,
  artifacts: ReturnType<typeof getAccountArtifacts>,
): string[] {
  if (provider === "codex") {
    const changesConfig =
      payload.renews_at !== undefined ||
      payload.codex_home !== undefined ||
      options.codexHome !== undefined;
    return changesConfig ? [artifacts.accountPath] : [];
  }

  return [
    artifacts.storagePath,
    ...(payload.renews_at !== undefined ? [artifacts.accountPath] : []),
  ];
}

function getStorageStateFileEnv(): string | undefined {
  return process.env.GAUGE_STORAGE_STATE_FILE;
}

function getStorageStateJsonEnv(): string | undefined {
  return process.env.GAUGE_STORAGE_STATE_JSON;
}

function normalizeStorageStateJson(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }

  return undefined;
}

function pickRecommendation(
  accounts: Awaited<ReturnType<typeof fetchAllUsage>>,
): {
  account_window: RecommendationWindow | null;
  account: { name: string; plan: string } | null;
  status: string;
} {
  const available = accounts
    .filter((account) => !account.error)
    .map((account) => ({
      account,
      blocked:
        (account.usage.five_hour?.utilization ?? 0) >= 100 ||
        (account.usage.seven_day?.utilization ?? 0) >= 100,
      score:
        (account.usage.five_hour?.utilization ?? 0) +
        (account.usage.seven_day?.utilization ?? 0),
      waitUntil: Math.max(
        account.usage.five_hour?.resets_at
          ? new Date(account.usage.five_hour.resets_at).getTime()
          : 0,
        account.usage.seven_day?.resets_at
          ? new Date(account.usage.seven_day.resets_at).getTime()
          : 0,
      ),
    }))
    .sort((left, right) => {
      if (left.blocked !== right.blocked) {
        return Number(left.blocked) - Number(right.blocked);
      }
      if (left.blocked) {
        return left.waitUntil - right.waitUntil;
      }
      return left.score - right.score;
    });

  const best = available[0];
  if (!best) {
    return {
      account_window: null,
      account: null,
      status: "No configured account is currently usable.",
    };
  }

  return {
    account_window: getRecommendationWindow(best.account, best.blocked),
    account: {
      name: best.account.name,
      plan: best.account.plan,
    },
    status: best.blocked ? "wait" : "use_now",
  };
}

function addStatusNameAlias(account: UnifiedAccount): UnifiedAccount & {
  name: string;
} {
  return {
    ...account,
    name: account.label,
  };
}

function mapStatusGroups(
  groups: Partial<Record<string, UnifiedAccount[]>>,
): Partial<Record<string, Array<UnifiedAccount & { name: string }>>> {
  const result: Partial<
    Record<string, Array<UnifiedAccount & { name: string }>>
  > = {};
  for (const [provider, accounts] of Object.entries(groups)) {
    if (!accounts) continue;
    result[provider] = accounts.map(addStatusNameAlias);
  }
  return result;
}

function getRecommendationWindow(
  account: Awaited<ReturnType<typeof fetchAllUsage>>[number],
  blocked: boolean,
): RecommendationWindow {
  const fiveHour = account.usage.five_hour;
  const sevenDay = account.usage.seven_day;

  if (blocked) {
    const blockingReset = earliestFutureReset([
      fiveHour?.utilization === 100 ? fiveHour.resets_at : null,
      sevenDay?.utilization === 100 ? sevenDay.resets_at : null,
    ]);
    if (blockingReset) {
      const milliseconds = Math.max(0, blockingReset.getTime() - Date.now());
      return {
        basis: "blocked_until_available",
        label: formatDuration(milliseconds),
        milliseconds,
        until: blockingReset.toISOString(),
      };
    }
  }

  if (fiveHour?.resets_at) {
    const resetAt = new Date(fiveHour.resets_at);
    const milliseconds = Math.max(0, resetAt.getTime() - Date.now());
    return {
      basis: "available_session",
      label: formatDuration(milliseconds),
      milliseconds,
      until: resetAt.toISOString(),
    };
  }

  if (sevenDay?.resets_at) {
    const resetAt = new Date(sevenDay.resets_at);
    const milliseconds = Math.max(0, resetAt.getTime() - Date.now());
    return {
      basis: "available_weekly",
      label: formatDuration(milliseconds),
      milliseconds,
      until: resetAt.toISOString(),
    };
  }

  return {
    basis: fiveHour?.utilization === 0 ? "session_not_started" : "unknown",
    label: fiveHour?.utilization === 0 ? "session not started" : "unknown",
    milliseconds: null,
    until: null,
  };
}

function earliestFutureReset(
  timestamps: Array<string | null | undefined>,
): Date | null {
  const futureDates = timestamps
    .filter((value): value is string => typeof value === "string")
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .filter((value) => value.getTime() > Date.now())
    .sort((left, right) => left.getTime() - right.getTime());

  return futureDates[0] ?? null;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) {
    return "now";
  }

  const totalMinutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || parts.length === 0) {
    parts.push(`${minutes}m`);
  }

  return parts.join(" ");
}

export const __test = {
  getRecommendationWindow,
  normalizeRenewalInput,
  pickRecommendation,
  refreshWrites,
};
