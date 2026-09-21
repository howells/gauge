import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchOAuthUsage } from "../src/providers/oauth-usage.js";
import {
  ClaudeUsageResponseSchema,
  scopedClaudeLimits,
} from "../src/providers/upstream-schemas.js";

const limitWith = (kind: string, scope: unknown, percent: number) => ({
  is_active: true,
  kind,
  percent,
  resets_at: null,
  scope,
});

test("scopedClaudeLimits extracts model-scoped weekly sub-limits", () => {
  const scoped = scopedClaudeLimits([
    limitWith("session", null, 38),
    limitWith("weekly_all", null, 80),
    limitWith("weekly_scoped", { model: { display_name: "Fable" } }, 71),
  ]);
  assert.deepEqual(scoped, [
    { model: "Fable", resets_at: null, utilization: 71 },
  ]);
});

test("scopedClaudeLimits ignores entries without a model name", () => {
  const scoped = scopedClaudeLimits([
    limitWith("weekly_scoped", null, 71),
    limitWith("weekly_scoped", { surface: "cli" }, 12),
  ]);
  assert.deepEqual(scoped, []);
});

test("ClaudeUsageResponseSchema carries scoped windows beside the named ones", () => {
  const parsed = ClaudeUsageResponseSchema.parse({
    five_hour: { resets_at: "2026-09-18T15:30:00Z", utilization: 38 },
    limits: [
      limitWith("weekly_scoped", { model: { display_name: "Fable" } }, 71),
    ],
    seven_day: { resets_at: "2026-09-23T19:00:00Z", utilization: 80 },
  });
  assert.deepEqual(parsed.scoped, [
    { model: "Fable", resets_at: null, utilization: 71 },
  ]);
});

function responder(routes: Record<string, { body?: unknown; status: number }>) {
  return async (url: string) => {
    const route = Object.entries(routes).find(([path]) => url.endsWith(path));
    const found = route?.[1] ?? { status: 404 };
    return {
      json: async () => found.body,
      ok: found.status >= 200 && found.status < 300,
      status: found.status,
    };
  };
}

test("fetchOAuthUsage surfaces the Fable sub-limit from the limits array", async () => {
  const reading = await fetchOAuthUsage(
    "token",
    responder({
      "/api/oauth/profile": {
        body: {
          account: { email: "d@example.com" },
          organization: { rate_limit_tier: "default_claude_max_20x" },
        },
        status: 200,
      },
      "/api/oauth/usage": {
        body: {
          five_hour: { resets_at: "2026-09-18T15:30:00Z", utilization: 38 },
          limits: [
            limitWith(
              "weekly_scoped",
              { model: { display_name: "Fable" } },
              71
            ),
          ],
          seven_day: { resets_at: "2026-09-23T19:00:00Z", utilization: 80 },
        },
        status: 200,
      },
    })
  );
  assert.ok(reading);
  assert.deepEqual(reading.scoped, [
    { model: "Fable", resetsAt: null, usedPercent: 71 },
  ]);
  assert.equal(reading.plan, "max_20x");
});

test("fetchOAuthUsage returns a reading with only a Fable sub-limit", async () => {
  const reading = await fetchOAuthUsage(
    "token",
    responder({
      "/api/oauth/profile": { status: 404 },
      "/api/oauth/usage": {
        body: {
          limits: [
            limitWith(
              "weekly_scoped",
              { model: { display_name: "Fable" } },
              71
            ),
          ],
        },
        status: 200,
      },
    })
  );
  assert.ok(reading);
  assert.equal(reading.session, null);
  assert.equal(reading.weekly, null);
  assert.equal(reading.scoped.length, 1);
});
