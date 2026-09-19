import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountDetails } from "../accounts.js";
import { fetchAllUsage } from "../api.js";
import type { AccountUsage } from "../api.js";
import type { Provider } from "../domain/account.js";
import type {
  AccountSource,
  PendingCredentialUpdate,
  UsageReading,
  UsageWindowKind,
} from "../domain/snapshot.js";
import { fetchCodexAccounts, fetchCursorAccounts } from "../provider-usage.js";
import type { PendingCodexCredentialUpdate } from "../provider-usage.js";
import {
  fetchGrokUsage,
  liveGrokAccount,
  readGrokAccounts,
} from "./grok-usage.js";
import { ProviderUsageReadingSchema } from "./schemas.js";
import type { ProviderUsageResult, UsageProviderAdapter } from "./types.js";
import { fetchZaiUsage, readZaiApiKey } from "./zai-usage.js";

/** One window as a provider reports it, already named for the limit it meters. */
interface NamedWindow {
  kind: UsageWindowKind;
  label?: string;
  resetsAt: string | null;
  usedPercent: number;
}

/**
 * What every provider adapter hands back.
 *
 * `windows` replaced a `session`/`weekly` pair that was flattened into a
 * positional array one step later. Each window now carries its own name, so a
 * provider reporting only one of the two can no longer have it read as the
 * other.
 */
interface ProviderReading {
  email?: string;
  error?: string;
  plan: string;
  resetsApplicable?: number;
  resetsAvailable?: number;
  renewsAt?: string | null;
  windows: NamedWindow[];
}

/**
 * Name the two windows a Codex or Cursor account reports.
 *
 * A window absent from the provider's response is left out; one that is merely
 * idle is kept, because "nothing spent here" is a reading and the recommender
 * needs it to see a wholly free account.
 */
function namedWindows(
  account: {
    session: { resetsAt: string | null; usedPercent: number } | null;
    weekly: { resetsAt: string | null; usedPercent: number } | null;
  },
  [first, second]: readonly [UsageWindowKind, UsageWindowKind]
): NamedWindow[] {
  return [
    account.session ? { ...account.session, kind: first } : null,
    account.weekly ? { ...account.weekly, kind: second } : null,
  ].filter((window): window is NamedWindow => window !== null);
}

function namedCodexWindows(account: {
  monthly: Omit<NamedWindow, "kind"> | null;
  session: Omit<NamedWindow, "kind"> | null;
  weekly: Omit<NamedWindow, "kind"> | null;
}): NamedWindow[] {
  const windows: NamedWindow[] = [];
  if (account.session) {
    windows.push({ ...account.session, kind: "session" });
  }
  if (account.weekly) {
    windows.push({ ...account.weekly, kind: "weekly" });
  }
  if (account.monthly) {
    windows.push({ ...account.monthly, kind: "monthly" });
  }
  return windows;
}

export function buildLocalSources(
  configured: AccountDetails[],
  options: {
    accountFiltered: boolean;
    env?: NodeJS.ProcessEnv;
    home?: string;
    providers: ReadonlySet<string>;
  }
): AccountSource[] {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const sources: AccountSource[] = configured.map((account, order) => ({
    id: { name: account.name, provider: account.provider },
    order,
    provider: account.provider,
    source: "configured",
  }));
  if (options.accountFiltered) {
    return sources;
  }

  if (options.providers.has("codex")) {
    const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
    const configuredHomes = new Set(
      configured
        .filter((account) => account.provider === "codex")
        .map((account) => account.codexHome)
        .filter((value): value is string => value !== undefined)
        .map((value) => path.resolve(value))
    );
    if (
      fs.existsSync(path.join(codexHome, "auth.json")) &&
      !configuredHomes.has(path.resolve(codexHome))
    ) {
      sources.push({
        id: { ambient: "default", provider: "codex" },
        order: sources.length,
        provider: "codex",
        source: "ambient",
      });
    }
  }
  if (
    options.providers.has("cursor") &&
    Boolean(
      env.GAUGE_CURSOR_COOKIE ||
      env.GAUGE_CURSOR_COOKIE_FILE ||
      env.GAUGE_CURSOR_STORAGE_STATE_FILE ||
      env.GAUGE_CURSOR_STORAGE_STATE_JSON
    )
  ) {
    sources.push({
      id: { ambient: "environment", provider: "cursor" },
      order: sources.length,
      provider: "cursor",
      source: "ambient",
    });
  }
  if (options.providers.has("zai") && readZaiApiKey(env) !== null) {
    sources.push({
      id: { ambient: "coding-plan", provider: "zai" },
      order: sources.length,
      provider: "zai",
      source: "ambient",
    });
  }
  if (options.providers.has("grok") && readGrokAccounts().length > 0) {
    sources.push({
      id: { ambient: "build", provider: "grok" },
      order: sources.length,
      provider: "grok",
      source: "ambient",
    });
  }
  return sources;
}

export function createLocalAdapters(
  configured: AccountDetails[]
): UsageProviderAdapter[] {
  const acquireClaudeBrowser = createSerialAcquirer();
  const details = new Map(
    configured.map((account) => [
      `${account.provider}:${account.name}`,
      account,
    ])
  );
  return [
    adapter(
      "claude",
      async (
        source,
        credentialRefresh,
        _onCredentialUpdate,
        onStorageStateUpdate,
        signal
      ) => {
        const account = configuredDetail(source, details);
        const result = await fetchAllUsage(
          [
            {
              authKey: account.authKey,
              name: account.name,
              profileDir: account.profileDir,
              renewsAt: account.renewsAt,
              storagePath: account.storagePath,
            },
          ],
          {
            acquireBrowser: acquireClaudeBrowser,
            credentialRefresh,
            onStorageStateUpdate: (_account, value) => {
              onStorageStateUpdate(value);
            },
            quiet: true,
            signal,
          }
        );
        const usage = result[0];
        return usage ? normalizeClaudeUsage(usage) : null;
      }
    ),
    adapter(
      "codex",
      async (
        source,
        credentialRefresh,
        onCredentialUpdate,
        _onStorageStateUpdate,
        signal
      ) => {
        const account =
          source.source === "configured"
            ? configuredDetail(source, details)
            : undefined;
        const results = await fetchCodexAccounts(account ? [account] : [], {
          credentialRefresh,
          onCredentialUpdate,
          signal,
        });
        const result = results[0];
        if (!result) {
          return null;
        }
        return {
          ...result,
          windows: namedCodexWindows(result),
        };
      }
    ),
    adapter(
      "cursor",
      async (
        source,
        _credentialRefresh,
        _onCredentialUpdate,
        _onStorageStateUpdate,
        signal
      ) => {
        const account =
          source.source === "configured"
            ? configuredDetail(source, details)
            : undefined;
        const results = await fetchCursorAccounts(account ? [account] : [], {
          signal,
        });
        const result = results[0];
        if (!result) {
          return null;
        }
        // Cursor meters a monthly cycle, not a session and a week: the plan's
        // included usage, then anything bought on demand beyond it.
        return {
          ...result,
          windows: namedWindows(result, ["included", "on_demand"]),
        };
      }
    ),
    adapter("zai", async () => {
      const reading = await fetchZaiUsage();
      if (!reading) {
        return null;
      }
      return {
        plan: reading.plan,
        windows: [
          reading.session
            ? { ...reading.session, kind: "session" as const }
            : null,
          reading.monthly
            ? { ...reading.monthly, kind: "monthly" as const }
            : null,
        ].filter((entry): entry is NonNullable<typeof entry> => entry !== null),
      };
    }),
    adapter("grok", async () => {
      const accounts = readGrokAccounts();
      if (accounts.length === 0) {
        return null;
      }
      const live = liveGrokAccount(accounts);
      if (!live) {
        const newest = accounts.at(-1);
        return {
          plan: "Grok Build",
          ...(newest?.email && { email: newest.email }),
          error: "grok/token-expired: run the Grok CLI once to refresh login.",
          windows: [],
        };
      }
      const reading = await fetchGrokUsage(live);
      if (!reading) {
        return null;
      }
      return {
        ...(reading.email && { email: reading.email }),
        plan: reading.plan,
        windows: reading.session
          ? [{ ...reading.session, kind: "session" as const }]
          : [],
      };
    }),
  ];
}

function normalizeClaudeUsage(account: AccountUsage): ProviderReading {
  const planLabels = {
    free: "Free",
    max: "Max",
    max_20x: "Max 20x",
    max_5x: "Max 5x",
    pro: "Pro",
    unknown: "",
  } as const;
  const window = (
    limit: { resets_at: string | null; utilization: number } | null
  ): { resetsAt: string | null; usedPercent: number } | null =>
    limit
      ? { resetsAt: limit.resets_at, usedPercent: limit.utilization }
      : null;
  return {
    plan: planLabels[account.plan],
    renewsAt: account.renewsAt,
    windows: [
      ...namedWindows(
        {
          session: window(account.usage.five_hour),
          weekly: window(account.usage.seven_day),
        },
        ["session", "weekly"]
      ),
      ...(account.usage.scoped ?? []).map((limit) => ({
        kind: "scoped" as const,
        label: limit.model,
        resetsAt: limit.resets_at,
        usedPercent: limit.utilization,
      })),
    ],
    ...(account.error !== undefined && { error: account.error }),
  };
}

function createSerialAcquirer(): <T>(
  operation: () => Promise<T>
) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation);
    tail = current.then(
      () => {},
      () => {}
    );
    return await current;
  };
}

function adapter(
  provider: Provider,
  acquireOne: (
    source: AccountSource,
    credentialRefresh: "refresh-if-stale" | "never",
    onCredentialUpdate: (update: PendingCodexCredentialUpdate) => void,
    onStorageStateUpdate: (value: unknown) => void,
    signal: AbortSignal
  ) => Promise<ProviderReading | null>
): UsageProviderAdapter {
  return {
    async acquire(sources, context) {
      const pendingCredentialUpdates: PendingCredentialUpdate[] = [];
      const results = await Promise.all(
        sources.map(
          async (source) =>
            await context.acquireDirect(
              async (): Promise<ProviderUsageResult> => {
                try {
                  const account = await acquireOne(
                    source,
                    context.credentialRefresh,
                    (update) => {
                      pendingCredentialUpdates.push({
                        kind: "external-credential",
                        provider: "codex",
                        sourceId: source.id,
                        value: update,
                      });
                    },
                    (value) => {
                      pendingCredentialUpdates.push({
                        kind: "storage-state",
                        provider,
                        sourceId: source.id,
                        value,
                      });
                    },
                    context.signal
                  );
                  if (!account) {
                    return failure(
                      source,
                      "Provider returned no account result."
                    );
                  }
                  if (account.error) {
                    return failure(
                      source,
                      `Provider usage acquisition failed: ${reason(account.error)}`
                    );
                  }
                  return {
                    sourceId: source.id,
                    usage: toUsageReading(account),
                  };
                } catch (error) {
                  return failure(
                    source,
                    `Provider usage acquisition failed: ${reason(error)}`
                  );
                }
              }
            )
        )
      );
      return { pendingCredentialUpdates, results };
    },
    provider,
  };
}

function configuredDetail(
  source: AccountSource,
  details: Map<string, AccountDetails>
): AccountDetails {
  if (!("name" in source.id)) {
    throw new Error("Ambient source has no configured account details.");
  }
  const detail = details.get(`${source.provider}:${source.id.name}`);
  if (!detail) {
    throw new Error("Configured account details are missing.");
  }
  return detail;
}

/**
 * A short, safe reason for a provider failure.
 *
 * Both failure paths above used to discard what they knew: one dropped
 * `account.error` on the floor and the other caught with no binding at all, so
 * every provider fault in the product arrived as the same eleven words. That is
 * a dead end for the reader — the dashboard's own remedy for a broken account is
 * a `gauge refresh`, and when the fault is upstream of gauge that command
 * succeeds and changes nothing, leaving no way to find out why.
 *
 * Trimmed to a single line and capped, because this reaches human output and a
 * provider is free to answer with an entire HTML page. Sanitization still runs
 * over the result; this only makes sure there is something in it worth
 * sanitizing.
 */
function reason(cause: unknown): string {
  const text =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string"
        ? cause
        : typeof cause === "object" && cause !== null && "message" in cause
          ? String(cause.message)
          : String(cause);
  const line = text.replaceAll(/\s+/gu, " ").trim();
  if (line === "") {
    return "no reason given";
  }
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function failure(source: AccountSource, message: string): ProviderUsageResult {
  return {
    error: { code: "provider/failure", message, retryable: true },
    sourceId: source.id,
  };
}

function toUsageReading(account: ProviderReading): UsageReading {
  return ProviderUsageReadingSchema.parse({
    plan: account.plan,
    windows: account.windows,
    ...(account.email && { email: account.email }),
    ...(account.resetsApplicable !== undefined && {
      resetsApplicable: account.resetsApplicable,
    }),
    ...(account.resetsAvailable !== undefined && {
      resetsAvailable: account.resetsAvailable,
    }),
    ...(account.renewsAt !== undefined && { renewsAt: account.renewsAt }),
  });
}
