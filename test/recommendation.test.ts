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

test("recommendUsage offers a better plan that unblocks soon instead of only the free tier", () => {
  // The case measured on a real twelve-account set: every paid Claude plan was
  // 92-100% used and a Free Codex plan sat at 0%, so most-headroom answered
  // "abandon Max 20x for a free tier" while the Max account was 43 minutes from
  // resetting with 20% of its week gone.
  const result = recommendUsage(
    [
      {
        ...candidate("claude", "paid", 0, [
          { usedPercent: 100, resetsAt: "2026-07-11T12:43:00.000Z" },
          { usedPercent: 20, resetsAt: "2026-07-16T12:00:00.000Z" },
        ]),
        plan: "Max 20x",
      },
      {
        ...candidate("codex", "free", 1, [
          { usedPercent: 0, resetsAt: "2026-08-11T12:00:00.000Z" },
        ]),
        plan: "Free",
      },
    ],
    now,
  );

  // The usable account is still the answer to "what can I use right now".
  assert.deepEqual(result?.account, { provider: "codex", name: "free" });
  assert.equal(result?.status, "use_now");
  // And the better instrument is offered beside it, with what it will carry.
  assert.deepEqual(result?.waitFor?.account, {
    provider: "claude",
    name: "paid",
  });
  assert.equal(result?.waitFor?.plan, "Max 20x");
  assert.equal(result?.waitFor?.maximumUtilization, 20);
  assert.equal(result?.waitFor?.availableAt, "2026-07-11T12:43:00.000Z");
});

test("recommendUsage stays silent when the account in hand is already the best instrument", () => {
  const result = recommendUsage(
    [
      {
        ...candidate("claude", "roomy", 0, [
          { usedPercent: 5, resetsAt: "2026-07-11T13:00:00.000Z" },
        ]),
        plan: "Max 20x",
      },
      {
        ...candidate("codex", "blocked", 1, [
          { usedPercent: 100, resetsAt: "2026-07-11T12:30:00.000Z" },
          { usedPercent: 40, resetsAt: "2026-07-16T12:00:00.000Z" },
        ]),
        plan: "Pro",
      },
    ],
    now,
  );

  assert.deepEqual(result?.account, { provider: "claude", name: "roomy" });
  // Lower plan, and less headroom after its reset than the 95% already in hand.
  assert.equal(result?.waitFor, undefined);
});

test("recommendUsage ignores a better account whose reset is beyond the wait horizon", () => {
  const result = recommendUsage(
    [
      {
        ...candidate("codex", "free", 0, [
          { usedPercent: 0, resetsAt: "2026-08-11T12:00:00.000Z" },
        ]),
        plan: "Free",
      },
      {
        ...candidate("claude", "tomorrow", 1, [
          { usedPercent: 100, resetsAt: "2026-07-12T12:00:00.000Z" },
        ]),
        plan: "Max 20x",
      },
    ],
    now,
  );

  assert.deepEqual(result?.account, { provider: "codex", name: "free" });
  assert.equal(result?.waitFor, undefined);
});
