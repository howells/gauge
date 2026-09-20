import type { Provider } from "../domain/account.js";
import { accountSourceIdKey } from "../domain/snapshot.js";
import type {
  AccountSnapshot,
  AccountSource,
  PendingCredentialUpdate,
  UsageSnapshot,
} from "../domain/snapshot.js";
import type {
  CredentialRefreshPolicy,
  ProviderAcquisitionContext,
  ProviderAcquisitionResult,
  UsageProviderAdapter,
} from "../providers/types.js";

const PROVIDER_ORDER: Provider[] = ["claude", "codex", "cursor", "zai", "grok"];

interface UsageServiceOptions {
  adapters: UsageProviderAdapter[];
  cleanupGraceMs?: number;
  deadlineMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

interface CollectOptions {
  credentialRefresh: CredentialRefreshPolicy;
}

const failureSnapshot = (
  source: AccountSource,
  code: string,
  message: string,
  retryable: boolean
): AccountSnapshot => ({
  error: { code, message, retryable },
  source,
  usage: null,
});

const scheduleTimeout = (
  callback: () => void,
  delayMs: number
): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  return () => {
    clearTimeout(timer);
  };
};

const abortError = (): Error => {
  const error = new Error("Provider acquisition was aborted.");
  error.name = "AbortError";
  return error;
};

class DirectAcquisitionLimiter {
  #active = 0;
  readonly #limit: number;
  readonly #queue: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      let queued = true;
      const abort = (): void => {
        if (!queued) {
          return;
        }
        const index = this.#queue.indexOf(start);
        if (index !== -1) {
          this.#queue.splice(index, 1);
        }
        queued = false;
        reject(abortError());
      };
      const start = (): void => {
        queued = false;
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          reject(abortError());
          this.#drain();
          return;
        }
        this.#active += 1;
        Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            this.#active -= 1;
            this.#drain();
          });
      };

      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      this.#queue.push(start);
      this.#drain();
    });
  }

  #drain(): void {
    while (this.#active < this.#limit) {
      const start = this.#queue.shift();
      if (!start) {
        return;
      }
      start();
    }
  }
}

const compareSources = (left: AccountSource, right: AccountSource): number => {
  const providerOrder =
    PROVIDER_ORDER.indexOf(left.provider) -
    PROVIDER_ORDER.indexOf(right.provider);
  if (providerOrder !== 0) {
    return providerOrder;
  }
  if (left.source !== right.source) {
    return left.source === "configured" ? -1 : 1;
  }
  return left.order - right.order;
};

const isValidAdapterResult = (
  sources: readonly AccountSource[],
  result: ProviderAcquisitionResult
): boolean =>
  result.results.length === sources.length &&
  result.results.every((entry, index) => {
    const source = sources[index];
    return (
      source !== undefined &&
      accountSourceIdKey(entry.sourceId) === accountSourceIdKey(source.id)
    );
  });

export class UsageService {
  readonly #adapters: Map<Provider, UsageProviderAdapter>;
  readonly #cleanupGraceMs: number;
  readonly #deadlineMs: number;
  readonly #now: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => () => void;

  constructor(options: UsageServiceOptions) {
    this.#adapters = new Map(
      options.adapters.map((adapter) => [adapter.provider, adapter])
    );
    this.#cleanupGraceMs = options.cleanupGraceMs ?? 250;
    this.#deadlineMs = options.deadlineMs ?? 15_000;
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? scheduleTimeout;
  }

  async collect(
    sources: readonly AccountSource[],
    options: CollectOptions
  ): Promise<UsageSnapshot> {
    const orderedSources = [...sources].sort(compareSources);
    const directAcquisitions = new DirectAcquisitionLimiter(4);
    const outcomes = await Promise.all(
      orderedSources.map(async (source) => {
        const adapter = this.#adapters.get(source.provider);
        if (!adapter) {
          return {
            account: failureSnapshot(
              source,
              "provider/adapter-missing",
              "Provider adapter is not available.",
              false
            ),
            pendingCredentialUpdates: [] as PendingCredentialUpdate[],
          };
        }
        const controller = new AbortController();
        const context: ProviderAcquisitionContext = {
          acquireDirect: async (operation) =>
            await directAcquisitions.run(operation, controller.signal),
          credentialRefresh: options.credentialRefresh,
          deadline: this.#now() + this.#deadlineMs,
          signal: controller.signal,
        };
        let cancelTimeout = (): void => undefined;
        const acquisition = adapter.acquire([source], context).then(
          (result) => ({ kind: "result" as const, result }),
          () => ({ kind: "error" as const })
        );
        const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
          cancelTimeout = this.#schedule(() => {
            controller.abort();
            resolve({ kind: "timeout" });
          }, this.#deadlineMs);
        });
        const outcome = await Promise.race([acquisition, timeout]);
        cancelTimeout();
        if (outcome.kind === "timeout") {
          await Promise.race([
            acquisition.then(() => {}),
            new Promise<void>((resolve) =>
              setTimeout(resolve, this.#cleanupGraceMs)
            ),
          ]);
          return {
            account: failureSnapshot(
              source,
              "provider/timeout",
              "Provider request timed out.",
              true
            ),
            pendingCredentialUpdates: [] as PendingCredentialUpdate[],
          };
        }
        if (outcome.kind === "error") {
          return {
            account: failureSnapshot(
              source,
              "provider/acquisition-failed",
              "Provider request failed.",
              true
            ),
            pendingCredentialUpdates: [] as PendingCredentialUpdate[],
          };
        }
        const { result } = outcome;
        if (!isValidAdapterResult([source], result)) {
          return {
            account: failureSnapshot(
              source,
              "provider/contract-violation",
              "Provider adapter violated the ordered result contract.",
              false
            ),
            pendingCredentialUpdates: [] as PendingCredentialUpdate[],
          };
        }
        const entry = result.results[0];
        if (!entry) {
          throw new Error("Provider returned no result.");
        }
        return {
          account: entry.error
            ? { error: entry.error, source, usage: null }
            : { error: null, source, usage: entry.usage },
          pendingCredentialUpdates: result.pendingCredentialUpdates,
        };
      })
    );
    const accounts = outcomes.map((outcome) => outcome.account);
    const pendingCredentialUpdates = outcomes.flatMap(
      (outcome) => outcome.pendingCredentialUpdates
    );

    const failed = accounts.filter((account) => account.error !== null).length;
    const timedOut = accounts.filter(
      (account) => account.error?.code === "provider/timeout"
    ).length;
    return {
      accounts,
      generatedAt: new Date(this.#now()).toISOString(),
      pendingCredentialUpdates,
      summary: {
        failed,
        succeeded: accounts.length - failed,
        timed_out: timedOut,
        total: accounts.length,
      },
    };
  }
}
