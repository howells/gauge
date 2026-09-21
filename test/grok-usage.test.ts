import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  expiredGrokReading,
  fetchGrokUsage,
  liveGrokAccount,
  readGrokAccounts,
} from "../src/providers/grok-usage.js";

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();

function writeAuthStore(entries: Record<string, unknown>): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-grok-home-"));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify(entries));
  return home;
}

const creditsResponder =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });

test("readGrokAccounts reads every stored login with its expiry", () => {
  const home = writeAuthStore({
    "https://auth.x.ai::client-a": {
      email: "a@example.com",
      expires_at: FUTURE,
      key: "token-a",
    },
    "https://auth.x.ai::client-b": {
      email: "b@example.com",
      expires_at: PAST,
      key: "token-b",
    },
  });
  try {
    const accounts = readGrokAccounts(home);
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0]?.token, "token-b", "oldest expiry first");
    assert.equal(accounts[1]?.token, "token-a");
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

test("readGrokAccounts returns an empty list when auth.json is absent", () => {
  assert.deepEqual(readGrokAccounts("/nonexistent-gauge-grok-home"), []);
});

test("liveGrokAccount picks the newest unexpired login", () => {
  const home = writeAuthStore({
    "https://auth.x.ai::a": { expires_at: FUTURE, key: "token-a" },
    "https://auth.x.ai::b": { expires_at: PAST, key: "token-b" },
  });
  try {
    const live = liveGrokAccount(readGrokAccounts(home));
    assert.equal(live?.token, "token-a");
  } finally {
    fs.rmSync(home, { force: true, recursive: true });
  }
});

test("liveGrokAccount returns null when every login has expired", () => {
  const expired = [
    { email: null, expiresAt: new Date(PAST), token: "token-a" },
  ];
  assert.equal(liveGrokAccount(expired), null);
});

test("fetchGrokUsage reads the Grok Build product percentage", async () => {
  const reading = await fetchGrokUsage(
    { email: "d@example.com", expiresAt: null, token: "token" },
    creditsResponder({
      config: {
        creditUsagePercent: 30,
        productUsage: [
          { product: 2, usagePercent: 46 },
          { product: 4, usagePercent: 7 },
        ],
      },
    })
  );
  assert.ok(reading);
  assert.equal(reading.email, "d@example.com");
  assert.equal(reading.plan, "Grok Build");
  assert.equal(reading.session?.usedPercent, 46);
});

test("fetchGrokUsage falls back to the shared credit percentage", async () => {
  const reading = await fetchGrokUsage(
    { email: null, expiresAt: null, token: "token" },
    creditsResponder({ config: { creditUsagePercent: 30 } })
  );
  assert.equal(reading?.session?.usedPercent, 30);
});

test("fetchGrokUsage returns null when the endpoint refuses", async () => {
  const reading = await fetchGrokUsage(
    { email: null, expiresAt: null, token: "token" },
    creditsResponder({}, 401)
  );
  assert.equal(reading, null);
});

test("expiredGrokReading marks the account expired for the dashboard", () => {
  const reading = expiredGrokReading({
    email: "d@example.com",
    expiresAt: new Date(PAST),
    token: "token",
  });
  assert.equal(reading.tokenExpired, true);
  assert.equal(reading.email, "d@example.com");
  assert.equal(reading.session, null);
});
