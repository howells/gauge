import assert from "node:assert/strict";
import { test } from "node:test";

import {
  fetchOAuthUsage,
  planFromRateLimitTier,
} from "../src/providers/oauth-usage.js";

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

test("fetchOAuthUsage reads both windows from the token", async () => {
  const reading = await fetchOAuthUsage(
    "token",
    responder({
      "/api/oauth/profile": {
        body: {
          account: { email: "dan@example.com" },
          organization: { rate_limit_tier: "default_claude_max_20x" },
        },
        status: 200,
      },
      "/api/oauth/usage": {
        body: {
          five_hour: {
            resets_at: "2026-08-05T18:10:00.000Z",
            utilization: 64,
          },
          seven_day: {
            resets_at: "2026-08-08T12:00:00.000Z",
            utilization: 99,
          },
        },
        status: 200,
      },
    })
  );

  assert.equal(reading?.plan, "max_20x");
  assert.equal(reading?.email, "dan@example.com");
  assert.deepEqual(reading?.session, {
    resetsAt: "2026-08-05T18:10:00.000Z",
    usedPercent: 64,
  });
  assert.deepEqual(reading?.weekly, {
    resetsAt: "2026-08-08T12:00:00.000Z",
    usedPercent: 99,
  });
});

test("fetchOAuthUsage keeps an idle window instead of promoting the other one", async () => {
  // The five-hour window of an account nobody has touched in five hours: a real
  // reading of 0% with nothing to count down to. Dropping it used to leave a
  // one-element array whose sole entry — the weekly figure — was then read as
  // the session, which is how a 99% week came to be drawn as a 99% session.
  const reading = await fetchOAuthUsage(
    "token",
    responder({
      "/api/oauth/profile": { status: 500 },
      "/api/oauth/usage": {
        body: {
          five_hour: { resets_at: null, utilization: 0 },
          seven_day: {
            resets_at: "2026-08-08T12:00:00.000Z",
            utilization: 99,
          },
        },
        status: 200,
      },
    })
  );

  assert.deepEqual(reading?.session, { resetsAt: null, usedPercent: 0 });
  assert.deepEqual(reading?.weekly, {
    resetsAt: "2026-08-08T12:00:00.000Z",
    usedPercent: 99,
  });
});

test("fetchOAuthUsage returns null on a refused token so the cookie path still runs", async () => {
  const reading = await fetchOAuthUsage(
    "stale",
    responder({ "/api/oauth/usage": { status: 401 } })
  );
  // An expired token is an optimisation missing, never an account failing.
  assert.equal(reading, null);
});

test("fetchOAuthUsage keeps the reading when only the profile fails", async () => {
  const reading = await fetchOAuthUsage(
    "token",
    responder({
      "/api/oauth/profile": { status: 500 },
      "/api/oauth/usage": {
        body: {
          five_hour: { resets_at: "2026-08-05T18:10:00.000Z", utilization: 10 },
          seven_day: null,
        },
        status: 200,
      },
    })
  );

  assert.equal(reading?.plan, null);
  assert.deepEqual(reading?.session, {
    resetsAt: "2026-08-05T18:10:00.000Z",
    usedPercent: 10,
  });
  // Absent upstream, which is not the same as idle: there is no reading here.
  assert.equal(reading?.weekly, null);
});

test("fetchOAuthUsage falls back to the limits array when the legacy weekly field is gone", async () => {
  const reading = await fetchOAuthUsage(
    "token",
    responder({
      "/api/oauth/profile": { status: 500 },
      "/api/oauth/usage": {
        body: {
          five_hour: { resets_at: null, utilization: 0 },
          limits: [
            {
              group: "session",
              is_active: true,
              kind: "session",
              percent: 0,
              resets_at: null,
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
              scope: { model: { display_name: "Fable", id: null } },
              severity: "normal",
            },
          ],
          seven_day: null,
        },
        status: 200,
      },
    })
  );

  assert.deepEqual(reading?.session, { resetsAt: null, usedPercent: 0 });
  assert.deepEqual(reading?.weekly, {
    resetsAt: "2026-09-05T11:00:00.000Z",
    usedPercent: 100,
  });
});

test("fetchOAuthUsage treats null limits as absent", async () => {
  const reading = await fetchOAuthUsage(
    "token",
    responder({
      "/api/oauth/profile": { status: 500 },
      "/api/oauth/usage": {
        body: {
          five_hour: { resets_at: null, utilization: 10 },
          limits: null,
          seven_day: null,
        },
        status: 200,
      },
    })
  );

  assert.deepEqual(reading?.session, { resetsAt: null, usedPercent: 10 });
  assert.equal(reading?.weekly, null);
});

test("planFromRateLimitTier names the tiers the dashboard shows", () => {
  // Codes, because `local-adapters` owns the one map from code to label.
  assert.equal(planFromRateLimitTier("default_claude_max_20x"), "max_20x");
  assert.equal(planFromRateLimitTier("default_claude_max_5x"), "max_5x");
  assert.equal(planFromRateLimitTier("default_claude_pro"), "pro");
  assert.equal(planFromRateLimitTier(null), null);
});
