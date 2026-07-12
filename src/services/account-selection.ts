import type { AccountId, Provider } from "../domain/account.js";
import { CLIError } from "../security.js";

interface ConfiguredAccount {
  id: AccountId;
  order: number;
}

export interface AccountFilter {
  account?: string;
  provider?: Provider;
}

/** Resolve status filters against configured identities before network work. */
export function selectConfiguredAccounts<T extends ConfiguredAccount>(
  accounts: readonly T[],
  filter: AccountFilter,
): T[] {
  const providerMatches = filter.provider
    ? accounts.filter((account) => account.id.provider === filter.provider)
    : [...accounts];
  if (!filter.account) {
    return providerMatches;
  }

  const matches = providerMatches.filter(
    (account) => account.id.name === filter.account,
  );
  if (matches.length === 1) {
    return matches;
  }
  if (matches.length > 1) {
    throw new CLIError(`Account name "${filter.account}" is ambiguous.`, {
      code: "AMBIGUOUS_ACCOUNT",
      exitCode: 2,
      details: {
        candidates: matches.map(
          (account) => `${account.id.provider}:${account.id.name}`,
        ),
      },
    });
  }
  throw new CLIError(`Configured account "${filter.account}" was not found.`, {
    code: "ACCOUNT_NOT_FOUND",
    exitCode: 2,
  });
}
