import assert from "node:assert/strict";
import { test } from "node:test";

import type { CommandResult } from "../src/output.js";
import { StatusSnapshotCache } from "../src/serve/snapshot.js";

const result = (command: string): CommandResult => ({
  command,
  data: {},
  human: "",
});

const manualClock = () => {
  let now = 1_000_000;
  return {
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
};

test("first get collects and caches", async () => {
  let fetches = 0;
  const cache = new StatusSnapshotCache({
    fetch: async () => {
      fetches += 1;
      return result("status");
    },
  });
  const snapshot = await cache.get();
  assert.equal(fetches, 1);
  assert.equal(snapshot.result.command, "status");
  assert.equal(cache.peek()?.result.command, "status");
});

test("a poll inside the minimum age never re-collects", async () => {
  const clock = manualClock();
  let fetches = 0;
  const cache = new StatusSnapshotCache({
    fetch: async () => {
      fetches += 1;
      return result("status");
    },
    minAgeMs: 30_000,
    now: clock.now,
  });
  await cache.get();
  clock.advance(10_000);
  await cache.get();
  assert.equal(fetches, 1);
});

const deferredFetch = () => {
  const resolvers: ((value: CommandResult) => void)[] = [];
  return {
    fetch: async () =>
      await new Promise<CommandResult>((resolve) => {
        resolvers.push(resolve);
      }),
    resolvers,
  };
};

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
};

test("a stale poll returns the cached reading and refreshes in the background", async () => {
  const clock = manualClock();
  const deferred = deferredFetch();
  let fetches = 0;
  const cache = new StatusSnapshotCache({
    fetch: async () => {
      fetches += 1;
      return await deferred.fetch();
    },
    minAgeMs: 30_000,
    now: clock.now,
  });
  const first = cache.get();
  deferred.resolvers[0]?.(result("status"));
  await first;
  clock.advance(31_000);

  const second = await cache.get();
  assert.equal(second.result.command, "status", "stale reading served at once");
  assert.equal(fetches, 2, "background refresh started");

  deferred.resolvers[1]?.(result("status-next"));
  await flush();
  const third = await cache.get();
  assert.equal(third.result.command, "status-next");
});

test("overlapping stale polls share one collection", async () => {
  const clock = manualClock();
  const deferred = deferredFetch();
  let fetches = 0;
  const cache = new StatusSnapshotCache({
    fetch: async () => {
      fetches += 1;
      return await deferred.fetch();
    },
    minAgeMs: 30_000,
    now: clock.now,
  });
  const first = cache.get();
  deferred.resolvers[0]?.(result("status"));
  await first;
  clock.advance(31_000);

  await cache.get();
  await cache.get();
  await cache.get();
  assert.equal(fetches, 2, "one background refresh for three polls");
  deferred.resolvers[1]?.(result("status"));
  await flush();
});

test("a failed first collection propagates and leaves nothing cached", async () => {
  const cache = new StatusSnapshotCache({
    fetch: async () => {
      throw new Error("collection down");
    },
  });
  await assert.rejects(cache.get(), /collection down/u);
  assert.equal(cache.peek(), null);
});
