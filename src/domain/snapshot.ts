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

/**
 * Which limit a usage window measures.
 *
 * Carried on the window itself rather than inferred from its position in the
 * array. Position was the old contract and it could not survive an absent
 * window: drop one and every later window inherits a meaning that belongs to
 * its neighbour — which is how a seven-day figure came to be drawn as a
 * five-hour session. A name cannot slide.
 *
 * `session` and `weekly` are the short and long horizons Claude and Codex both
 * meter. Cursor has neither — it bills a monthly cycle — so its two readings
 * are named for what they are: the plan's included usage, and anything bought
 * on demand beyond it.
 */
export const USAGE_WINDOW_KINDS = [
  "session",
  "weekly",
  "included",
  "on_demand",
] as const;

export type UsageWindowKind = (typeof USAGE_WINDOW_KINDS)[number];

interface UsageWindow {
  kind: UsageWindowKind;
  /** Null when the window is idle: nothing spent, so nothing counting down. */
  resetsAt: string | null;
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
