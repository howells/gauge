import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountDetails } from "../accounts.js";
import { type AccountUsage, fetchAllUsage } from "../api.js";
import type {
  AccountSource,
  PendingCredentialUpdate,
  UsageReading,
} from "../domain/snapshot.js";
import {
  fetchCodexAccounts,
  fetchCursorAccounts,
  type PendingCodexCredentialUpdate,
} from "../provider-usage.js";
import { ProviderUsageReadingSchema } from "./schemas.js";
import type { ProviderUsageResult, UsageProviderAdapter } from "./types.js";

export function buildLocalSources(
  configured: AccountDetails[],
  options: {
    accountFiltered: boolean;
    env?: NodeJS.ProcessEnv;
    home?: string;
    providers: ReadonlySet<string>;
  },
): AccountSource[] {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const sources: AccountSource[] = configured.map((account, order) => ({
    id: { provider: account.provider, name: account.name },
    order,
    provider: account.provider,
    source: "configured",
  }));
  if (options.accountFiltered) return sources;

  if (options.providers.has("codex")) {
    const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
    const configuredHomes = new Set(
      configured
        .filter((account) => account.provider === "codex")
        .map((account) => account.codexHome)
        .filter((value): value is string => value !== undefined)
        .map((value) => path.resolve(value)),
    );
    if (
      fs.existsSync(path.join(codexHome, "auth.json")) &&
      !configuredHomes.has(path.resolve(codexHome))
    ) {
      sources.push({
        id: { provider: "codex", ambient: "default" },
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
        env.GAUGE_CURSOR_STORAGE_STATE_JSON,
    )
  ) {
    sources.push({
      id: { provider: "cursor", ambient: "environment" },
      order: sources.length,
      provider: "cursor",
      source: "ambient",
    });
  }
  return sources;
}

export function createLocalAdapters(
  configured: AccountDetails[],
): UsageProviderAdapter[] {
  const acquireClaudeBrowser = createSerialAcquirer();
  const details = new Map(
    configured.map((account) => [
      `${account.provider}:${account.name}`,
      account,
    ]),
  );
  return [
    adapter(
      "claude",
      async (
        source,
        credentialRefresh,
        _onCredentialUpdate,
        onStorageStateUpdate,
        signal,
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
            quiet: true,
            signal,
            onStorageStateUpdate: (_account, value) => {
              onStorageStateUpdate(value);
            },
          },
        );
        const usage = result[0];
        return usage ? normalizeClaudeUsage(usage) : null;
      },
    ),
    adapter(
      "codex",
      async (
        source,
        credentialRefresh,
        onCredentialUpdate,
        _onStorageStateUpdate,
        signal,
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
        return results[0] ?? null;
      },
    ),
    adapter(
      "cursor",
      async (
        source,
        _credentialRefresh,
        _onCredentialUpdate,
        _onStorageStateUpdate,
        signal,
      ) => {
        const account =
          source.source === "configured"
            ? configuredDetail(source, details)
            : undefined;
        const results = await fetchCursorAccounts(account ? [account] : [], {
          signal,
        });
        return results[0] ?? null;
      },
    ),
  ];
}

function normalizeClaudeUsage(account: AccountUsage): {
  error?: string;
  plan: string;
  renewsAt?: string | null;
  session: { resetsAt: string; usedPercent: number } | null;
  weekly: { resetsAt: string; usedPercent: number } | null;
} {
  const planLabels = {
    free: "Free",
    pro: "Pro",
    max: "Max",
    max_5x: "Max 5x",
    max_20x: "Max 20x",
    unknown: "",
  } as const;
  return {
    plan: planLabels[account.plan],
    renewsAt: account.renewsAt,
    session: account.usage.five_hour
      ? {
          resetsAt: account.usage.five_hour.resets_at,
          usedPercent: account.usage.five_hour.utilization,
        }
      : null,
    weekly: account.usage.seven_day
      ? {
          resetsAt: account.usage.seven_day.resets_at,
          usedPercent: account.usage.seven_day.utilization,
        }
      : null,
    ...(account.error !== undefined && { error: account.error }),
  };
}

function createSerialAcquirer(): <T>(
  operation: () => Promise<T>,
) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation, operation);
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}

function adapter(
  provider: "claude" | "codex" | "cursor",
  acquireOne: (
    source: AccountSource,
    credentialRefresh: "refresh-if-stale" | "never",
    onCredentialUpdate: (update: PendingCodexCredentialUpdate) => void,
    onStorageStateUpdate: (value: unknown) => void,
    signal: AbortSignal,
  ) => Promise<{
    email?: string;
    error?: string;
    plan: string;
    renewsAt?: string | null;
    session: { resetsAt: string; usedPercent: number } | null;
    weekly: { resetsAt: string; usedPercent: number } | null;
  } | null>,
): UsageProviderAdapter {
  return {
    provider,
    async acquire(sources, context) {
      const pendingCredentialUpdates: PendingCredentialUpdate[] = [];
      const results = await Promise.all(
        sources.map((source) =>
          context.acquireDirect(async (): Promise<ProviderUsageResult> => {
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
                context.signal,
              );
              if (!account) {
                return failure(source, "Provider returned no account result.");
              }
              if (account.error) {
                return failure(
                  source,
                  `Provider usage acquisition failed: ${reason(account.error)}`,
                );
              }
              return {
                sourceId: source.id,
                usage: toUsageReading(account),
              };
            } catch (error) {
              return failure(
                source,
                `Provider usage acquisition failed: ${reason(error)}`,
              );
            }
          }),
        ),
      );
      return { pendingCredentialUpdates, results };
    },
  };
}

function configuredDetail(
  source: AccountSource,
  details: Map<string, AccountDetails>,
): AccountDetails {
  if (!("name" in source.id)) {
    throw new Error("Ambient source has no configured account details.");
  }
  const detail = details.get(`${source.provider}:${source.id.name}`);
  if (!detail) throw new Error("Configured account details are missing.");
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
          ? String((cause as { message: unknown }).message)
          : String(cause);
  const line = text.replace(/\s+/gu, " ").trim();
  if (line === "") return "no reason given";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function failure(source: AccountSource, message: string): ProviderUsageResult {
  return {
    error: { code: "provider/failure", message, retryable: true },
    sourceId: source.id,
  };
}

function toUsageReading(account: {
  email?: string;
  plan: string;
  renewsAt?: string | null;
  session: { resetsAt: string; usedPercent: number } | null;
  weekly: { resetsAt: string; usedPercent: number } | null;
}): UsageReading {
  return ProviderUsageReadingSchema.parse({
    plan: account.plan,
    windows: [account.session, account.weekly].filter(
      (window): window is NonNullable<typeof window> => window !== null,
    ),
    ...(account.email && { email: account.email }),
    ...(account.renewsAt !== undefined && { renewsAt: account.renewsAt }),
  });
}
