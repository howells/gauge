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
    id: { provider: "codex", name: "work" },
    source: "configured",
    provider: "codex",
    order: 0,
  };
  let receivedContext: ProviderAcquisitionContext | undefined;
  const adapter: UsageProviderAdapter = {
    provider: "codex",
    acquire: async (sources, context) => {
      receivedContext = context;
      return {
        results: sources.map((item) => ({
          sourceId: item.id,
          usage: { plan: "Pro", windows: [] },
        })),
        pendingCredentialUpdates: [
          {
            sourceId: source.id,
            provider: "codex",
            kind: "external-credential",
            value: { accessToken: "new" },
          },
        ],
      };
    },
  };
  const service = new UsageService({
    adapters: [adapter],
    now: () => 1_000,
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
    total: 1,
    succeeded: 1,
    failed: 0,
    timed_out: 0,
  });
});

test("starts provider groups concurrently", async () => {
  const started: string[] = [];
  let releaseClaude: (() => void) | undefined;
  const claudeGate = new Promise<void>((resolve) => {
    releaseClaude = resolve;
  });
  const adapter = (provider: "claude" | "codex"): UsageProviderAdapter => ({
    provider,
    acquire: async (sources) => {
      started.push(provider);
      if (provider === "claude") await claudeGate;
      return {
        results: sources.map((source) => ({
          sourceId: source.id,
          usage: { plan: provider, windows: [] },
        })),
        pendingCredentialUpdates: [],
      };
    },
  });
  const service = new UsageService({
    adapters: [adapter("claude"), adapter("codex")],
  });
  const collection = service.collect(
    [
      {
        id: { provider: "claude", name: "one" },
        source: "configured",
        provider: "claude",
        order: 0,
      },
      {
        id: { provider: "codex", name: "two" },
        source: "configured",
        provider: "codex",
        order: 0,
      },
    ],
    { credentialRefresh: "refresh-if-stale" },
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
      provider: provider as UsageProviderAdapter["provider"],
      acquire: async (sources) => ({
        results: sources.map((source) => ({
          sourceId: source.id,
          usage: { plan: source.source, windows: [] },
        })),
        pendingCredentialUpdates: [],
      }),
    }),
  );
  const service = new UsageService({ adapters });

  const snapshot = await service.collect(
    [
      {
        id: { provider: "cursor", ambient: "env" },
        source: "ambient",
        provider: "cursor",
        order: 0,
      },
      {
        id: { provider: "claude", ambient: "browser" },
        source: "ambient",
        provider: "claude",
        order: -1,
      },
      {
        id: { provider: "codex", name: "second" },
        source: "configured",
        provider: "codex",
        order: 1,
      },
      {
        id: { provider: "claude", name: "first" },
        source: "configured",
        provider: "claude",
        order: 0,
      },
      {
        id: { provider: "codex", name: "first" },
        source: "configured",
        provider: "codex",
        order: 0,
      },
    ],
    { credentialRefresh: "refresh-if-stale" },
  );

  assert.deepEqual(
    snapshot.accounts.map((account) => account.source.id),
    [
      { provider: "claude", name: "first" },
      { provider: "claude", ambient: "browser" },
      { provider: "codex", name: "first" },
      { provider: "codex", name: "second" },
      { provider: "cursor", ambient: "env" },
    ],
  );
});

test("turns adapter count or order violations into typed internal failures", async () => {
  const sources: AccountSource[] = [
    {
      id: { provider: "codex", name: "first" },
      source: "configured",
      provider: "codex",
      order: 0,
    },
    {
      id: { provider: "codex", name: "second" },
      source: "configured",
      provider: "codex",
      order: 1,
    },
  ];
  const adapter: UsageProviderAdapter = {
    provider: "codex",
    acquire: async () => ({
      results: [...sources].reverse().map((source) => ({
        sourceId: source.id,
        usage: { plan: source.id.provider, windows: [] },
      })),
      pendingCredentialUpdates: [
        {
          sourceId: sources[0]?.id ?? { provider: "codex", name: "first" },
          provider: "codex",
          kind: "external-credential",
          value: "untrusted-after-contract-violation",
        },
      ],
    }),
  };
  const service = new UsageService({ adapters: [adapter] });

  const snapshot = await service.collect(sources, {
    credentialRefresh: "refresh-if-stale",
  });

  assert.deepEqual(
    snapshot.accounts.map((account) => account.error?.code),
    ["provider/contract-violation", "provider/contract-violation"],
  );
  assert.equal(snapshot.pendingCredentialUpdates.length, 0);
  assert.deepEqual(snapshot.summary, {
    total: 2,
    succeeded: 0,
    failed: 2,
    timed_out: 0,
  });
});

test("returns typed timeouts when an adapter never settles", async () => {
  let adapterSignal: AbortSignal | undefined;
  const adapter: UsageProviderAdapter = {
    provider: "claude",
    acquire: async (_sources, context) => {
      adapterSignal = context.signal;
      return new Promise(() => undefined);
    },
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
          id: { provider: "claude", name: "work" },
          source: "configured",
          provider: "claude",
          order: 0,
        },
      ],
      { credentialRefresh: "refresh-if-stale" },
    ),
    new Promise<never>((_resolve, reject) => {
      guard = setTimeout(
        () => reject(new Error("usage service remained pending")),
        250,
      );
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
    total: 1,
    succeeded: 0,
    failed: 1,
    timed_out: 1,
  });
});

test("a timed-out source does not discard a completed peer from the same provider", async () => {
  const adapter: UsageProviderAdapter = {
    provider: "claude",
    acquire: async (sources) => {
      const source = sources[0];
      if (!source) throw new Error("missing source");
      if ("name" in source.id && source.id.name === "hung") {
        return new Promise(() => undefined);
      }
      return {
        results: [
          {
            sourceId: source.id,
            usage: { plan: "Max", windows: [] },
          },
        ],
        pendingCredentialUpdates: [],
      };
    },
  };
  const service = new UsageService({
    adapters: [adapter],
    cleanupGraceMs: 5,
    deadlineMs: 20,
  });

  const snapshot = await service.collect(
    [
      {
        id: { provider: "claude", name: "hung" },
        source: "configured",
        provider: "claude",
        order: 0,
      },
      {
        id: { provider: "claude", name: "ready" },
        source: "configured",
        provider: "claude",
        order: 1,
      },
    ],
    { credentialRefresh: "refresh-if-stale" },
  );

  assert.equal(snapshot.accounts[0]?.error?.code, "provider/timeout");
  assert.equal(snapshot.accounts[1]?.usage?.plan, "Max");
  assert.deepEqual(snapshot.summary, {
    total: 2,
    succeeded: 1,
    failed: 1,
    timed_out: 1,
  });
});

test("timeout waits for cooperative provider cleanup before returning", async () => {
  let cleaned = false;
  const adapter: UsageProviderAdapter = {
    provider: "claude",
    acquire: async (sources, context) => {
      await new Promise<void>((resolve) => {
        context.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      cleaned = true;
      return {
        results: sources.map((source) => ({
          sourceId: source.id,
          usage: { plan: "late", windows: [] },
        })),
        pendingCredentialUpdates: [],
      };
    },
  };
  const service = new UsageService({
    adapters: [adapter],
    cleanupGraceMs: 50,
    deadlineMs: 10,
  });

  const snapshot = await service.collect(
    [
      {
        id: { provider: "claude", name: "work" },
        source: "configured",
        provider: "claude",
        order: 0,
      },
    ],
    { credentialRefresh: "refresh-if-stale" },
  );

  assert.equal(cleaned, true);
  assert.equal(snapshot.accounts[0]?.error?.code, "provider/timeout");
});

test("caps direct acquisitions at four globally across provider groups", async () => {
  let active = 0;
  let maximum = 0;
  const adapters: UsageProviderAdapter[] = ["claude", "codex", "cursor"].map(
    (provider) => ({
      provider: provider as UsageProviderAdapter["provider"],
      acquire: async (sources, context) => {
        await Promise.all(
          sources.map(() =>
            context.acquireDirect(async () => {
              active += 1;
              maximum = Math.max(maximum, active);
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
              active -= 1;
            }),
          ),
        );
        return {
          results: sources.map((source) => ({
            sourceId: source.id,
            usage: { plan: provider, windows: [] },
          })),
          pendingCredentialUpdates: [],
        };
      },
    }),
  );
  const sources: AccountSource[] = adapters.flatMap((adapter) =>
    [0, 1, 2].map((order) => ({
      id: { provider: adapter.provider, name: `account-${order}` },
      source: "configured" as const,
      provider: adapter.provider,
      order,
    })),
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
        id: { provider: "cursor", ambient: "environment" },
        source: "ambient",
        provider: "cursor",
        order: 0,
      },
    ],
    { credentialRefresh: "never" },
  );

  assert.equal(snapshot.accounts[0]?.error?.code, "provider/adapter-missing");
  assert.deepEqual(snapshot.summary, {
    total: 1,
    succeeded: 0,
    failed: 1,
    timed_out: 0,
  });
});

test("contains adapter exceptions as typed failures without losing other providers", async () => {
  const failing: UsageProviderAdapter = {
    provider: "claude",
    acquire: async () => {
      throw new Error("upstream unavailable");
    },
  };
  const succeeding: UsageProviderAdapter = {
    provider: "codex",
    acquire: async (sources) => ({
      results: sources.map((source) => ({
        sourceId: source.id,
        usage: { plan: "Pro", windows: [] },
      })),
      pendingCredentialUpdates: [],
    }),
  };
  const service = new UsageService({ adapters: [failing, succeeding] });

  const snapshot = await service.collect(
    [
      {
        id: { provider: "claude", name: "one" },
        source: "configured",
        provider: "claude",
        order: 0,
      },
      {
        id: { provider: "codex", name: "two" },
        source: "configured",
        provider: "codex",
        order: 0,
      },
    ],
    { credentialRefresh: "refresh-if-stale" },
  );

  assert.equal(
    snapshot.accounts[0]?.error?.code,
    "provider/acquisition-failed",
  );
  assert.equal(snapshot.accounts[0]?.error?.retryable, true);
  assert.equal(snapshot.accounts[1]?.usage?.plan, "Pro");
  assert.deepEqual(snapshot.summary, {
    total: 2,
    succeeded: 1,
    failed: 1,
    timed_out: 0,
  });
});
