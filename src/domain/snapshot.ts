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

interface UsageWindow {
  resetsAt: string;
  usedPercent: number;
}

export interface UsageReading {
  email?: string;
  plan: string;
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

export function accountSourceIdKey(id: AccountSourceId): string {
  return "name" in id
    ? `configured:${id.provider}:${id.name}`
    : `ambient:${id.provider}:${id.ambient}`;
}
