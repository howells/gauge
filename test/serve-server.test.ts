import assert from "node:assert/strict";
import { test } from "node:test";

import type { CommandResult } from "../src/output.js";
import { createServeServer } from "../src/serve/server.js";
import type {
  ServedSnapshot,
  StatusSnapshotCache,
} from "../src/serve/snapshot.js";

function cacheWith(
  result: CommandResult | null
): Pick<StatusSnapshotCache, "get"> & { calls(): number } {
  let calls = 0;
  return {
    calls: () => calls,
    get: async () => {
      calls += 1;
      if (result === null) {
        throw new Error("collection down");
      }
      const snapshot: ServedSnapshot = {
        fetchedAt: 1000,
        result,
      };
      return snapshot;
    },
  };
}

function statusResult(): CommandResult {
  return {
    command: "status",
    data: {
      accounts: [{ name: "personal", provider: "claude" }],
      summary: { failed: 0, succeeded: 1, timed_out: 0, total: 1 },
    },
    human: "",
  };
}

async function withServer(
  cache: Pick<StatusSnapshotCache, "get">,
  run: (port: number) => Promise<void>
): Promise<void> {
  const server = createServeServer({ cache, port: 0 });
  const address = await server.listen();
  try {
    await run(address.port);
  } finally {
    await server.close();
  }
}

test("GET / serves the dashboard page", async () => {
  await withServer(cacheWith(statusResult()), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/u);
    const body = await response.text();
    assert.match(body, /<!doctype html>/u);
    assert.match(body, /\/api\/status/u);
  });
});

test("GET /api/status serves the cached status payload", async () => {
  const cache = cacheWith(statusResult());
  await withServer(cache, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/json/u
    );
    const body = (await response.json()) as {
      ok: boolean;
      data: { summary: { total: number } };
    };
    assert.equal(body.ok, true);
    assert.equal(body.data.summary.total, 1);
    assert.equal(cache.calls(), 1);
  });
});

test("unknown routes answer 404", async () => {
  await withServer(cacheWith(statusResult()), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/nope`);
    assert.equal(response.status, 404);
    const body = (await response.json()) as { ok: boolean };
    assert.equal(body.ok, false);
  });
});

test("a failed collection answers 500 without caching the failure", async () => {
  const cache = cacheWith(null);
  await withServer(cache, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(response.status, 500);
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string };
    };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "serve/collection-failed");
    assert.equal(cache.calls(), 1);
  });
});
