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
    summary: { failed: 0, succeeded: 0, timed_out: 0, total: 0 },
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
            id: { name: "work", provider: "codex" },
            order: 0,
            provider: "codex",
            source: "configured",
          },
          usage: {
            plan: "Pro",
            windows: [
              {
                kind: "session",
                resetsAt: "2026-07-11T13:00:00.000Z",
                usedPercent: 20,
              },
            ],
          },
        },
      ],
      summary: { failed: 0, succeeded: 1, timed_out: 0, total: 1 },
    }),
    { now, quick: false }
  );

  assert.equal(result.ok, true);
  assert.equal(result.result, "complete");
  assert.equal(result.exitCode, 0);
  assert.equal(result.paginated?.itemName, "accounts");
  assert.deepEqual((result.data as { summary: unknown }).summary, {
    failed: 0,
    succeeded: 1,
    timed_out: 0,
    total: 1,
  });
  assert.deepEqual(
    (result.data as { recommendation: { account: unknown } }).recommendation
      .account,
    { name: "work", provider: "codex" }
  );
});

test("a blocked account with an applicable reset is recommended as usable via reset", () => {
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { name: "full", provider: "codex" },
            order: 0,
            provider: "codex",
            source: "configured",
          },
          usage: {
            plan: "Pro 20x",
            resetsApplicable: 1,
            resetsAvailable: 2,
            windows: [
              {
                kind: "weekly",
                resetsAt: "2026-07-13T12:00:00.000Z",
                usedPercent: 100,
              },
            ],
          },
        },
      ],
      summary: { failed: 0, succeeded: 1, timed_out: 0, total: 1 },
    }),
    { now, quick: false }
  );

  const { recommendation } = result.data as {
    recommendation: { status: string; viaReset?: true };
  };
  assert.equal(recommendation.status, "use_now");
  assert.equal(recommendation.viaReset, true);
  assert.match(result.human, /ready now · via reset/);
});

test("partial snapshots stay ok and account failures use typed errors", () => {
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { name: "ok", provider: "claude" },
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
            id: { name: "slow", provider: "cursor" },
            order: 1,
            provider: "cursor",
            source: "configured",
          },
          usage: null,
        },
      ],
      summary: { failed: 1, succeeded: 1, timed_out: 1, total: 2 },
    }),
    { now, quick: false }
  );

  assert.equal(result.ok, true);
  assert.equal(result.result, "partial");
  assert.equal(result.exitCode, 0);
  assert.deepEqual(
    (result.data as { accounts: { error: unknown }[] }).accounts[1]?.error,
    {
      code: "provider/timeout",
      message: "Provider request timed out.",
      retryable: true,
    }
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
            id: { name: "work", provider: "codex" },
            order: 0,
            provider: "codex",
            source: "configured",
          },
          usage: null,
        },
      ],
      summary: { failed: 1, succeeded: 0, timed_out: 1, total: 1 },
    }),
    { now, quick: false }
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
            id: { name: "personal", provider: "cursor" },
            order: 0,
            provider: "cursor",
            source: "configured",
          },
          usage: {
            plan: "Pro",
            windows: [
              {
                kind: "included",
                resetsAt: "2026-07-11T13:00:00.000Z",
                usedPercent: 10,
              },
            ],
          },
        },
      ],
      summary: { failed: 0, succeeded: 1, timed_out: 0, total: 1 },
    }),
    { now, quick: true }
  );

  assert.deepEqual(Object.keys(result.data as object).sort(), [
    "recommendation",
    "summary",
  ]);
  // Rendered with ANSI styling; assert on the visible content.
  const plainHuman = result.human.replaceAll(/\u001B\[[0-9;]*m/g, "");
  assert.equal(plainHuman, "→ cursor:personal  ready now\n");
  assert.equal(result.paginated, undefined);
});

test("an idle session keeps its slot instead of letting the week be drawn as it", () => {
  // The shape that made the dashboard look frozen: an account untouched for
  // five hours reports an idle session window and a nearly-spent week. With
  // the idle window dropped, the 99% weekly figure slid into the session slot
  // and was drawn as the meter — a number that barely moves, sitting where a
  // fast-moving one belongs.
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { name: "siteinspire", provider: "claude" },
            order: 0,
            provider: "claude",
            source: "configured",
          },
          usage: {
            plan: "Max 20x",
            windows: [
              { kind: "session", resetsAt: null, usedPercent: 0 },
              {
                kind: "weekly",
                resetsAt: "2026-07-13T12:00:00.000Z",
                usedPercent: 99,
              },
            ],
          },
        },
      ],
      summary: { failed: 0, succeeded: 1, timed_out: 0, total: 1 },
    }),
    { now, quick: false }
  );

  const plain = result.human.replaceAll(/\u001B\[[0-9;]*m/g, "");
  const [meterLine, detailLine] = plain
    .split("\n")
    .filter((line) => line.includes("siteinspire") || line.includes("wk "));

  // The meter is the session: free, and with no clock, because an idle window
  // has nothing counting down.
  assert.match(String(meterLine), /siteinspire\s+░+ 0%\s*$/u);
  // The week is named where it is reported, and keeps its own reset.
  assert.match(String(detailLine), /Max 20x · wk 99% · 2d/u);
  // And the account is usable now — it is the week that is nearly gone.
  assert.equal(
    (result.data as { recommendation: { status: string } }).recommendation
      .status,
    "use_now"
  );
});

test("a full account says which of its limits filled", () => {
  // "full" alone cannot distinguish a spent session, back in an hour, from a
  // spent week that is not. The blocking window used to be hidden at exactly
  // 100% — the one reading where naming it matters.
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { name: "gmail", provider: "claude" },
            order: 0,
            provider: "claude",
            source: "configured",
          },
          usage: {
            plan: "Max 20x",
            windows: [
              { kind: "session", resetsAt: null, usedPercent: 0 },
              {
                kind: "weekly",
                resetsAt: "2026-07-12T12:00:00.000Z",
                usedPercent: 100,
              },
            ],
          },
        },
      ],
      summary: { failed: 0, succeeded: 1, timed_out: 0, total: 1 },
    }),
    { now, quick: false }
  );

  const plain = result.human.replaceAll(/\u001B\[[0-9;]*m/g, "");
  assert.match(plain, /gmail\s+█+ full · 1d/u);
  assert.match(plain, /Max 20x · wk 100% · 1d/u);
});

test("a narrow cell drops the plan label before it drops a usage reading", () => {
  // Enterprise plus a shared pool overflows the column. The pool is the only
  // part that moves, so it is the part that stays.
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { name: "howellsstudio", provider: "cursor" },
            order: 0,
            provider: "cursor",
            source: "configured",
          },
          usage: {
            plan: "Cursor Enterprise",
            renewsAt: "2026-07-26T12:00:00.000Z",
            windows: [
              {
                kind: "included",
                resetsAt: "2026-07-26T12:00:00.000Z",
                usedPercent: 0,
              },
              {
                kind: "on_demand",
                resetsAt: "2026-07-26T12:00:00.000Z",
                usedPercent: 58.68,
              },
            ],
          },
        },
      ],
      summary: { failed: 0, succeeded: 1, timed_out: 0, total: 1 },
    }),
    { now, quick: false }
  );

  const plain = result.human.replaceAll(/\u001B\[[0-9;]*m/g, "");
  assert.match(plain, /on-demand 59% · 15d/u);
  assert.doesNotMatch(plain, /Cursor Enterprise · on-demand/u);
});

test("an account idle on every window is still recommendable", () => {
  // Every window idle is the strongest availability signal there is. It used
  // to be the one shape that disqualified an account outright: idle windows
  // were filtered away, the candidate was left with none, and the policy
  // dropped it — so a wholly unused account could never be recommended.
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { name: "untouched", provider: "claude" },
            order: 0,
            provider: "claude",
            source: "configured",
          },
          usage: {
            plan: "Pro",
            windows: [
              { kind: "session", resetsAt: null, usedPercent: 0 },
              { kind: "weekly", resetsAt: null, usedPercent: 0 },
            ],
          },
        },
        {
          error: null,
          source: {
            id: { name: "busy", provider: "codex" },
            order: 1,
            provider: "codex",
            source: "configured",
          },
          usage: {
            plan: "Free",
            windows: [
              {
                kind: "session",
                resetsAt: "2026-07-11T13:00:00.000Z",
                usedPercent: 80,
              },
            ],
          },
        },
      ],
      summary: { failed: 0, succeeded: 2, timed_out: 0, total: 2 },
    }),
    { now, quick: false }
  );

  const { recommendation } = result.data as {
    recommendation: { account: unknown; maximumUtilization: number };
  };
  assert.deepEqual(recommendation.account, {
    name: "untouched",
    provider: "claude",
  });
  assert.equal(recommendation.maximumUtilization, 0);
});

test("a model-scoped Codex session is shown without blocking the whole account", () => {
  const result = buildStatusResult(
    snapshot({
      accounts: [
        {
          error: null,
          source: {
            id: { name: "gmail", provider: "codex" },
            order: 0,
            provider: "codex",
            source: "configured",
          },
          usage: {
            plan: "Pro 20x",
            windows: [
              {
                kind: "session",
                label: "GPT-5.3-Codex-Spark",
                resetsAt: "2026-07-11T13:00:00.000Z",
                usedPercent: 100,
              },
              {
                kind: "weekly",
                resetsAt: "2026-07-16T12:00:00.000Z",
                usedPercent: 71,
              },
            ],
          },
        },
      ],
      summary: { failed: 0, succeeded: 1, timed_out: 0, total: 1 },
    }),
    { now, quick: false }
  );

  const plain = result.human.replaceAll(/\u001B\[[0-9;]*m/g, "");
  assert.match(plain, /gmail\s+█+ 100%/u);
  assert.match(plain, /Spark session · wk 71% · 5d/u);
  assert.doesNotMatch(plain, /gmail\s+█+ full/u);
  assert.equal(
    (result.data as { recommendation: { status: string } }).recommendation
      .status,
    "use_now"
  );
});
