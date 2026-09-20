import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import chalk from "chalk";

import {
  accountExists,
  createAccount,
  getAccountArtifacts,
  listAccountDetails,
  refreshAccount,
  removeAccount,
} from "./accounts.js";
import type { AccountDetails } from "./accounts.js";
import { addAccount, addCursorAccount } from "./api.js";
import {
  AddWireSchema,
  RefreshWireSchema,
  RemoveWireSchema,
} from "./commands/wire-schemas.js";
import type { Provider } from "./domain/account.js";
import type { CommandResult, OutputOptions } from "./output.js";
import { getDataDir } from "./paths.js";
import { validateCodexHome } from "./persistence/external-credential-writer.js";
import {
  buildLocalSources,
  createLocalAdapters,
} from "./providers/local-adapters.js";
import { describeCommands } from "./schema.js";
import { CLIError } from "./security.js";
import { selectConfiguredAccounts } from "./services/account-selection.js";
import { applyPendingCredentialUpdates } from "./services/credential-updates.js";
import { missingAccountName } from "./services/onboarding.js";
import { buildStatusResult } from "./services/status-result.js";
import { UsageService } from "./services/usage-service.js";
import {
  parseStorageStateJsonValue,
  readStorageStateFile,
} from "./storage-state.js";
import type { PlaywrightStorageState } from "./storage-state.js";

interface CommandOptions extends OutputOptions {
  account?: string;
  codexHome?: string;
  dryRun?: boolean;
  inputFile?: string;
  json?: string;
  noCredentialRefresh?: boolean;
  provider?: string;
  quick?: boolean;
  quiet?: boolean;
  renewsAt?: string;
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

const renderAccountList = (accounts: AccountDetails[]): string => {
  if (accounts.length === 0) {
    return "\nNo accounts configured.\nAdd one with: gauge add <name>\n";
  }
  const providerNames = { claude: "Claude", codex: "Codex", cursor: "Cursor" };
  const nameWidth = Math.max(...accounts.map((account) => account.name.length));
  const lines: string[] = [""];
  for (const provider of ["claude", "codex", "cursor"] as const) {
    const group = accounts.filter((account) => account.provider === provider);
    if (group.length === 0) {
      continue;
    }
    lines.push(`   ${chalk.bold(providerNames[provider])}`);
    for (const account of group) {
      const artifacts = [
        account.hasStorageState && "session",
        account.hasProfileDir && "profile",
        account.codexHome !== undefined && "codex home",
      ].filter((value): value is string => typeof value === "string");
      const detail = artifacts.length > 0 ? artifacts.join(" · ") : "no auth";
      lines.push(
        `     ${account.name.padEnd(nameWidth + 2)}${chalk.dim(detail)}`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
};

export const runListCommand = (): CommandResult => {
  const accounts = listAccountDetails();
  return {
    command: "list",
    data: { accounts },
    human: renderAccountList(accounts),
    paginated: {
      itemName: "accounts",
      items: accounts,
    },
  };
};

export const codexLoginRemedy = (name: string): { home: string } | null => {
  const home = listAccountDetails("codex").find(
    (account) => account.name === name
  )?.codexHome;
  return home ? { home } : null;
};

const codexRefreshGuidance = (name: string): string => {
  const home = codexLoginRemedy(name)?.home;
  const lines = [
    `Account "${name}" reads its credentials from a Codex home;`,
    "gauge cannot re-login there itself.",
    "",
    "Re-authenticate with the Codex CLI:",
    ...(home
      ? [`  CODEX_HOME=${JSON.stringify(home)} codex login`]
      : ["  codex login   (with CODEX_HOME set to this account's home)"]),
    "",
    `Or point the account at a different home:`,
    `  gauge refresh codex ${name} --codex-home <path>`,
  ];
  return `${lines.join("\n")}\n`;
};

export const runDescribeCommand = (commandName?: string): CommandResult => {
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
};

const authenticateWithTemporaryProfile = async (
  provider: Provider,
  name: string,
  quiet: boolean | undefined,
  commit: (storageState: PlaywrightStorageState, profileSource: string) => void
): Promise<boolean> => {
  const profileSource = fs.mkdtempSync(
    path.join(os.tmpdir(), `gauge-${provider}-auth-`)
  );
  try {
    const storageState =
      provider === "cursor"
        ? await addCursorAccount(name, { profileDir: profileSource, quiet })
        : await addAccount(name, { profileDir: profileSource, quiet });
    if (!storageState) {
      return false;
    }
    commit(storageState, profileSource);
    return true;
  } finally {
    fs.rmSync(profileSource, { force: true, recursive: true });
  }
};

export const normalizeRenewalInput = (
  value: unknown
): string | null | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new CLIError("renews_at must be a date string or null.", {
      code: "INVALID_RENEWAL",
      exitCode: 2,
    });
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "none" || trimmed === "null") {
    return null;
  }
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) {
    throw new CLIError(`Invalid renews_at timestamp "${value}".`, {
      code: "INVALID_RENEWAL",
      details: { expected: "ISO timestamp or YYYY-MM-DD" },
      exitCode: 2,
    });
  }
  return new Date(timestamp).toISOString();
};

const resolveProvider = (raw: string | undefined): Provider => {
  const provider = raw ?? "claude";
  if (provider === "claude" || provider === "codex" || provider === "cursor") {
    return provider;
  }
  throw new CLIError(`Unsupported provider "${provider}".`, {
    code: "UNSUPPORTED_PROVIDER",
    details: { supported: ["claude", "codex", "cursor"] },
    exitCode: 2,
  });
};

export const runStatusCommand = async (
  options: CommandOptions
): Promise<CommandResult> => {
  const allConfigs = listAccountDetails();
  const provider =
    options.provider === undefined
      ? undefined
      : resolveProvider(options.provider);
  const selectable = allConfigs.map((account, order) => ({
    account,
    id: { name: account.name, provider: account.provider },
    order,
  }));
  const selected = selectConfiguredAccounts(selectable, {
    account: options.account,
    provider,
  }).map((selection) => selection.account);
  const providers = new Set<string>(
    provider ? [provider] : ["claude", "codex", "cursor", "zai", "grok"]
  );
  const sources = buildLocalSources(selected, {
    accountFiltered: options.account !== undefined,
    providers,
  });
  const service = new UsageService({ adapters: createLocalAdapters(selected) });
  const snapshot = await service.collect(sources, {
    credentialRefresh: options.noCredentialRefresh
      ? "never"
      : "refresh-if-stale",
  });
  const credentialPolicy = options.noCredentialRefresh
    ? "never"
    : "refresh-if-stale";
  applyPendingCredentialUpdates(snapshot.pendingCredentialUpdates, {
    allowedCodexHomes: [
      ...selected.flatMap((account) =>
        account.provider === "codex" && account.codexHome
          ? [account.codexHome]
          : []
      ),
      ...(sources.some(
        (source) => source.provider === "codex" && source.source === "ambient"
      )
        ? [process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")]
        : []),
    ],
    dataRoot: getDataDir(),
    policy: credentialPolicy,
  });
  return buildStatusResult(snapshot, {
    now: new Date(),
    quick: options.quick ?? false,
  });
};

const ensureAccountNamed = (
  command: "add" | "refresh" | "remove",
  name: string | undefined,
  options: CommandOptions
): void => {
  if (name || options.json !== undefined || options.inputFile !== undefined) {
    return;
  }
  const provider =
    options.provider === undefined
      ? undefined
      : resolveProvider(options.provider);
  throw missingAccountName(command, provider);
};

const resolveAuthMode = (
  provider: Provider,
  storageStateMode: { filePath?: string; json?: string } | null
): string => {
  if (provider === "codex") {
    return "codex-home";
  }
  if (storageStateMode) {
    return "headless-storage-state";
  }
  return "browser";
};

const loadRawPayload = (
  options: CommandOptions
): Record<string, unknown> | null => {
  let rawJson = options.json ?? null;
  if (!rawJson && options.inputFile) {
    rawJson =
      options.inputFile === "-"
        ? fs.readFileSync(0, "utf-8")
        : fs.readFileSync(options.inputFile, "utf-8");
  }

  if (!rawJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CLIError("Raw payload must be a JSON object.", {
        code: "INVALID_WIRE_INPUT",
        exitCode: 2,
      });
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new CLIError("Raw payload is not valid JSON.", {
      code: "INVALID_JSON_INPUT",
      details: error instanceof Error ? error.message : String(error),
      exitCode: 2,
    });
  }
};

const validateStorageStateMode = (
  mode: { filePath?: string; json?: string } | null
): PlaywrightStorageState | undefined => {
  if (!mode) {
    return undefined;
  }
  if (mode.json !== undefined) {
    return parseStorageStateJsonValue(mode.json);
  }
  return JSON.parse(
    readStorageStateFile(mode.filePath ?? "")
  ) as PlaywrightStorageState;
};

export const refreshWrites = (
  provider: Provider,
  payload: MutationPayload,
  options: CommandOptions,
  artifacts: ReturnType<typeof getAccountArtifacts>
): string[] => {
  if (provider === "codex") {
    const changesConfig =
      payload.renews_at !== undefined ||
      payload.codex_home !== undefined ||
      options.codexHome !== undefined;
    return changesConfig ? [artifacts.accountPath] : [];
  }

  return [
    artifacts.storagePath,
    ...(payload.renews_at === undefined ? [] : [artifacts.accountPath]),
  ];
};

const getStorageStateFileEnv = (): string | undefined =>
  process.env.GAUGE_STORAGE_STATE_FILE;

const getStorageStateJsonEnv = (): string | undefined =>
  process.env.GAUGE_STORAGE_STATE_JSON;

const normalizeStorageStateJson = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return JSON.stringify(value);
  }

  return undefined;
};

const validateMutationWire = (
  command: "add" | "refresh" | "remove",
  value: Record<string, unknown>
): MutationPayload => {
  const parsed =
    command === "add"
      ? AddWireSchema.safeParse(value)
      : command === "refresh"
        ? RefreshWireSchema.safeParse(value)
        : RemoveWireSchema.safeParse(value);
  if (!parsed.success) {
    throw new CLIError(
      "Command input does not match the declared wire schema.",
      {
        code: "INVALID_WIRE_INPUT",
        details: {
          issues: parsed.error.issues.map((issue) => ({
            code: issue.code,
            message: issue.message,
            path: issue.path,
          })),
        },
        exitCode: 2,
      }
    );
  }
  if (command === "remove") {
    const removal = RemoveWireSchema.parse(value);
    return { name: removal.name, provider: removal.provider };
  }
  const session =
    command === "add"
      ? AddWireSchema.parse(value)
      : RefreshWireSchema.parse(value);
  return {
    codex_home: session.codex_home,
    name: session.name,
    provider: session.provider,
    renews_at: session.renews_at,
    storage_state_file: session.storage_state_file,
    storage_state_json: normalizeStorageStateJson(session.storage_state_json),
  };
};

const resolveMutationPayload = (
  name: string | undefined,
  options: CommandOptions,
  command: "add" | "refresh" | "remove"
): MutationPayload => {
  const rawPayload = loadRawPayload(options);
  const common = {
    ...rawPayload,
    name: rawPayload?.name ?? name ?? "",
    provider: rawPayload?.provider ?? options.provider,
  };
  const wire = validateMutationWire(
    command,
    command === "remove"
      ? common
      : {
          ...common,
          codex_home: rawPayload?.codex_home ?? options.codexHome,
          renews_at:
            rawPayload && Object.hasOwn(rawPayload, "renews_at")
              ? rawPayload.renews_at
              : options.renewsAt,
          storage_state_file:
            rawPayload?.storage_state_file ?? options.storageStateFile,
          storage_state_json:
            rawPayload?.storage_state_json ?? options.storageStateJson,
        }
  );
  return {
    codex_home: wire.codex_home,
    name: wire.name,
    provider: wire.provider,
    renews_at: normalizeRenewalInput(wire.renews_at),
    storage_state_file: wire.storage_state_file,
    storage_state_json:
      normalizeStorageStateJson(wire.storage_state_json) ??
      getStorageStateJsonEnv(),
  };
};

export const runRemoveCommand = (
  name: string | undefined,
  options: CommandOptions
): CommandResult => {
  ensureAccountNamed("remove", name, options);
  const payload = resolveMutationPayload(name, options, "remove");
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
        deletes: [
          artifacts.accountPath,
          artifacts.storagePath,
          artifacts.profileDir,
        ],
        name: payload.name,
        provider,
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
};

const resolveStorageStateMode = (
  payload: MutationPayload,
  options: CommandOptions
): { filePath?: string; json?: string } | null => {
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
};

export const runAddCommand = async (
  name: string | undefined,
  options: CommandOptions
): Promise<CommandResult> => {
  ensureAccountNamed("add", name, options);
  const payload = resolveMutationPayload(name, options, "add");
  const provider = resolveProvider(payload.provider);
  if (accountExists(payload.name, provider)) {
    throw new CLIError(`Account "${payload.name}" already exists.`, {
      code: "ACCOUNT_EXISTS",
      details: { hint: `Use gauge refresh ${payload.name}` },
      exitCode: 2,
    });
  }

  const storageStateMode = resolveStorageStateMode(payload, options);
  const storageState = validateStorageStateMode(storageStateMode);
  const artifacts = getAccountArtifacts(payload.name, provider);
  const codexHome = payload.codex_home ?? options.codexHome;
  let validatedCodexHome: string | undefined;
  if (provider === "codex") {
    if (!codexHome) {
      throw new CLIError("Codex accounts require codex_home.", {
        code: "CODEX_HOME_REQUIRED",
        details: { hint: "Use --codex-home /path/to/codex-home" },
        exitCode: 2,
      });
    }
    validatedCodexHome = validateCodexHome(codexHome).homePath;
  }
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
        storageStateMode
      )}.\n`,
    };
  }

  if (provider === "codex") {
    createAccount(payload.name, {
      codexHome: validatedCodexHome,
      provider,
      renewsAt: payload.renews_at,
    });
    return {
      command: "add",
      data: {
        account_saved: true,
        action: "add",
        auth_mode: "codex-home",
        name: payload.name,
        provider,
      },
      human: `Account "${payload.name}" added from Codex home.\n`,
    };
  }

  if (storageState) {
    createAccount(payload.name, {
      provider,
      renewsAt: payload.renews_at,
      storageState,
    });
    return {
      command: "add",
      data: {
        account_saved: true,
        action: "add",
        auth_mode: "headless-storage-state",
        name: payload.name,
        provider,
      },
      human: `Account "${payload.name}" added from storage state.\n`,
    };
  }

  const success = await authenticateWithTemporaryProfile(
    provider,
    payload.name,
    options.quiet,
    (storageState, profileSource) => {
      createAccount(payload.name, {
        profileSource,
        provider,
        renewsAt: payload.renews_at,
        storageState,
      });
    }
  );
  if (!success) {
    throw new CLIError(`Failed to add ${provider} account "${payload.name}".`, {
      code: "ADD_FAILED",
      exitCode: 1,
    });
  }
  return {
    command: "add",
    data: {
      account_saved: true,
      action: "add",
      auth_mode: "browser",
      name: payload.name,
      provider,
    },
    human: `✓ Account "${payload.name}" added successfully.\n`,
  };
};

export const runRefreshCommand = async (
  name: string | undefined,
  options: CommandOptions
): Promise<CommandResult> => {
  ensureAccountNamed("refresh", name, options);
  const payload = resolveMutationPayload(name, options, "refresh");
  const provider = resolveProvider(payload.provider);
  if (!accountExists(payload.name, provider)) {
    throw new CLIError(`Account "${payload.name}" not found.`, {
      code: "ACCOUNT_NOT_FOUND",
      details: { hint: `Use gauge add ${payload.name}` },
      exitCode: 2,
    });
  }

  const storageStateMode = resolveStorageStateMode(payload, options);
  const storageState = validateStorageStateMode(storageStateMode);
  const artifacts = getAccountArtifacts(payload.name, provider);
  const writes = refreshWrites(provider, payload, options, artifacts);
  const codexHome = payload.codex_home ?? options.codexHome;
  const validatedCodexHome =
    provider === "codex" && codexHome
      ? validateCodexHome(codexHome).homePath
      : undefined;
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
        storageStateMode
      )}.\n`,
    };
  }

  if (provider === "codex") {
    const updated = codexHome !== undefined || payload.renews_at !== undefined;
    if (updated) {
      refreshAccount(payload.name, {
        ...(validatedCodexHome !== undefined && {
          codexHome: validatedCodexHome,
        }),
        provider,
        renewsAt: payload.renews_at,
      });
    }
    return {
      command: "refresh",
      data: {
        action: "refresh",
        auth_mode: "codex-home",
        name: payload.name,
        provider,
        session_refreshed: updated,
      },
      human: codexHome
        ? `Account "${payload.name}" Codex home updated.\n`
        : codexRefreshGuidance(payload.name),
    };
  }

  if (storageState) {
    refreshAccount(payload.name, {
      provider,
      renewsAt: payload.renews_at,
      storageState,
    });
    return {
      command: "refresh",
      data: {
        action: "refresh",
        auth_mode: "headless-storage-state",
        name: payload.name,
        provider,
        session_refreshed: true,
      },
      human: `Account "${payload.name}" refreshed from storage state.\n`,
    };
  }

  const success = await authenticateWithTemporaryProfile(
    provider,
    payload.name,
    options.quiet,
    (nextStorageState) => {
      refreshAccount(payload.name, {
        provider,
        renewsAt: payload.renews_at,
        storageState: nextStorageState,
      });
    }
  );
  if (!success) {
    throw new CLIError(
      `Failed to refresh ${provider} account "${payload.name}".`,
      {
        code: "REFRESH_FAILED",
        exitCode: 1,
      }
    );
  }

  return {
    command: "refresh",
    data: {
      action: "refresh",
      auth_mode: "browser",
      name: payload.name,
      provider,
      session_refreshed: true,
    },
    human: `✓ Account "${payload.name}" refreshed successfully.\n`,
  };
};
