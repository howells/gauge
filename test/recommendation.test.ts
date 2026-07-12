import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type RecommendationCandidate,
  recommendUsage,
} from "../src/domain/recommendation.js";

const now = new Date("2026-07-11T12:00:00.000Z");

function candidate(
  provider: RecommendationCandidate["id"]["provider"],
  name: string,
  order: number,
  windows: RecommendationCandidate["windows"],
): RecommendationCandidate {
  return {
    id: { provider, name },
    order,
    windows,
  };
}

test("recommendUsage ranks usable accounts by maximum then average utilization", () => {
  const result = recommendUsage(
    [
      candidate("claude", "balanced", 0, [
        { usedPercent: 40, resetsAt: "2026-07-11T13:00:00.000Z" },
        { usedPercent: 40, resetsAt: "2026-07-12T13:00:00.000Z" },
      ]),
      candidate("codex", "spiky", 1, [
        { usedPercent: 10, resetsAt: "2026-07-11T13:00:00.000Z" },
        { usedPercent: 50, resetsAt: "2026-07-12T13:00:00.000Z" },
      ]),
      candidate("cursor", "lighter", 2, [
        { usedPercent: 40, resetsAt: "2026-07-11T13:00:00.000Z" },
        { usedPercent: 20, resetsAt: "2026-07-12T13:00:00.000Z" },
      ]),
    ],
    now,
  );

  assert.deepEqual(result?.account, { provider: "cursor", name: "lighter" });
  assert.equal(result?.status, "use_now");
});

test("recommendUsage excludes failures, empty windows, expired windows, and blocked accounts while usable candidates exist", () => {
  const result = recommendUsage(
    [
      {
        ...candidate("claude", "failed", 0, []),
        error: { code: "x", message: "x", retryable: true },
      },
      candidate("claude", "empty", 1, []),
      candidate("claude", "expired", 2, [
        { usedPercent: 1, resetsAt: "2026-07-11T11:00:00.000Z" },
      ]),
      candidate("codex", "blocked", 3, [
        { usedPercent: 100, resetsAt: "2026-07-11T13:00:00.000Z" },
      ]),
      candidate("cursor", "usable", 4, [
        { usedPercent: 99, resetsAt: "2026-07-11T13:00:00.000Z" },
      ]),
    ],
    now,
  );

  assert.deepEqual(result?.account, { provider: "cursor", name: "usable" });
});

test("recommendUsage ranks all-blocked accounts by when every blocking window resets", () => {
  const result = recommendUsage(
    [
      candidate("claude", "two-blockers", 0, [
        { usedPercent: 100, resetsAt: "2026-07-11T13:00:00.000Z" },
        { usedPercent: 100, resetsAt: "2026-07-11T16:00:00.000Z" },
      ]),
      candidate("codex", "one-blocker", 1, [
        { usedPercent: 100, resetsAt: "2026-07-11T14:00:00.000Z" },
      ]),
    ],
    now,
  );

  assert.deepEqual(result?.account, { provider: "codex", name: "one-blocker" });
  assert.equal(result?.availableAt, "2026-07-11T14:00:00.000Z");
  assert.equal(result?.status, "wait");
});

test("recommendUsage uses configured order as the final tie breaker", () => {
  const result = recommendUsage(
    [
      candidate("codex", "second", 7, [
        { usedPercent: 20, resetsAt: "2026-07-11T13:00:00.000Z" },
      ]),
      candidate("claude", "first", 2, [
        { usedPercent: 20, resetsAt: "2026-07-11T13:00:00.000Z" },
      ]),
    ],
    now,
  );

  assert.deepEqual(result?.account, { provider: "claude", name: "first" });
});

test("recommendUsage returns null when there is no current usable usage data", () => {
  assert.equal(recommendUsage([], now), null);
  assert.equal(
    recommendUsage([candidate("claude", "empty", 0, [])], now),
    null,
  );
});
