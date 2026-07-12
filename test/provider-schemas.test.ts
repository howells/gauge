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
      { usedPercent: -5, resetsAt: "2026-07-11T13:00:00Z" },
      { usedPercent: 120, resetsAt: "2026-07-12T13:00:00Z" },
    ],
  });

  assert.equal(parsed.renewsAt, "2026-07-12T00:00:00.000Z");
  assert.deepEqual(parsed.windows, [
    { usedPercent: 0, resetsAt: "2026-07-11T13:00:00.000Z" },
    { usedPercent: 100, resetsAt: "2026-07-12T13:00:00.000Z" },
  ]);
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

  const codex = CodexUsageResponseSchema.parse({
    plan_type: "pro",
    rate_limit: {
      primary_window: { reset_at: 1_800_000_000, used_percent: -1 },
    },
    raw_body: "discarded",
  });
  assert.equal(codex.rate_limit.primary_window?.used_percent, 0);

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
