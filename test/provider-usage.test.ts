import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cursorSecondaryPercent,
  cursorUsagePercent,
  decodeJwtPayload,
  fetchCodexAccounts,
  formatCodexPlan,
  parseRawCookieFile,
  parseStorageStateCookieFile,
  parseStorageStateCookies,
  toRateWindow,
} from "../src/provider-usage.js";

function jwt(payload: Record<string, unknown>): string {
  return [
    "header",
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

test("decodes Codex identity claims from JWT payloads", () => {
  const payload = decodeJwtPayload(
    jwt({ email: "person@example.com", plan: "pro" }),
  );

  assert.equal(payload.email, "person@example.com");
  assert.equal(payload.plan, "pro");
});

test("maps Codex usage windows from API reset seconds", () => {
  const window = toRateWindow({
    reset_at: 1_734_105_600,
    used_percent: 42.5,
  });

  assert.deepEqual(window, {
    resetsAt: "2024-12-13T16:00:00.000Z",
    usedPercent: 42.5,
  });
});

test("formats known Codex plan names", () => {
  assert.equal(formatCodexPlan("pro"), "Pro 20x");
  assert.equal(formatCodexPlan("pro_lite"), "Pro 5x");
  assert.equal(formatCodexPlan("team_enterprise"), "Team Enterprise");
});

test("extracts only Cursor cookies from Playwright storage state", () => {
  const header = parseStorageStateCookies({
    cookies: [
      {
        domain: ".cursor.com",
        name: "WorkosCursorSessionToken",
        value: "cursor-token",
      },
      { domain: ".example.com", name: "ignored", value: "nope" },
      {
        domain: ".cursor.sh",
        name: "authjs.session-token",
        value: "cursor-sh",
      },
    ],
  });

  assert.equal(
    header,
    "WorkosCursorSessionToken=cursor-token; authjs.session-token=cursor-sh",
  );
});

test("Cursor cookie filtering rejects suffix-spoofed domains", () => {
  const header = parseStorageStateCookies({
    cookies: [
      { domain: "evilcursor.com", name: "session", value: "secret" },
      { domain: "cursor.com.evil.test", name: "other", value: "secret" },
      { domain: "app.cursor.com", name: "valid", value: "allowed" },
    ],
  });

  assert.equal(header, "valid=allowed");
});

test("storage-state files never fall back to raw Cookie header text", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-cursor-"));
  const filePath = path.join(directory, "state.json");
  fs.writeFileSync(filePath, "session=secret");

  assert.equal(parseStorageStateCookieFile(filePath), null);
});

test("storage-state cookies reject header injection", () => {
  assert.equal(
    parseStorageStateCookies({
      cookies: [
        {
          domain: ".cursor.com",
          name: "session",
          value: "secret\r\nX-Injected: yes",
        },
      ],
    }),
    null,
  );
});

test("explicit raw-cookie files accept cookie syntax but reject controls", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-cursor-"));
  const validPath = path.join(directory, "cookie.txt");
  const invalidPath = path.join(directory, "injected.txt");
  fs.writeFileSync(validPath, "session=secret; second=value");
  fs.writeFileSync(invalidPath, "session=secret\r\nX-Injected: yes");

  assert.equal(parseRawCookieFile(validPath), "session=secret; second=value");
  assert.equal(parseRawCookieFile(invalidPath), null);
});

test("maps Cursor primary and secondary percentages", () => {
  const usage = {
    individualUsage: {
      plan: {
        apiPercentUsed: 20,
        autoPercentUsed: 40,
        totalPercentUsed: 60,
      },
    },
  };

  assert.equal(cursorUsagePercent(usage), 60);
  assert.equal(cursorSecondaryPercent(usage), 40);
});

test("Codex never-refresh policy tries the existing token once without writes", async () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const authPath = path.join(homePath, "auth.json");
  const auth = JSON.stringify({
    tokens: {
      access_token: "existing-access",
      id_token: jwt({ email: "person@example.com" }),
      last_refresh: "2020-01-01T00:00:00.000Z",
      refresh_token: "existing-refresh",
    },
  });
  fs.writeFileSync(authPath, auth, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.CODEX_HOME;
  const urls: string[] = [];
  process.env.CODEX_HOME = homePath;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({
        plan_type: "pro",
        rate_limit: {
          primary_window: { used_percent: 20, reset_at: 1_800_000_000 },
        },
      }),
      { status: 200 },
    );
  };

  try {
    const accounts = await fetchCodexAccounts([], {
      credentialRefresh: "never",
    });
    assert.equal(accounts[0]?.error, undefined);
    assert.equal(urls.length, 1);
    assert.equal(
      urls.some((url) => url.includes("auth.openai.com")),
      false,
    );
    assert.equal(fs.readFileSync(authPath, "utf8"), auth);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
  }
});

test("Codex refresh returns a pending update without provider-side writes", async () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const authPath = path.join(homePath, "auth.json");
  const auth = JSON.stringify({
    preserved: true,
    tokens: {
      access_token: "old-access",
      last_refresh: "2020-01-01T00:00:00.000Z",
      refresh_token: "old-refresh",
    },
  });
  fs.writeFileSync(authPath, auth, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.CODEX_HOME;
  const updates: unknown[] = [];
  process.env.CODEX_HOME = homePath;
  globalThis.fetch = async (input) =>
    String(input).includes("auth.openai.com")
      ? new Response(
          JSON.stringify({
            access_token: "new-access",
            refresh_token: "new-refresh",
          }),
          { status: 200 },
        )
      : new Response(JSON.stringify({ plan_type: "pro", rate_limit: {} }), {
          status: 200,
        });

  try {
    await fetchCodexAccounts([], {
      credentialRefresh: "refresh-if-stale",
      onCredentialUpdate: (update) => updates.push(update),
    });
    assert.equal(updates.length, 1);
    assert.equal(fs.readFileSync(authPath, "utf8"), auth);
    assert.deepEqual(
      Object.keys(updates[0] as object).sort(),
      ["accessToken", "homePath", "lastRefresh", "refreshToken"].sort(),
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
  }
});

test("Codex rejects oversized provider responses without exposing their body", async () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  fs.writeFileSync(
    path.join(homePath, "auth.json"),
    JSON.stringify({ tokens: { access_token: "existing-access" } }),
    { mode: 0o600 },
  );
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = homePath;
  globalThis.fetch = async () =>
    new Response("upstream-secret-body", {
      headers: { "content-length": "1000001" },
      status: 200,
    });

  try {
    const accounts = await fetchCodexAccounts([], {
      credentialRefresh: "never",
    });
    assert.match(accounts[0]?.error ?? "", /exceeded the allowed size/);
    assert.doesNotMatch(accounts[0]?.error ?? "", /upstream-secret-body/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
  }
});

test("Codex cancels a streaming response as soon as the byte limit is crossed", async () => {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  fs.writeFileSync(
    path.join(homePath, "auth.json"),
    JSON.stringify({ tokens: { access_token: "existing-access" } }),
    { mode: 0o600 },
  );
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.CODEX_HOME;
  let cancelled = false;
  let pulls = 0;
  process.env.CODEX_HOME = homePath;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream(
        {
          cancel: () => {
            cancelled = true;
          },
          pull: (controller) => {
            pulls += 1;
            controller.enqueue(new Uint8Array(600_000));
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 200 },
    );

  try {
    const accounts = await fetchCodexAccounts([], {
      credentialRefresh: "never",
    });
    assert.match(accounts[0]?.error ?? "", /exceeded the allowed size/);
    assert.equal(cancelled, true);
    assert.equal(pulls, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
  }
});
