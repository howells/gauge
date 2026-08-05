import {
  type RecommendationCandidate,
  recommendUsage,
} from "../domain/recommendation.js";
import type { AccountSnapshot, UsageSnapshot } from "../domain/snapshot.js";
import type { CommandResult } from "../output.js";
import {
  renderQuickRecommendation,
  renderStatusDashboard,
} from "./render-status.js";

export interface StatusResultOptions {
  now: Date;
  quick: boolean;
}

/** Render one usage snapshot consistently for every CLI presentation mode. */
export function buildStatusResult(
  snapshot: UsageSnapshot,
  options: StatusResultOptions,
): CommandResult {
  const presented = presentAccounts(snapshot.accounts);
  const recommendation = recommendUsage(
    presented.map(toRecommendationCandidate),
    options.now,
  );
  const result = classifySnapshot(snapshot);
  const accounts = presented.map(({ account, name }) => ({
    name,
    provider: account.source.provider,
    source: account.source.source,
    usage: account.usage,
    error: account.error,
  }));
  const data = options.quick
    ? { recommendation, summary: snapshot.summary }
    : { accounts, recommendation, summary: snapshot.summary };

  return {
    command: "status",
    data,
    exitCode: result === "failed" ? 1 : 0,
    human: options.quick
      ? renderQuickRecommendation(recommendation, options.now)
      : renderStatusDashboard(accounts, recommendation, options.now),
    ok: result !== "failed",
    ...(!options.quick && {
      paginated: {
        itemName: "accounts",
        items: accounts,
        summary: { recommendation, summary: snapshot.summary },
      },
    }),
    result,
  };
}

interface PresentedAccount {
  account: AccountSnapshot;
  name: string;
}

/**
 * Resolve display identities for the snapshot's accounts.
 *
 * Ambient accounts (auto-discovered credentials such as ~/.codex) have no
 * configured name. When one resolves to the same signed-in identity as a
 * configured account it is a duplicate reading of the same account and is
 * dropped; otherwise it is named from its email domain the way configured
 * account names conventionally are, falling back to the ambient key.
 */
function presentAccounts(accounts: AccountSnapshot[]): PresentedAccount[] {
  const configuredIdentities = new Set(
    accounts.flatMap((account) =>
      account.source.source === "configured" && account.usage?.email
        ? [`${account.source.provider}\0${account.usage.email}`]
        : [],
    ),
  );
  return accounts
    .filter(
      (account) =>
        account.source.source !== "ambient" ||
        !account.usage?.email ||
        !configuredIdentities.has(
          `${account.source.provider}\0${account.usage.email}`,
        ),
    )
    .map((account) => ({ account, name: displayName(account) }));
}

function displayName(account: AccountSnapshot): string {
  if ("name" in account.source.id) return account.source.id.name;
  const email = account.usage?.email;
  if (email) {
    const domain = email.split("@")[1] ?? email;
    return domain.split(".")[0] ?? email;
  }
  return account.source.id.ambient;
}

function toRecommendationCandidate(
  { account, name }: PresentedAccount,
  index: number,
): RecommendationCandidate {
  return {
    id: {
      provider: account.source.provider,
      name,
    },
    order: index,
    windows: account.usage?.windows ?? [],
    // Carried so the policy can tell a Max 20x from a free tier. It never
    // reorders the recommendation — see `findWaitFor`.
    ...(account.usage?.plan && { plan: account.usage.plan }),
    ...(account.error && { error: account.error }),
  };
}

function classifySnapshot(
  snapshot: UsageSnapshot,
): "complete" | "failed" | "partial" {
  if (snapshot.summary.total > 0 && snapshot.summary.succeeded === 0) {
    return "failed";
  }
  return snapshot.summary.failed > 0 ? "partial" : "complete";
}
