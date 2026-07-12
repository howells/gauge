import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageSnapshot } from "../src/domain/snapshot.js";
import { buildStatusResult } from "../src/services/status-result.js";

const now = new Date("2026-07-11T12:00:00.000Z");

function snapshot(overrides: Partial<UsageSnapshot>): UsageSnapshot {
  return {
    accounts: [],
    generatedAt: now.toISOString(),
    pendingCredentialUpdates: [],
    summary: { total: 0, succeeded: 0, failed: 0, timed_out: 0 },
    ...overrides,
  };
}

test("complete status snapshots are ok and recommend with one shared policy", () => {
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { provider: "codex", name: "work" },
            order: 0,
            provider: "codex",
            source: "configured",
          },
          usage: {
            plan: "Pro",
            windows: [
              { usedPercent: 20, resetsAt: "2026-07-11T13:00:00.000Z" },
            ],
          },
        },
      ],
      summary: { total: 1, succeeded: 1, failed: 0, timed_out: 0 },
    }),
    { now, quick: false },
  );

  assert.equal(result.ok, true);
  assert.equal(result.result, "complete");
  assert.equal(result.exitCode, 0);
  assert.equal(result.paginated?.itemName, "accounts");
  assert.deepEqual((result.data as { summary: unknown }).summary, {
    total: 1,
    succeeded: 1,
    failed: 0,
    timed_out: 0,
  });
  assert.deepEqual(
    (result.data as { recommendation: { account: unknown } }).recommendation
      .account,
    { provider: "codex", name: "work" },
  );
});

test("partial snapshots stay ok and account failures use typed errors", () => {
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { provider: "claude", name: "ok" },
            order: 0,
            provider: "claude",
            source: "configured",
          },
          usage: { plan: "Pro", windows: [] },
        },
        {
          error: {
            code: "provider/timeout",
            message: "Provider request timed out.",
            retryable: true,
          },
          source: {
            id: { provider: "cursor", name: "slow" },
            order: 1,
            provider: "cursor",
            source: "configured",
          },
          usage: null,
        },
      ],
      summary: { total: 2, succeeded: 1, failed: 1, timed_out: 1 },
    }),
    { now, quick: false },
  );

  assert.equal(result.ok, true);
  assert.equal(result.result, "partial");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    (result.data as { accounts: Array<{ error: unknown }> }).accounts[1]?.error,
    {
      code: "provider/timeout",
      message: "Provider request timed out.",
      retryable: true,
    },
  );
});

test("all-failed snapshots emit data with ok false and exit one", () => {
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: {
            code: "provider/timeout",
            message: "Provider request timed out.",
            retryable: true,
          },
          source: {
            id: { provider: "codex", name: "work" },
            order: 0,
            provider: "codex",
            source: "configured",
          },
          usage: null,
        },
      ],
      summary: { total: 1, succeeded: 0, failed: 1, timed_out: 1 },
    }),
    { now, quick: false },
  );

  assert.equal(result.ok, false);
  assert.equal(result.result, "failed");
  assert.equal(result.exitCode, 1);
  assert.equal(result.paginated?.items.length, 1);
});

test("quick mode contains only recommendation and summary with one human line", () => {
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { provider: "cursor", name: "personal" },
            order: 0,
            provider: "cursor",
            source: "configured",
          },
          usage: {
            plan: "Pro",
            windows: [
              { usedPercent: 10, resetsAt: "2026-07-11T13:00:00.000Z" },
            ],
          },
        },
      ],
      summary: { total: 1, succeeded: 1, failed: 0, timed_out: 0 },
    }),
    { now, quick: true },
  );

  assert.deepEqual(Object.keys(result.data as object).sort(), [
    "recommendation",
    "summary",
  ]);
  // Rendered with ANSI styling; assert on the visible content.
  const plainHuman = result.human.replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(plainHuman, "→ cursor:personal  ready now\n");
  assert.equal(result.paginated, undefined);
});
