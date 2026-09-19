import type { CommandResult } from "../output.js";

export interface ServedSnapshot {
  /** Epoch ms when the underlying collection finished. */
  fetchedAt: number;
  result: CommandResult;
}

export interface SnapshotCacheOptions {
  fetch: () => Promise<CommandResult>;
  /** Minimum age before a poll is allowed to trigger a new collection. */
  minAgeMs?: number;
  now?: () => number;
}

/**
 * Cache the status result between dashboard polls.
 *
 * A collection fans out to every provider upstream, so it must never run per
 * browser request. The first poll always collects; later polls return the
 * cached result immediately and kick off exactly one background refresh when
 * the cached reading is older than `minAgeMs`. No timer runs while nobody is
 * looking, so the dashboard makes no network calls when it is closed.
 */
export class StatusSnapshotCache {
  readonly #fetch: () => Promise<CommandResult>;
  #inflight: Promise<void> | null = null;
  #last: ServedSnapshot | null = null;
  readonly #minAgeMs: number;
  readonly #now: () => number;

  constructor(options: SnapshotCacheOptions) {
    this.#fetch = options.fetch;
    this.#minAgeMs = options.minAgeMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  async get(): Promise<ServedSnapshot> {
    if (this.#last === null) {
      await this.#refresh();
      if (this.#last !== null) {
        return this.#last;
      }
      throw new Error("Snapshot collection produced no result.");
    }
    const age = this.#now() - this.#last.fetchedAt;
    if (age >= this.#minAgeMs) {
      void this.#refresh();
    }
    return this.#last;
  }

  peek(): ServedSnapshot | null {
    return this.#last;
  }

  async #refresh(): Promise<void> {
    if (this.#inflight !== null) {
      await this.#inflight;
      return;
    }
    const run = async (): Promise<void> => {
      try {
        const result = await this.#fetch();
        this.#last = { fetchedAt: this.#now(), result };
      } finally {
        this.#inflight = null;
      }
    };
    this.#inflight = run();
    await this.#inflight;
  }
}
