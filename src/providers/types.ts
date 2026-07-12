import type { Provider } from "../domain/account.js";
import type {
  AccountSource,
  AccountSourceId,
  PendingCredentialUpdate,
  ProviderError,
  UsageReading,
} from "../domain/snapshot.js";

export type CredentialRefreshPolicy = "refresh-if-stale" | "never";

export interface ProviderAcquisitionContext {
  acquireDirect<T>(operation: () => Promise<T>): Promise<T>;
  credentialRefresh: CredentialRefreshPolicy;
  deadline: number;
  signal: AbortSignal;
}

export type ProviderUsageResult =
  | {
      error?: never;
      sourceId: AccountSourceId;
      usage: UsageReading;
    }
  | {
      error: ProviderError;
      sourceId: AccountSourceId;
      usage?: never;
    };

export interface ProviderAcquisitionResult {
  pendingCredentialUpdates: PendingCredentialUpdate[];
  results: ProviderUsageResult[];
}

export interface UsageProviderAdapter {
  acquire(
    sources: readonly AccountSource[],
    context: ProviderAcquisitionContext,
  ): Promise<ProviderAcquisitionResult>;
  provider: Provider;
}
