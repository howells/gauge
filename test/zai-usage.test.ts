import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { fetchZaiUsage, readZaiApiKey } from "../src/providers/zai-usage.js";

const fetchResponder =
  (
    routes: Record<string, { body?: unknown; status: number }>
  ): ((url: string) => Promise<Response>) =>
  async (url: string) => {
    const route = Object.entries(routes).find(([routeUrl]) => url === routeUrl);
    const found = route?.[1] ?? { status: 404 };
    return new Response(JSON.stringify(found.body ?? {}), {
      headers: { "content-type": "application/json" },
      status: found.status,
    });
  };

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const QUOTA_BODY = {
  code: 200,
  data: {
    level: "max",
    limits: [
      {
        currentValue: 458,
        nextResetTime: 1_789_754_518_889,
        number: 5,
        percentage: 1,
        remaining: 27_541,
        type: "CREDIT_LIMIT",
        unit: 3,
        usage: 28_000,
      },
      {
        currentValue: 1634,
        nextResetTime: 1_790_129_901_961,
        number: 1,
        percentage: 1,
        remaining: 138_365,
        type: "CREDIT_LIMIT",
        unit: 6,
        usage: 140_000,
      },
    ],
  },
  msg: "Operation successful",
  success: true,
};

test("fetchZaiUsage reads the session and monthly windows", async () => {
  const reading = await fetchZaiUsage(
    fetchResponder({ [QUOTA_URL]: { body: QUOTA_BODY, status: 200 } }),
    { ZAI_API_KEY: "key" }
  );
  assert.ok(reading);
  assert.equal(reading.plan, "Max");
  assert.equal(reading.session?.usedPercent, 1.6);
  assert.equal(
    reading.session?.resetsAt,
    new Date(1_789_754_518_889).toISOString()
  );
  assert.equal(reading.monthly?.usedPercent, 1.2);
});

test("fetchZaiUsage returns null when no key is available", async () => {
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-zai-empty-"));
  try {
    const reading = await fetchZaiUsage(
      fetchResponder({ [QUOTA_URL]: { body: QUOTA_BODY, status: 200 } }),
      { HOME: emptyHome }
    );
    assert.equal(reading, null);
  } finally {
    fs.rmSync(emptyHome, { force: true, recursive: true });
  }
});

test("fetchZaiUsage returns null when the key is refused", async () => {
  const reading = await fetchZaiUsage(
    fetchResponder({ [QUOTA_URL]: { body: {}, status: 401 } }),
    { ZAI_API_KEY: "key" }
  );
  assert.equal(reading, null);
});

test("readZaiApiKey finds a key under the known provider ids", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-zai-home-"));
  try {
    const dir = path.join(home, ".local", "share", "opencode");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify({ "zai-coding-plan": { key: "sk-zai", type: "api" } })
    );
    assert.equal(readZaiApiKey({ HOME: home }), "sk-zai");
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

test("readZaiApiKey prefers the environment key", () => {
  assert.equal(readZaiApiKey({ ZAI_API_KEY: "env-key" }), "env-key");
});
