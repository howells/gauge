import assert from "node:assert/strict";
import { test } from "node:test";

import type { AccountSource } from "../src/domain/snapshot.js";
import type {
  ProviderAcquisitionContext,
  UsageProviderAdapter,
} from "../src/providers/types.js";
import { UsageService } from "../src/services/usage-service.js";

test("collects an ordered result and returns pending credential updates", async () => {
  const source: AccountSource = {
    id: { name: "work", provider: "codex" },
    order: 0,
    provider: "codex",
    source: "configured",
  };
  let receivedContext: ProviderAcquisitionContext | undefined;
  const adapter: UsageProviderAdapter = {
    acquire: async (sources, context) => {
      receivedContext = context;
      return {
        pendingCredentialUpdates: [
          {
            sourceId: source.id,
            provider: "codex",
            kind: "external-credential",
            value: { accessToken: "new" },
          },
        ],
        results: sources.map((item) => ({
          sourceId: item.id,
          usage: { plan: "Pro", windows: [] },
        })),
      };
    },
    provider: "codex",
  };
  const service = new UsageService({
    adapters: [adapter],
    now: () => 1000,
  });

  const snapshot = await service.collect([source], {
    credentialRefresh: "never",
  });

  assert.equal(receivedContext?.credentialRefresh, "never");
  assert.equal(receivedContext?.deadline, 16_000);
  assert.equal(snapshot.accounts[0]?.source, source);
  assert.equal(snapshot.accounts[0]?.usage?.plan, "Pro");
  assert.equal(snapshot.pendingCredentialUpdates.length, 1);
  assert.deepEqual(snapshot.summary, {
    failed: 0,
    succeeded: 1,
    timed_out: 0,
    total: 1,
  });
});

test("starts provider groups concurrently", async () => {
  const started: string[] = [];
  let releaseClaude: (() => void) | undefined;
  const claudeGate = new Promise<void>((resolve) => {
    releaseClaude = resolve;
  });
  const adapter = (provider: "claude" | "codex"): UsageProviderAdapter => ({
    acquire: async (sources) => {
      started.push(provider);
      if (provider === "claude") {
        await claudeGate;
      }
      return {
        pendingCredentialUpdates: [],
        results: sources.map((source) => ({
          sourceId: source.id,
          usage: { plan: provider, windows: [] },
        })),
      };
    },
    provider,
  });
  const service = new UsageService({
    adapters: [adapter("claude"), adapter("codex")],
  });
  const collection = service.collect(
    [
      {
        id: { name: "one", provider: "claude" },
        order: 0,
        provider: "claude",
        source: "configured",
      },
      {
        id: { name: "two", provider: "codex" },
        order: 0,
        provider: "codex",
        source: "configured",
      },
    ],
    { credentialRefresh: "refresh-if-stale" }
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  const bothStartedBeforeRelease = started.length === 2;
  releaseClaude?.();
  await collection;

  assert.equal(bothStartedBeforeRelease, true);
});

test("orders providers and places configured sources before ambient sources", async () => {
  const adapters: UsageProviderAdapter[] = ["claude", "codex", "cursor"].map(
    (provider) => ({
      acquire: async (sources) => ({
        pendingCredentialUpdates: [],
        results: sources.map((source) => ({
          sourceId: source.id,
          usage: { plan: source.source, windows: [] },
        })),
      }),
      provider: provider as UsageProviderAdapter["provider"],
    })
  );
  const service = new UsageService({ adapters });

  const snapshot = await service.collect(
    [
      {
        id: { ambient: "env", provider: "cursor" },
        order: 0,
        provider: "cursor",
        source: "ambient",
      },
      {
        id: { ambient: "browser", provider: "claude" },
        order: -1,
        provider: "claude",
        source: "ambient",
      },
      {
        id: { name: "second", provider: "codex" },
        order: 1,
        provider: "codex",
        source: "configured",
      },
      {
        id: { name: "first", provider: "claude" },
        order: 0,
        provider: "claude",
        source: "configured",
      },
      {
        id: { name: "first", provider: "codex" },
        order: 0,
        provider: "codex",
        source: "configured",
      },
    ],
    { credentialRefresh: "refresh-if-stale" }
  );

  assert.deepEqual(
    snapshot.accounts.map((account) => account.source.id),
    [
      { name: "first", provider: "claude" },
      { ambient: "browser", provider: "claude" },
      { name: "first", provider: "codex" },
      { name: "second", provider: "codex" },
      { ambient: "env", provider: "cursor" },
    ]
  );
});

test("turns adapter count or order violations into typed internal failures", async () => {
  const sources: AccountSource[] = [
    {
      id: { name: "first", provider: "codex" },
      order: 0,
      provider: "codex",
      source: "configured",
    },
    {
      id: { name: "second", provider: "codex" },
      order: 1,
      provider: "codex",
      source: "configured",
    },
  ];
  const adapter: UsageProviderAdapter = {
    acquire: async () => ({
      pendingCredentialUpdates: [
        {
          sourceId: sources[0]?.id ?? { provider: "codex", name: "first" },
          provider: "codex",
          kind: "external-credential",
          value: "untrusted-after-contract-violation",
        },
      ],
      results: [...sources].reverse().map((source) => ({
        sourceId: source.id,
        usage: { plan: source.id.provider, windows: [] },
      })),
    }),
    provider: "codex",
  };
  const service = new UsageService({ adapters: [adapter] });

  const snapshot = await service.collect(sources, {
    credentialRefresh: "refresh-if-stale",
  });

  assert.deepEqual(
    snapshot.accounts.map((account) => account.error?.code),
    ["provider/contract-violation", "provider/contract-violation"]
  );
  assert.equal(snapshot.pendingCredentialUpdates.length, 0);
  assert.deepEqual(snapshot.summary, {
    failed: 2,
    succeeded: 0,
    timed_out: 0,
    total: 2,
  });
});

test("returns typed timeouts when an adapter never settles", async () => {
  let adapterSignal: AbortSignal | undefined;
  const adapter: UsageProviderAdapter = {
    acquire: async (_sources, context) => {
      adapterSignal = context.signal;
      return await new Promise(() => {});
    },
    provider: "claude",
  };
  const service = new UsageService({
    adapters: [adapter],
    cleanupGraceMs: 5,
    deadlineMs: 20,
  });

  let guard: ReturnType<typeof setTimeout> | undefined;
  const snapshot = await Promise.race([
    service.collect(
      [
        {
          id: { name: "work", provider: "claude" },
          order: 0,
          provider: "claude",
          source: "configured",
        },
      ],
      { credentialRefresh: "refresh-if-stale" }
    ),
    new Promise<never>((_resolve, reject) => {
      guard = setTimeout(() => {
        reject(new Error("usage service remained pending"));
      }, 250);
    }),
  ]);
  clearTimeout(guard);

  assert.equal(adapterSignal?.aborted, true);
  assert.deepEqual(snapshot.accounts[0]?.error, {
    code: "provider/timeout",
    message: "Provider request timed out.",
    retryable: true,
  });
  assert.deepEqual(snapshot.summary, {
    failed: 1,
    succeeded: 0,
    timed_out: 1,
    total: 1,
  });
});

test("a timed-out source does not discard a completed peer from the same provider", async () => {
  const adapter: UsageProviderAdapter = {
    acquire: async (sources) => {
      const source = sources[0];
      if (!source) {
        throw new Error("missing source");
      }
      if ("name" in source.id && source.id.name === "hung") {
        return await new Promise(() => {});
      }
      return {
        pendingCredentialUpdates: [],
        results: [
          {
            sourceId: source.id,
            usage: { plan: "Max", windows: [] },
          },
        ],
      };
    },
    provider: "claude",
  };
  const service = new UsageService({
    adapters: [adapter],
    cleanupGraceMs: 5,
    deadlineMs: 20,
  });

  const snapshot = await service.collect(
    [
      {
        id: { name: "hung", provider: "claude" },
        order: 0,
        provider: "claude",
        source: "configured",
      },
      {
        id: { name: "ready", provider: "claude" },
        order: 1,
        provider: "claude",
        source: "configured",
      },
    ],
    { credentialRefresh: "refresh-if-stale" }
  );

  assert.equal(snapshot.accounts[0]?.error?.code, "provider/timeout");
  assert.equal(snapshot.accounts[1]?.usage?.plan, "Max");
  assert.deepEqual(snapshot.summary, {
    failed: 1,
    succeeded: 1,
    timed_out: 1,
    total: 2,
  });
});

test("timeout waits for cooperative provider cleanup before returning", async () => {
  let cleaned = false;
  const adapter: UsageProviderAdapter = {
    acquire: async (sources, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          {
            once: true,
          }
        );
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      cleaned = true;
      return {
        pendingCredentialUpdates: [],
        results: sources.map((source) => ({
          sourceId: source.id,
          usage: { plan: "late", windows: [] },
        })),
      };
    },
    provider: "claude",
  };
  const service = new UsageService({
    adapters: [adapter],
    cleanupGraceMs: 50,
    deadlineMs: 10,
  });

  const snapshot = await service.collect(
    [
      {
        id: { name: "work", provider: "claude" },
        order: 0,
        provider: "claude",
        source: "configured",
      },
    ],
    { credentialRefresh: "refresh-if-stale" }
  );

  assert.equal(cleaned, true);
  assert.equal(snapshot.accounts[0]?.error?.code, "provider/timeout");
});

test("caps direct acquisitions at four globally across provider groups", async () => {
  let active = 0;
  let maximum = 0;
  const adapters: UsageProviderAdapter[] = ["claude", "codex", "cursor"].map(
    (provider) => ({
      acquire: async (sources, context) => {
        await Promise.all(
          sources.map(async () => {
            await context.acquireDirect(async () => {
              active += 1;
              maximum = Math.max(maximum, active);
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              active -= 1;
            });
          })
        );
        return {
          pendingCredentialUpdates: [],
          results: sources.map((source) => ({
            sourceId: source.id,
            usage: { plan: provider, windows: [] },
          })),
        };
      },
      provider: provider as UsageProviderAdapter["provider"],
    })
  );
  const sources: AccountSource[] = adapters.flatMap((adapter) =>
    [0, 1, 2].map((order) => ({
      id: { name: `account-${order}`, provider: adapter.provider },
      order,
      provider: adapter.provider,
      source: "configured" as const,
    }))
  );
  const service = new UsageService({ adapters });

  await service.collect(sources, {
    credentialRefresh: "refresh-if-stale",
  });

  assert.equal(maximum, 4);
});

test("represents sources with no registered adapter as typed failures", async () => {
  const service = new UsageService({ adapters: [] });

  const snapshot = await service.collect(
    [
      {
        id: { ambient: "environment", provider: "cursor" },
        order: 0,
        provider: "cursor",
        source: "ambient",
      },
    ],
    { credentialRefresh: "never" }
  );

  assert.equal(snapshot.accounts[0]?.error?.code, "provider/adapter-missing");
  assert.deepEqual(snapshot.summary, {
    failed: 1,
    succeeded: 0,
    timed_out: 0,
    total: 1,
  });
});

test("contains adapter exceptions as typed failures without losing other providers", async () => {
  const failing: UsageProviderAdapter = {
    acquire: async () => {
      throw new Error("upstream unavailable");
    },
    provider: "claude",
  };
  const succeeding: UsageProviderAdapter = {
    acquire: async (sources) => ({
      pendingCredentialUpdates: [],
      results: sources.map((source) => ({
        sourceId: source.id,
        usage: { plan: "Pro", windows: [] },
      })),
    }),
    provider: "codex",
  };
  const service = new UsageService({ adapters: [failing, succeeding] });

  const snapshot = await service.collect(
    [
      {
        id: { name: "one", provider: "claude" },
        order: 0,
        provider: "claude",
        source: "configured",
      },
      {
        id: { name: "two", provider: "codex" },
        order: 0,
        provider: "codex",
        source: "configured",
      },
    ],
    { credentialRefresh: "refresh-if-stale" }
  );

  assert.equal(
    snapshot.accounts[0]?.error?.code,
    "provider/acquisition-failed"
  );
  assert.equal(snapshot.accounts[0]?.error?.retryable, true);
  assert.equal(snapshot.accounts[1]?.usage?.plan, "Pro");
  assert.deepEqual(snapshot.summary, {
    failed: 1,
    succeeded: 1,
    timed_out: 0,
    total: 2,
  });
});
