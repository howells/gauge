import assert from "node:assert/strict";
import { test } from "node:test";

import { ProviderUsageReadingSchema } from "../src/providers/schemas.js";
import {
  ClaudeOrganizationListSchema,
  ClaudeUsageResponseSchema,
  CodexRefreshResponseSchema,
  CodexUsageResponseSchema,
  CursorUsageResponseSchema,
  CursorUserResponseSchema,
} from "../src/providers/upstream-schemas.js";

test("provider usage DTO normalizes dates and constrains percentages", () => {
  const parsed = ProviderUsageReadingSchema.parse({
    email: "person@example.com",
    plan: "Pro",
    renewsAt: "2026-07-12T00:00:00Z",
    windows: [
      { kind: "session", resetsAt: "2026-07-11T13:00:00Z", usedPercent: -5 },
      { kind: "weekly", resetsAt: "2026-07-12T13:00:00Z", usedPercent: 120 },
    ],
  });

  assert.equal(parsed.renewsAt, "2026-07-12T00:00:00.000Z");
  assert.deepEqual(parsed.windows, [
    { kind: "session", resetsAt: "2026-07-11T13:00:00.000Z", usedPercent: 0 },
    { kind: "weekly", resetsAt: "2026-07-12T13:00:00.000Z", usedPercent: 100 },
  ]);
});

test("provider usage DTO carries an idle window and demands a named kind", () => {
  const parsed = ProviderUsageReadingSchema.parse({
    plan: "Max 20x",
    windows: [{ kind: "session", resetsAt: null, usedPercent: 0 }],
  });
  assert.deepEqual(parsed.windows, [
    { kind: "session", resetsAt: null, usedPercent: 0 },
  ]);

  // Without a kind a window's meaning would come from its index again.
  assert.equal(
    ProviderUsageReadingSchema.safeParse({
      plan: "Max 20x",
      windows: [{ resetsAt: null, usedPercent: 12 }],
    }).success,
    false
  );
});

test("provider usage DTO rejects unknown fields and oversized strings", () => {
  assert.equal(
    ProviderUsageReadingSchema.safeParse({
      plan: "Pro",
      upstreamBody: "secret",
      windows: [],
    }).success,
    false
  );
  assert.equal(
    ProviderUsageReadingSchema.safeParse({
      plan: "x".repeat(101),
      windows: [],
    }).success,
    false
  );
});

test("provider ingress schemas strip unknown fields and bound normalized values", () => {
  const organizations = ClaudeOrganizationListSchema.parse([
    {
      capabilities: ["chat"],
      name: "Example",
      rate_limit_tier: "pro",
      secret_upstream_field: "discarded",
      uuid: "org-1",
    },
  ]);
  assert.deepEqual(organizations[0], {
    billing_type: null,
    capabilities: ["chat"],
    id: 0,
    name: "Example",
    rate_limit_tier: "pro",
    uuid: "org-1",
  });

  const claude = ClaudeUsageResponseSchema.parse({
    arbitrary: "discarded",
    five_hour: {
      resets_at: "2026-07-11T13:00:00Z",
      utilization: 120,
    },
  });
  assert.equal(claude.five_hour?.utilization, 100);
  assert.equal(claude.five_hour?.resets_at, "2026-07-11T13:00:00.000Z");

  // An idle window survives ingress as a window. It used to collapse to null
  // here, one step before a positional array turned the survivor into the
  // window it had displaced.
  const idle = ClaudeUsageResponseSchema.parse({
    five_hour: { resets_at: null, utilization: 0 },
    seven_day: { resets_at: "2026-07-14T13:00:00Z", utilization: 99 },
  });
  assert.deepEqual(idle.five_hour, { resets_at: null, utilization: 0 });
  assert.equal(idle.seven_day?.utilization, 99);
  // A window the API does not mention at all stays absent.
  assert.equal(idle.seven_day_opus, null);

  // The `limits` array is the fallback reading for the same horizons when the
  // legacy fields stop being populated, and the model-scoped sub-limit is
  // never promoted to the whole week.
  const fromLimits = ClaudeUsageResponseSchema.parse({
    five_hour: { resets_at: null, utilization: 0 },
    limits: [
      {
        group: "session",
        is_active: true,
        kind: "session",
        percent: 12,
        resets_at: "2026-08-29T18:00:00Z",
        scope: null,
        severity: "normal",
      },
      {
        group: "weekly",
        is_active: true,
        kind: "weekly_all",
        percent: 100,
        resets_at: "2026-09-05T11:00:00Z",
        scope: null,
        severity: "critical",
      },
      {
        group: "weekly",
        is_active: false,
        kind: "weekly_scoped",
        percent: 54,
        resets_at: "2026-09-05T11:00:00Z",
        scope: { model: { display_name: "Fable", id: null }, surface: null },
        severity: "normal",
      },
    ],
  });
  assert.deepEqual(fromLimits.five_hour, {
    resets_at: null,
    utilization: 0,
  });
  assert.deepEqual(fromLimits.seven_day, {
    resets_at: "2026-09-05T11:00:00.000Z",
    utilization: 100,
  });

  // A legacy window that is still populated wins over its `limits` twin.
  const legacyWins = ClaudeUsageResponseSchema.parse({
    limits: [
      {
        group: "weekly",
        is_active: true,
        kind: "weekly_all",
        percent: 100,
        resets_at: "2026-09-05T11:00:00Z",
        scope: null,
        severity: "critical",
      },
    ],
    seven_day: { resets_at: "2026-09-02T09:00:00Z", utilization: 93 },
  });
  assert.deepEqual(legacyWins.seven_day, {
    resets_at: "2026-09-02T09:00:00.000Z",
    utilization: 93,
  });

  // Absent legacy field and absent fallback entry alike stay absent.
  const neither = ClaudeUsageResponseSchema.parse({
    limits: [
      {
        group: "weekly",
        is_active: false,
        kind: "weekly_scoped",
        percent: 54,
        resets_at: null,
        scope: null,
        severity: "normal",
      },
    ],
    seven_day: null,
  });
  assert.equal(neither.seven_day, null);
  assert.equal(neither.five_hour, null);

  const nullLimits = ClaudeUsageResponseSchema.parse({
    five_hour: { resets_at: null, utilization: 8 },
    limits: null,
  });
  assert.deepEqual(nullLimits.five_hour, {
    resets_at: null,
    utilization: 8,
  });
  assert.equal(nullLimits.seven_day, null);

  const codex = CodexUsageResponseSchema.parse({
    plan_type: "pro",
    rate_limit: {
      primary_window: { reset_at: 1_800_000_000, used_percent: -1 },
    },
    raw_body: "discarded",
  });
  assert.equal(codex.rate_limit.primary_window?.used_percent, 0);
  assert.equal(codex.rate_limit_reset_credits, undefined);

  const codexWithResets = CodexUsageResponseSchema.parse({
    plan_type: "pro",
    rate_limit: {},
    rate_limit_reset_credits: {
      applicable_available_count: 1,
      available_count: 3,
    },
  });
  assert.deepEqual(codexWithResets.rate_limit_reset_credits, {
    applicable_available_count: 1,
    available_count: 3,
  });

  const currentCodex = CodexUsageResponseSchema.parse({
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "codex_bengalfox",
        rate_limit: {
          primary_window: {
            limit_window_seconds: 300 * 60,
            reset_at: 1_700_000_000,
            used_percent: 37,
          },
        },
      },
    ],
    rate_limit: {
      primary_window: {
        limit_window_seconds: 10_080 * 60,
        reset_at: 1_800_000_000,
        used_percent: 71,
      },
    },
  });
  assert.equal(
    currentCodex.additional_rate_limits,
    undefined,
    "model pools reported beside the frontier limit are not carried"
  );

  const cursor = CursorUsageResponseSchema.parse({
    individualUsage: { plan: { totalPercentUsed: 150 } },
    membershipType: "pro",
  });
  assert.equal(cursor.individualUsage.plan?.totalPercentUsed, 100);

  // Unlimited / team-pooled plans report null limits; they must not reject.
  const unlimited = CursorUsageResponseSchema.parse({
    individualUsage: { onDemand: { limit: null, used: null } },
    membershipType: "enterprise",
    teamUsage: { onDemand: { limit: 500_000, used: 33_623 } },
  });
  assert.equal(unlimited.individualUsage.onDemand?.limit, undefined);
  assert.equal(unlimited.teamUsage.onDemand?.limit, 500_000);
  assert.deepEqual(CursorUserResponseSchema.parse({ email: "a@example.com" }), {
    email: "a@example.com",
  });
  assert.equal(
    CodexRefreshResponseSchema.safeParse({ access_token: "x".repeat(4097) })
      .success,
    false
  );
});
