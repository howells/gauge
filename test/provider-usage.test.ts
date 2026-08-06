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

test("Cursor meters included usage and on-demand as separate things", () => {
  const usage = {
    individualUsage: {
      plan: {
        apiPercentUsed: 20,
        autoPercentUsed: 40,
        totalPercentUsed: 60,
      },
      onDemand: { used: 25, limit: 100 },
    },
  };

  assert.equal(cursorUsagePercent(usage), 60);
  assert.equal(cursorSecondaryPercent(usage), 25);
});

test("Cursor reports the shared pool a seat with no on-demand limit draws from", () => {
  // The Enterprise shape: nothing of this seat's own allowance spent, while
  // the team pool behind it is more than half gone. Reading `autoPercentUsed`
  // here returned the included figure twice and never reached the pool.
  const usage = {
    individualUsage: {
      plan: { autoPercentUsed: 0, apiPercentUsed: 0, totalPercentUsed: 0 },
      onDemand: { used: 0, limit: null },
    },
    teamUsage: { onDemand: { used: 293_417, limit: 500_000 } },
  };

  assert.equal(cursorUsagePercent(usage), 0);
  assert.equal(Math.round(cursorSecondaryPercent(usage) as number), 59);
});

test("Cursor draws no on-demand window when nothing meters one", () => {
  // Unlimited or disabled: no proportion exists, so none is invented.
  assert.equal(
    cursorSecondaryPercent({
      individualUsage: {
        plan: { totalPercentUsed: 100 },
        onDemand: { enabled: false, used: 0, limit: null },
      },
      teamUsage: {},
    }),
    undefined,
  );
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

/** A Codex home whose token looks fresh by the clock but is dead on the server. */
function freshLookingCodexHome(): { authPath: string; homePath: string } {
  const homePath = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-"));
  const authPath = path.join(homePath, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      tokens: {
        access_token: "expired-access",
        // Recent, so the age heuristic sees nothing worth refreshing.
        last_refresh: new Date().toISOString(),
        refresh_token: "good-refresh",
      },
    }),
    { mode: 0o600 },
  );
  return { authPath, homePath };
}

test("a refused Codex token is refreshed and retried rather than reported", async () => {
  // The age heuristic cannot see an early expiry, so the server's 401 has to be
  // what triggers the rotation. Otherwise a usable refresh token sits there
  // while the dashboard tells the reader to re-authenticate by hand.
  const { authPath, homePath } = freshLookingCodexHome();
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.CODEX_HOME;
  const urls: string[] = [];
  const updates: unknown[] = [];
  process.env.CODEX_HOME = homePath;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("auth.openai.com")) {
      return new Response(JSON.stringify({ access_token: "new-access" }), {
        status: 200,
      });
    }
    const authorization = new Headers(init?.headers).get("authorization");
    if (authorization === "Bearer expired-access") {
      return new Response(JSON.stringify({ error: "token_expired" }), {
        status: 401,
      });
    }
    return new Response(
      JSON.stringify({
        plan_type: "pro",
        rate_limit: { primary_window: { used_percent: 12, reset_at: 1 } },
      }),
      { status: 200 },
    );
  };

  try {
    const accounts = await fetchCodexAccounts([], {
      credentialRefresh: "refresh-if-stale",
      onCredentialUpdate: (update) => updates.push(update),
    });

    assert.equal(accounts[0]?.error, undefined);
    assert.equal(accounts[0]?.session?.usedPercent, 12);
    // Refused, refreshed, retried — and the rotation offered to the caller
    // rather than written behind its back.
    assert.equal(urls.length, 3);
    assert.equal(urls[1]?.includes("auth.openai.com"), true);
    assert.equal(updates.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
  }
  assert.match(fs.readFileSync(authPath, "utf8"), /expired-access/u);
});

test("a refused Codex token is retried once, not repeatedly", async () => {
  // A login that is genuinely dead must still surface as one.
  const { homePath } = freshLookingCodexHome();
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.CODEX_HOME;
  const urls: string[] = [];
  process.env.CODEX_HOME = homePath;
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    return url.includes("auth.openai.com")
      ? new Response(JSON.stringify({ access_token: "still-no-good" }), {
          status: 200,
        })
      : new Response("{}", { status: 401 });
  };

  try {
    const accounts = await fetchCodexAccounts([], {
      credentialRefresh: "refresh-if-stale",
    });
    assert.match(accounts[0]?.error ?? "", /HTTP 401/u);
    assert.equal(urls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
  }
});

test("never-refresh forbids the retry rotation too", async () => {
  // `--no-credential-refresh` prohibits every credential write, and a 401 is
  // not an exception to it.
  const { homePath } = freshLookingCodexHome();
  const originalFetch = globalThis.fetch;
  const originalHome = process.env.CODEX_HOME;
  const urls: string[] = [];
  process.env.CODEX_HOME = homePath;
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response("{}", { status: 401 });
  };

  try {
    const accounts = await fetchCodexAccounts([], {
      credentialRefresh: "never",
    });
    assert.match(accounts[0]?.error ?? "", /HTTP 401/u);
    assert.equal(urls.length, 1);
    assert.equal(
      urls.some((url) => url.includes("auth.openai.com")),
      false,
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
