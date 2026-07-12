import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type ApiRuntime,
  addAccount,
  addCursorAccount,
  derivePlan,
  extractClaudeRenewal,
  fetchAllUsage,
  fetchUsageForAccount,
  normalizeDate,
} from "../src/api.js";

const organization = {
  uuid: "org-1",
  name: "Example",
  organization_type: "individual" as const,
  rate_limit_tier: "default_claude_max_5x",
  capabilities: ["chat"],
};
const usage = {
  five_hour: { utilization: 25, resets_at: "2026-07-11T14:00:00.000Z" },
  seven_day: { utilization: 10, resets_at: "2026-07-18T12:00:00.000Z" },
};

test("Claude pure response normalization is bounded and deterministic", () => {
  assert.equal(derivePlan(organization), "max_5x");
  assert.equal(
    derivePlan({ ...organization, rate_limit_tier: "claude_max_20x" }),
    "max_20x",
  );
  assert.equal(
    derivePlan({ ...organization, rate_limit_tier: "claude_max" }),
    "max",
  );
  assert.equal(
    derivePlan({
      ...organization,
      rate_limit_tier: undefined,
      capabilities: ["claude_max"],
    }),
    "max",
  );
  assert.equal(
    derivePlan({
      ...organization,
      rate_limit_tier: "",
      capabilities: ["chat"],
    }),
    "pro",
  );
  // Free accounts still list "chat" but carry no subscription.
  assert.equal(
    derivePlan({
      ...organization,
      rate_limit_tier: "default_claude_ai",
      billing_type: "none",
      capabilities: ["chat"],
    }),
    "free",
  );
  assert.equal(
    derivePlan({ ...organization, rate_limit_tier: "", capabilities: [] }),
    "unknown",
  );
  assert.equal(
    extractClaudeRenewal({ next_charge_date: "2026-08-01" }),
    "2026-08-01T00:00:00.000Z",
  );
  assert.equal(
    extractClaudeRenewal({
      next_charge_at: "2026-08-02T10:00:00Z",
      next_charge_date: "2026-08-01",
    }),
    "2026-08-02T10:00:00.000Z",
  );
  assert.equal(extractClaudeRenewal({}), null);
  assert.equal(extractClaudeRenewal([]), null);
  assert.equal(normalizeDate("not-a-date"), null);
  assert.equal(normalizeDate(null), null);
});

test("request acquisition fetches usage and renewal concurrently and returns pending state", async () => {
  const storagePath = temporaryFile("state.json", "{}");
  const updates: unknown[] = [];
  let active = 0;
  let maximum = 0;
  let disposed = 0;
  const runtime = requestRuntime(
    async (url) => {
      if (url === "/api/organizations") return response(200, [organization]);
      active += 1;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active -= 1;
      return url.endsWith("/usage")
        ? response(200, usage)
        : response(200, { next_charge_at: "2026-08-01T12:30:00Z" });
    },
    () => {
      disposed += 1;
    },
  );

  const result = await fetchUsageForAccount(
    { authKey: "work", name: "work", storagePath },
    {
      onStorageStateUpdate: (value) => updates.push(value),
      runtime,
    },
  );

  assert.equal(result.plan, "max_5x");
  assert.equal(result.usage.five_hour?.utilization, 25);
  assert.equal(result.renewsAt, "2026-08-01T12:30:00.000Z");
  assert.equal(maximum, 2);
  assert.deepEqual(updates, [{ cookies: [], origins: [] }]);
  assert.equal(disposed, 1);
});

test("request acquisition contains authentication and malformed organization failures", async () => {
  const storagePath = temporaryFile("state.json", "{}");
  for (const [status, body, expected] of [
    [401, {}, /Session expired/],
    [403, {}, /Session expired/],
    [200, [], /No organizations/],
  ] as const) {
    const result = await fetchUsageForAccount(
      { authKey: "work", name: "work", storagePath },
      {
        credentialRefresh: "never",
        runtime: requestRuntime(async () =>
          response(
            status,
            body,
            status === 403 ? "application/json" : undefined,
          ),
        ),
      },
    );
    assert.match(result.error ?? "", expected);
  }
});

test("request acquisition contains usage and optional-renewal failures", async () => {
  const storagePath = temporaryFile("state.json", "{}");
  const usageRejected = await fetchUsageForAccount(
    { authKey: "work", name: "work", storagePath },
    {
      runtime: requestRuntime(async (url) =>
        url === "/api/organizations"
          ? response(200, [organization])
          : url.endsWith("/usage")
            ? response(403, {}, "application/json")
            : response(500, {}),
      ),
    },
  );
  assert.match(usageRejected.error ?? "", /Session expired/);

  const renewalIgnored = await fetchUsageForAccount(
    {
      authKey: "work",
      name: "work",
      renewsAt: "2026-07-30T00:00:00.000Z",
      storagePath,
    },
    {
      runtime: requestRuntime(async (url) => {
        if (url === "/api/organizations") return response(200, [organization]);
        if (url.endsWith("/usage")) return response(200, usage);
        return response(200, "not-json", "text/plain");
      }),
    },
  );
  assert.equal(renewalIgnored.renewsAt, "2026-07-30T00:00:00.000Z");
});

test("missing, aborted, and never-refresh acquisitions fail without browser writes", async () => {
  const missing = await fetchUsageForAccount({
    authKey: "missing",
    name: "missing",
    profileDir: path.join(os.tmpdir(), "does-not-exist-profile"),
    storagePath: path.join(os.tmpdir(), "does-not-exist-state"),
  });
  assert.match(missing.error ?? "", /No saved session/);

  const storagePath = temporaryFile("state.json", "{}");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await assert.rejects(
    () =>
      fetchUsageForAccount(
        { authKey: "work", name: "work", storagePath },
        { signal: controller.signal },
      ),
    /cancelled/,
  );

  const rejected = await fetchUsageForAccount(
    { authKey: "work", name: "work", storagePath },
    {
      credentialRefresh: "never",
      runtime: requestRuntime(async () => response(403, {}, "text/html")),
    },
  );
  assert.match(rejected.error ?? "", /refresh is disabled/);
});

test("in-flight request cancellation settles and disposes the request context once", async () => {
  const storagePath = temporaryFile("state.json", "{}");
  const controller = new AbortController();
  let disposed = 0;
  const acquisition = fetchUsageForAccount(
    { authKey: "work", name: "work", storagePath },
    {
      credentialRefresh: "never",
      signal: controller.signal,
      runtime: requestRuntime(
        () => new Promise<ReturnType<typeof response>>(() => undefined),
        () => {
          disposed += 1;
        },
      ),
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(() => acquisition, /aborted/i);
  assert.equal(disposed, 1);
});

test("request context resolving after cancellation is disposed exactly once", async () => {
  const storagePath = temporaryFile("state.json", "{}");
  const controller = new AbortController();
  let disposed = 0;
  let resolveContext!: (value: unknown) => void;
  const contextPromise = new Promise((resolve) => {
    resolveContext = resolve;
  });
  const acquisition = fetchUsageForAccount(
    { authKey: "work", name: "work", storagePath },
    {
      signal: controller.signal,
      runtime: {
        newRequestContext: (() =>
          contextPromise) as ApiRuntime["newRequestContext"],
      },
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(() => acquisition, /aborted/i);
  resolveContext({
    dispose: async () => {
      disposed += 1;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposed, 1);
});

test("request body cancellation settles and disposes the context once", async () => {
  const storagePath = temporaryFile("state.json", "{}");
  const controller = new AbortController();
  let disposed = 0;
  const acquisition = fetchUsageForAccount(
    { authKey: "work", name: "work", storagePath },
    {
      signal: controller.signal,
      runtime: requestRuntime(
        async () => ({
          body: () => new Promise<Buffer>(() => undefined),
          headers: () => ({
            "content-length": "100",
            "content-type": "application/json",
          }),
          ok: () => true,
          status: () => 200,
        }),
        () => {
          disposed += 1;
        },
      ),
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(() => acquisition, /aborted/i);
  assert.equal(disposed, 1);
});

test("chunked request responses without a content length are parsed", async () => {
  // claude.ai responds chunked (no content-length header); the request path
  // must not require a declared size.
  const storagePath = temporaryFile("state.json", "{}");
  const chunked = (body: unknown) => ({
    ...response(200, body),
    headers: () => ({ "content-type": "application/json" }),
  });
  const result = await fetchUsageForAccount(
    { authKey: "work", name: "work", storagePath },
    {
      credentialRefresh: "never",
      runtime: requestRuntime(async (url) =>
        url === "/api/organizations"
          ? chunked([organization])
          : url.endsWith("/usage")
            ? chunked(usage)
            : chunked({}),
      ),
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.plan, "max_5x");
  assert.equal(result.usage.five_hour?.utilization, 25);
});

test("oversized request responses without a content length are still bounded", async () => {
  // Providers commonly respond chunked (no content-length); the byte-length
  // check after buffering remains the enforced bound.
  const storagePath = temporaryFile("state.json", "{}");
  const result = await fetchUsageForAccount(
    {
      authKey: "work",
      name: "work",
      profileDir: path.join(path.dirname(storagePath), "missing-profile"),
      storagePath,
    },
    {
      credentialRefresh: "never",
      runtime: requestRuntime(async () => ({
        body: async () => Buffer.alloc(1024 * 1024 + 1, 0x20),
        headers: () => ({ "content-type": "application/json" }),
        ok: () => true,
        status: () => 200,
      })),
    },
  );
  assert.match(result.error ?? "", /refresh is disabled/);
});

test("request promise rejection is contained and disposes the context", async () => {
  const storagePath = temporaryFile("state.json", "{}");
  let disposed = 0;
  const result = await fetchUsageForAccount(
    { authKey: "work", name: "work", storagePath },
    {
      credentialRefresh: "never",
      runtime: requestRuntime(
        async () => {
          throw new Error("401 upstream rejection");
        },
        () => {
          disposed += 1;
        },
      ),
    },
  );

  assert.match(result.error ?? "", /Session expired/);
  assert.equal(disposed, 1);
});

test("visible browser fallback returns usage, persists pending state, and closes once", async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-profile-"));
  let evaluations = 0;
  let closed = 0;
  const page = {
    content: async () => "<html>ready</html>",
    evaluate: async () => {
      evaluations += 1;
      if (evaluations === 1) return [organization];
      if (evaluations === 2) return usage;
      return { next_charge_date: "2026-08-01" };
    },
    goto: async () => undefined,
  };
  const runtime = browserRuntime(page, () => {
    closed += 1;
  });
  const updates: unknown[] = [];

  const result = await fetchUsageForAccount(
    {
      authKey: "work",
      name: "work",
      profileDir,
      storagePath: path.join(profileDir, "missing.json"),
    },
    { onStorageStateUpdate: (value) => updates.push(value), runtime },
  );

  assert.equal(result.plan, "max_5x");
  assert.equal(result.renewsAt, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(updates, [{ cookies: [], origins: [] }]);
  assert.equal(closed, 1);
});

test("visible browser fallback aborts pending navigation and closes once", async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-profile-"));
  const controller = new AbortController();
  let closed = 0;
  const runtime = browserRuntime(
    {
      content: async () => "<html>ready</html>",
      evaluate: async () => [organization],
      goto: () => new Promise(() => undefined),
    },
    () => {
      closed += 1;
    },
  );
  const acquisition = fetchUsageForAccount(
    {
      authKey: "work",
      name: "work",
      profileDir,
      storagePath: path.join(profileDir, "missing.json"),
    },
    { runtime, signal: controller.signal },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await acquisition;

  assert.match(result.error ?? "", /aborted/i);
  assert.equal(closed, 1);
});

test("visible browser fallback closes when new-page creation is aborted", async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-profile-"));
  const controller = new AbortController();
  let closed = 0;
  const runtime = {
    assertChromeInstalled: () => undefined,
    launchPersistentContext: (async () => ({
      close: async () => {
        closed += 1;
      },
      newPage: () => new Promise(() => undefined),
      pages: () => [],
    })) as ApiRuntime["launchPersistentContext"],
  };
  const acquisition = fetchUsageForAccount(
    {
      authKey: "work",
      name: "work",
      profileDir,
      storagePath: path.join(profileDir, "missing.json"),
    },
    { runtime, signal: controller.signal },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await acquisition;
  assert.match(result.error ?? "", /aborted/i);
  assert.equal(closed, 1);
});

test("browser context resolving after cancellation is closed exactly once", async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-profile-"));
  const controller = new AbortController();
  let closed = 0;
  let resolveContext!: (value: unknown) => void;
  const contextPromise = new Promise((resolve) => {
    resolveContext = resolve;
  });
  const acquisition = fetchUsageForAccount(
    {
      authKey: "work",
      name: "work",
      profileDir,
      storagePath: path.join(profileDir, "missing.json"),
    },
    {
      signal: controller.signal,
      runtime: {
        assertChromeInstalled: () => undefined,
        launchPersistentContext: (() =>
          contextPromise) as ApiRuntime["launchPersistentContext"],
      },
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(() => acquisition, /aborted/i);
  resolveContext({
    close: async () => {
      closed += 1;
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, 1);
});

test("Claude browser responses are bounded before schema validation", async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-profile-"));
  const result = await fetchUsageForAccount(
    {
      authKey: "work",
      name: "work",
      profileDir,
      storagePath: path.join(profileDir, "missing.json"),
    },
    {
      runtime: browserRuntime(
        {
          content: async () => "<html>ready</html>",
          evaluate: async () => [
            { ...organization, name: "x".repeat(1024 * 1024) },
          ],
          goto: async () => undefined,
        },
        () => undefined,
      ),
    },
  );
  assert.match(result.error ?? "", /exceeded the allowed size/);
});

test("interactive Claude and Cursor login use injected browser seams and close once", async () => {
  for (const provider of ["claude", "cursor"] as const) {
    let closed = 0;
    const page = {
      evaluate: async () =>
        provider === "claude" ? [organization] : { email: "user@example.com" },
      goto: async () => undefined,
      url: () =>
        provider === "claude" ? "https://claude.ai/new" : "https://cursor.com/",
      waitForTimeout: async () => undefined,
    };
    const runtime = browserRuntime(page, () => {
      closed += 1;
    });
    const result =
      provider === "claude"
        ? await addAccount("work", { quiet: true, runtime })
        : await addCursorAccount("work", { quiet: true, runtime });
    assert.deepEqual(result, { cookies: [], origins: [] });
    assert.equal(closed, 1);
  }
});

test("interactive login timeout and verification failure return null and close", async () => {
  let closed = 0;
  const timeoutPage = {
    evaluate: async () => false,
    goto: async () => undefined,
    url: () => "https://example.com/login",
    waitForTimeout: async () => undefined,
  };
  const timeoutRuntime = browserRuntime(timeoutPage, () => {
    closed += 1;
  });
  let clockCalls = 0;
  timeoutRuntime.now = () => (clockCalls++ === 0 ? 0 : 300_001);
  assert.equal(
    await addCursorAccount("work", { quiet: true, runtime: timeoutRuntime }),
    null,
  );

  const invalidPage = {
    evaluate: async () => [],
    goto: async () => undefined,
    url: () => "https://claude.ai/new",
    waitForTimeout: async () => undefined,
  };
  assert.equal(
    await addAccount("work", {
      quiet: true,
      runtime: browserRuntime(invalidPage, () => {
        closed += 1;
      }),
    }),
    null,
  );
  assert.equal(closed, 2);
});

test("fetchAllUsage preserves input order and reports progress paths", async () => {
  const results = await fetchAllUsage(
    [
      {
        authKey: "one",
        name: "one",
        profileDir: "/missing-one",
        storagePath: "/missing-one.json",
      },
      {
        authKey: "two",
        name: "two",
        profileDir: "/missing-two",
        storagePath: "/missing-two.json",
      },
    ],
    { quiet: true },
  );
  assert.deepEqual(
    results.map((result) => result.name),
    ["one", "two"],
  );
});

function temporaryFile(name: string, content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-api-"));
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function response(
  status: number,
  body: unknown,
  contentType = "application/json",
) {
  const encoded = Buffer.from(JSON.stringify(body));
  return {
    body: async () => encoded,
    headers: () => ({
      "content-length": String(encoded.byteLength),
      "content-type": contentType,
    }),
    json: async () => body,
    ok: () => status >= 200 && status < 300,
    status: () => status,
  };
}

function requestRuntime(
  get: (url: string) => Promise<unknown>,
  dispose: () => void = () => undefined,
): Partial<ApiRuntime> {
  return {
    newRequestContext: (async () => ({
      dispose: async () => dispose(),
      get,
      storageState: async () => ({ cookies: [], origins: [] }),
    })) as ApiRuntime["newRequestContext"],
  };
}

function browserRuntime(
  page: Record<string, unknown>,
  close: () => void,
): Partial<ApiRuntime> {
  return {
    assertChromeInstalled: () => undefined,
    launchPersistentContext: (async () => ({
      close: async () => close(),
      newPage: async () => page,
      pages: () => [page],
      storageState: async () => ({ cookies: [], origins: [] }),
    })) as ApiRuntime["launchPersistentContext"],
  };
}
