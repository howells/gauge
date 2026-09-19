import assert from "node:assert/strict";
import { test } from "node:test";

import { recommendUsage } from "../src/domain/recommendation.js";
import type { RecommendationCandidate } from "../src/domain/recommendation.js";

const now = new Date("2026-07-11T12:00:00.000Z");

function candidate(
  provider: RecommendationCandidate["id"]["provider"],
  name: string,
  order: number,
  windows: RecommendationCandidate["windows"]
): RecommendationCandidate {
  return {
    id: { name, provider },
    order,
    windows,
  };
}

test("recommendUsage ranks usable accounts by maximum then average utilization", () => {
  const result = recommendUsage(
    [
      candidate("claude", "balanced", 0, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 40 },
        { resetsAt: "2026-07-12T13:00:00.000Z", usedPercent: 40 },
      ]),
      candidate("codex", "spiky", 1, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 10 },
        { resetsAt: "2026-07-12T13:00:00.000Z", usedPercent: 50 },
      ]),
      candidate("cursor", "lighter", 2, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 40 },
        { resetsAt: "2026-07-12T13:00:00.000Z", usedPercent: 20 },
      ]),
    ],
    now
  );

  assert.deepEqual(result?.account, { name: "lighter", provider: "cursor" });
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
        { resetsAt: "2026-07-11T11:00:00.000Z", usedPercent: 1 },
      ]),
      candidate("codex", "blocked", 3, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 100 },
      ]),
      candidate("cursor", "usable", 4, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 99 },
      ]),
    ],
    now
  );

  assert.deepEqual(result?.account, { name: "usable", provider: "cursor" });
});

test("recommendUsage ranks all-blocked accounts by when every blocking window resets", () => {
  const result = recommendUsage(
    [
      candidate("claude", "two-blockers", 0, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 100 },
        { resetsAt: "2026-07-11T16:00:00.000Z", usedPercent: 100 },
      ]),
      candidate("codex", "one-blocker", 1, [
        { resetsAt: "2026-07-11T14:00:00.000Z", usedPercent: 100 },
      ]),
    ],
    now
  );

  assert.deepEqual(result?.account, { name: "one-blocker", provider: "codex" });
  assert.equal(result?.availableAt, "2026-07-11T14:00:00.000Z");
  assert.equal(result?.status, "wait");
});

test("recommendUsage uses configured order as the final tie breaker", () => {
  const result = recommendUsage(
    [
      candidate("codex", "second", 7, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 20 },
      ]),
      candidate("claude", "first", 2, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 20 },
      ]),
    ],
    now
  );

  assert.deepEqual(result?.account, { name: "first", provider: "claude" });
});

test("recommendUsage offers a blocked account holding an applicable reset instead of a long wait", () => {
  // Codex grants usage-limit resets that clear spent limits at once, so an
  // account at 100% with one in hand is a better answer than the earliest
  // natural reset.
  const result = recommendUsage(
    [
      candidate("codex", "resettable", 0, [
        { resetsAt: "2026-07-13T12:00:00.000Z", usedPercent: 100 },
      ]),
      candidate("claude", "blocked", 1, [
        { resetsAt: "2026-07-11T18:00:00.000Z", usedPercent: 100 },
      ]),
    ],
    now
  );
  const withReset = {
    ...candidate("codex", "resettable", 0, [
      { resetsAt: "2026-07-13T12:00:00.000Z", usedPercent: 100 },
    ]),
    applicableResets: 2,
  };

  const resetResult = recommendUsage(
    [
      withReset,
      candidate("claude", "blocked", 1, [
        { resetsAt: "2026-07-11T18:00:00.000Z", usedPercent: 100 },
      ]),
    ],
    now
  );

  // Without a reset the account stays a wait, ranked by its natural reset.
  assert.deepEqual(result?.account, { name: "blocked", provider: "claude" });
  assert.equal(result?.status, "wait");
  // With one, it is usable now, and the pick names its cost.
  assert.deepEqual(resetResult?.account, {
    name: "resettable",
    provider: "codex",
  });
  assert.equal(resetResult?.status, "use_now");
  assert.equal(resetResult?.viaReset, true);
});

test("recommendUsage prefers a genuinely free account over one needing a reset redeemed", () => {
  const result = recommendUsage(
    [
      {
        ...candidate("codex", "resettable", 0, [
          { resetsAt: "2026-07-13T12:00:00.000Z", usedPercent: 100 },
        ]),
        applicableResets: 2,
      },
      candidate("claude", "light", 1, [
        { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 10 },
      ]),
    ],
    now
  );

  assert.deepEqual(result?.account, { name: "light", provider: "claude" });
  assert.equal(result?.viaReset, undefined);
});

test("recommendUsage offers a natural reset beside a pick that costs a credit", () => {
  // A reset spends a credit; a natural reset forty minutes out does not, so
  // the wait is still worth naming beside the pick.
  const result = recommendUsage(
    [
      {
        ...candidate("codex", "resettable", 0, [
          { resetsAt: "2026-07-13T12:00:00.000Z", usedPercent: 100 },
        ]),
        applicableResets: 1,
      },
      {
        ...candidate("claude", "soon", 1, [
          { resetsAt: "2026-07-11T12:40:00.000Z", usedPercent: 100 },
          { resetsAt: "2026-07-16T12:00:00.000Z", usedPercent: 20 },
        ]),
        plan: "Max 20x",
      },
    ],
    now
  );

  assert.deepEqual(result?.account, { name: "resettable", provider: "codex" });
  assert.equal(result?.viaReset, true);
  assert.deepEqual(result?.waitFor?.account, {
    name: "soon",
    provider: "claude",
  });
  assert.equal(result?.waitFor?.availableAt, "2026-07-11T12:40:00.000Z");
});

test("recommendUsage returns null when there is no current usable usage data", () => {
  assert.equal(recommendUsage([], now), null);
  assert.equal(
    recommendUsage([candidate("claude", "empty", 0, [])], now),
    null
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
          { resetsAt: "2026-07-11T12:43:00.000Z", usedPercent: 100 },
          { resetsAt: "2026-07-16T12:00:00.000Z", usedPercent: 20 },
        ]),
        plan: "Max 20x",
      },
      {
        ...candidate("codex", "free", 1, [
          { resetsAt: "2026-08-11T12:00:00.000Z", usedPercent: 0 },
        ]),
        plan: "Free",
      },
    ],
    now
  );

  // The usable account is still the answer to "what can I use right now".
  assert.deepEqual(result?.account, { name: "free", provider: "codex" });
  assert.equal(result?.status, "use_now");
  // And the better instrument is offered beside it, with what it will carry.
  assert.deepEqual(result?.waitFor?.account, {
    name: "paid",
    provider: "claude",
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
          { resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 5 },
        ]),
        plan: "Max 20x",
      },
      {
        ...candidate("codex", "blocked", 1, [
          { resetsAt: "2026-07-11T12:30:00.000Z", usedPercent: 100 },
          { resetsAt: "2026-07-16T12:00:00.000Z", usedPercent: 40 },
        ]),
        plan: "Pro",
      },
    ],
    now
  );

  assert.deepEqual(result?.account, { name: "roomy", provider: "claude" });
  // Lower plan, and less headroom after its reset than the 95% already in hand.
  assert.equal(result?.waitFor, undefined);
});

test("recommendUsage ignores a better account whose reset is beyond the wait horizon", () => {
  const result = recommendUsage(
    [
      {
        ...candidate("codex", "free", 0, [
          { resetsAt: "2026-08-11T12:00:00.000Z", usedPercent: 0 },
        ]),
        plan: "Free",
      },
      {
        ...candidate("claude", "tomorrow", 1, [
          { resetsAt: "2026-07-12T12:00:00.000Z", usedPercent: 100 },
        ]),
        plan: "Max 20x",
      },
    ],
    now
  );

  assert.deepEqual(result?.account, { name: "free", provider: "codex" });
  assert.equal(result?.waitFor, undefined);
});
