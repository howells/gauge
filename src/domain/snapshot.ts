import type { AccountId, Provider } from "./account.js";

interface AmbientAccountId {
  ambient: string;
  provider: Provider;
}

export type AccountSource =
  | {
      id: AccountId;
      order: number;
      provider: Provider;
      source: "configured";
    }
  | {
      id: AmbientAccountId;
      order: number;
      provider: Provider;
      source: "ambient";
    };

export type AccountSourceId = AccountSource["id"];

export interface ProviderError {
  code: string;
  message: string;
  retryable: boolean;
}

export const USAGE_WINDOW_KINDS = [
  "session",
  "weekly",
  "monthly",
  "included",
  "on_demand",
  "scoped",
] as const;

export type UsageWindowKind = (typeof USAGE_WINDOW_KINDS)[number];

interface UsageWindow {
  kind: UsageWindowKind;
  /** Provider-owned scope name when this window applies to one model pool. */
  label?: string;
  /** Null when the window is idle: nothing spent, so nothing counting down. */
  resetsAt: string | null;
  usedPercent: number;
}

export interface UsageReading {
  email?: string;
  plan: string;
  /**
   * Codex usage-limit resets: `resetsApplicable` of the `resetsAvailable`
   * held apply to the account's current usage state, and redeeming one
   * clears the spent limits at once. Absent where a provider has no such
   * concept.
   */
  resetsApplicable?: number;
  resetsAvailable?: number;
  renewsAt?: string | null;
  windows: UsageWindow[];
}

export interface PendingCredentialUpdate {
  kind: "external-credential" | "storage-state";
  provider: Provider;
  sourceId: AccountSourceId;
  value: unknown;
}

export type AccountSnapshot =
  | {
      error: null;
      source: AccountSource;
      usage: UsageReading;
    }
  | {
      error: ProviderError;
      source: AccountSource;
      usage: null;
    };

interface SnapshotSummary {
  failed: number;
  succeeded: number;
  timed_out: number;
  total: number;
}

export interface UsageSnapshot {
  accounts: AccountSnapshot[];
  generatedAt: string;
  pendingCredentialUpdates: PendingCredentialUpdate[];
  summary: SnapshotSummary;
}

export const accountSourceIdKey = (id: AccountSourceId): string =>
  "name" in id
    ? `configured:${id.provider}:${id.name}`
    : `ambient:${id.provider}:${id.ambient}`;
