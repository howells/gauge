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
      { kind: "session", usedPercent: -5, resetsAt: "2026-07-11T13:00:00Z" },
      { kind: "weekly", usedPercent: 120, resetsAt: "2026-07-12T13:00:00Z" },
    ],
  });

  assert.equal(parsed.renewsAt, "2026-07-12T00:00:00.000Z");
  assert.deepEqual(parsed.windows, [
    { kind: "session", usedPercent: 0, resetsAt: "2026-07-11T13:00:00.000Z" },
    { kind: "weekly", usedPercent: 100, resetsAt: "2026-07-12T13:00:00.000Z" },
  ]);
});

test("provider usage DTO carries an idle window and demands a named kind", () => {
  const parsed = ProviderUsageReadingSchema.parse({
    plan: "Max 20x",
    windows: [{ kind: "session", usedPercent: 0, resetsAt: null }],
  });
  assert.deepEqual(parsed.windows, [
    { kind: "session", usedPercent: 0, resetsAt: null },
  ]);

  // Without a kind a window's meaning would come from its index again.
  assert.equal(
    ProviderUsageReadingSchema.safeParse({
      plan: "Max 20x",
      windows: [{ usedPercent: 12, resetsAt: null }],
    }).success,
    false,
  );
});

test("provider usage DTO rejects unknown fields and oversized strings", () => {
  assert.equal(
    ProviderUsageReadingSchema.safeParse({
      plan: "Pro",
      windows: [],
      upstreamBody: "secret",
    }).success,
    false,
  );
  assert.equal(
    ProviderUsageReadingSchema.safeParse({
      plan: "x".repeat(101),
      windows: [],
    }).success,
    false,
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
    five_hour: {
      resets_at: "2026-07-11T13:00:00Z",
      utilization: 120,
    },
    arbitrary: "discarded",
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
    five_hour: { utilization: 0, resets_at: null },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 12,
        severity: "normal",
        resets_at: "2026-08-29T18:00:00Z",
        scope: null,
        is_active: true,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 100,
        severity: "critical",
        resets_at: "2026-09-05T11:00:00Z",
        scope: null,
        is_active: true,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 54,
        severity: "normal",
        resets_at: "2026-09-05T11:00:00Z",
        scope: { model: { id: null, display_name: "Fable" }, surface: null },
        is_active: false,
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
    seven_day: { utilization: 93, resets_at: "2026-09-02T09:00:00Z" },
    limits: [
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 100,
        severity: "critical",
        resets_at: "2026-09-05T11:00:00Z",
        scope: null,
        is_active: true,
      },
    ],
  });
  assert.deepEqual(legacyWins.seven_day, {
    resets_at: "2026-09-02T09:00:00.000Z",
    utilization: 93,
  });

  // Absent legacy field and absent fallback entry alike stay absent.
  const neither = ClaudeUsageResponseSchema.parse({
    seven_day: null,
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 54,
        severity: "normal",
        resets_at: null,
        scope: null,
        is_active: false,
      },
    ],
  });
  assert.equal(neither.seven_day, null);
  assert.equal(neither.five_hour, null);

  const nullLimits = ClaudeUsageResponseSchema.parse({
    five_hour: { utilization: 8, resets_at: null },
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

  const currentCodex = CodexUsageResponseSchema.parse({
    rate_limit: {
      primary_window: {
        used_percent: 71,
        limit_window_seconds: 10_080 * 60,
        reset_at: 1_800_000_000,
      },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "codex_bengalfox",
        rate_limit: {
          primary_window: {
            used_percent: 37,
            limit_window_seconds: 300 * 60,
            reset_at: 1_700_000_000,
          },
        },
      },
    ],
  });
  assert.equal(
    currentCodex.additional_rate_limits[0]?.rate_limit.primary_window
      ?.limit_window_seconds,
    300 * 60,
  );

  const cursor = CursorUsageResponseSchema.parse({
    individualUsage: { plan: { totalPercentUsed: 150 } },
    membershipType: "pro",
  });
  assert.equal(cursor.individualUsage.plan?.totalPercentUsed, 100);

  // Unlimited / team-pooled plans report null limits; they must not reject.
  const unlimited = CursorUsageResponseSchema.parse({
    membershipType: "enterprise",
    individualUsage: { onDemand: { limit: null, used: null } },
    teamUsage: { onDemand: { limit: 500000, used: 33623 } },
  });
  assert.equal(unlimited.individualUsage.onDemand?.limit, undefined);
  assert.equal(unlimited.teamUsage.onDemand?.limit, 500000);
  assert.deepEqual(CursorUserResponseSchema.parse({ email: "a@example.com" }), {
    email: "a@example.com",
  });
  assert.equal(
    CodexRefreshResponseSchema.safeParse({ access_token: "x".repeat(4_097) })
      .success,
    false,
  );
});
