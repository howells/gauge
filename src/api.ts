import fs from "node:fs";
import {
  type APIResponse,
  chromium,
  type Page,
  request,
} from "playwright-core";
import { assertChromeInstalled } from "./chrome.js";
import { getDataDir, getProfileDir, getStorageStatePath } from "./paths.js";
import { fetchOAuthUsage } from "./providers/oauth-usage.js";
import {
  ClaudeOrganizationListSchema,
  ClaudeRenewalSchema,
  ClaudeUsageResponseSchema,
} from "./providers/upstream-schemas.js";
import { raceWithTimeout } from "./runtime/deadline.js";
import {
  claudeAccessTokenFor,
  readClaudeSession,
} from "./services/claude-session.js";
import { claudeAccountNamesByUuid } from "./services/machine-logins.js";
import type { PlaywrightStorageState } from "./storage-state.js";

interface UsageLimit {
  resets_at: string;
  utilization: number;
}

interface UsageResponse {
  extra_usage: unknown;
  five_hour: UsageLimit | null;
  iguana_necktie: UsageLimit | null;
  seven_day: UsageLimit | null;
  seven_day_cowork: UsageLimit | null;
  seven_day_oauth_apps: UsageLimit | null;
  seven_day_opus: UsageLimit | null;
  seven_day_sonnet: UsageLimit | null;
}

export interface Organization {
  billing_type?: string | null;
  capabilities: string[];
  id: number;
  name: string;
  rate_limit_tier: string | null;
  uuid: string;
}

export type Plan = "free" | "pro" | "max_5x" | "max_20x" | "max" | "unknown";

export interface AccountUsage {
  error?: string;
  name: string;
  orgUuid: string;
  plan: Plan;
  renewsAt?: string | null;
  usage: UsageResponse;
}

interface AccountRef {
  authKey: string;
  name: string;
  profileDir?: string;
  renewsAt?: string | null;
  storagePath?: string;
}

export interface ApiRuntime {
  assertChromeInstalled: () => void;
  launchPersistentContext: typeof chromium.launchPersistentContext;
  newRequestContext: typeof request.newContext;
  now: () => number;
}

export type BrowserAcquirer = <T>(operation: () => Promise<T>) => Promise<T>;

const defaultRuntime: ApiRuntime = {
  assertChromeInstalled,
  launchPersistentContext: chromium.launchPersistentContext.bind(chromium),
  newRequestContext: request.newContext.bind(request),
  now: Date.now,
};

function resolveRuntime(runtime?: Partial<ApiRuntime>): ApiRuntime {
  return { ...defaultRuntime, ...runtime };
}

function toAccountRef(account: string | AccountRef): AccountRef {
  return typeof account === "string"
    ? { authKey: account, name: account }
    : account;
}

export function derivePlan(org: Organization): Plan {
  const tier = org.rate_limit_tier ?? "";
  if (tier.includes("claude_max_20x")) {
    return "max_20x";
  }
  if (tier.includes("claude_max_5x")) {
    return "max_5x";
  }
  if (tier.includes("claude_max")) {
    return "max";
  }
  if (org.capabilities.includes("claude_max")) {
    return "max";
  }
  // Free accounts carry no subscription (billing_type "none") while paid
  // tiers report their billing source; both still list the "chat" capability.
  if (org.billing_type === "none") {
    return "free";
  }
  if (org.capabilities.includes("chat")) {
    return "pro";
  }
  return "unknown";
}

const CLAUDE_URL = "https://claude.ai";
const CURSOR_URL = "https://cursor.com";
const LOGIN_URL_RE = /claude\.ai\/(new|recents|chat|settings)/;
const LOGIN_TIMEOUT_MS = 300_000;
const LOGIN_PROBE_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/** Open a Chrome browser for the user to log in and persist the session. */
export async function addAccount(
  name: string,
  options: {
    profileDir?: string;
    quiet?: boolean;
    runtime?: Partial<ApiRuntime>;
  } = {},
): Promise<PlaywrightStorageState | null> {
  const runtime = resolveRuntime(options.runtime);
  runtime.assertChromeInstalled();
  const profileDir = options.profileDir ?? getProfileDir(name);
  const quiet = options.quiet ?? false;

  // Use launchPersistentContext with a real Chrome executable
  // This creates a more realistic browser fingerprint
  if (!quiet) {
    console.log(`\nOpening browser for account "${name}"...`);
    console.log(
      "Please log in to Claude. The browser will close automatically when done.",
    );
    console.log(
      "(If Cloudflare blocks you, try logging in first in your regular Chrome)\n",
    );
  }

  const context = await runtime.launchPersistentContext(profileDir, {
    headless: false,
    channel: "chrome", // Use installed Chrome instead of Playwright's Chromium
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
    ],
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${CLAUDE_URL}/login`, { waitUntil: "domcontentloaded" });
    const loginDetected = await waitForLoginSignal(
      page,
      LOGIN_TIMEOUT_MS,
      runtime.now,
    );
    if (!loginDetected) {
      if (!quiet) console.error("Login timed out. Please try again.");
      return null;
    }
    if (!quiet) console.log("Login detected, verifying...");
    await page.waitForTimeout(2000);
    await assertLoggedIn(page);
    return await context.storageState();
  } catch {
    if (!quiet) {
      console.error(
        "Login verification failed. Please make sure you're logged in.",
      );
    }
    return null;
  } finally {
    await context.close();
  }
}

/** Open Chrome for Cursor login and persist the session as storage state. */
export async function addCursorAccount(
  name: string,
  options: {
    profileDir?: string;
    quiet?: boolean;
    runtime?: Partial<ApiRuntime>;
  } = {},
): Promise<PlaywrightStorageState | null> {
  const runtime = resolveRuntime(options.runtime);
  runtime.assertChromeInstalled();
  const profileDir = options.profileDir ?? getProfileDir(name);
  const quiet = options.quiet ?? false;

  if (!quiet) {
    console.log(`\nOpening browser for Cursor account "${name}"...`);
    console.log(
      "Please log in to Cursor. The browser will close automatically when done.\n",
    );
  }

  const context = await runtime.launchPersistentContext(profileDir, {
    headless: false,
    channel: "chrome",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
    ],
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    ignoreDefaultArgs: ["--enable-automation"],
  });

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(`${CURSOR_URL}/login`, { waitUntil: "domcontentloaded" });
    const loginDetected = await waitForCursorLoginSignal(
      page,
      LOGIN_TIMEOUT_MS,
      runtime.now,
    );
    if (!loginDetected) {
      if (!quiet) console.error("Cursor login timed out. Please try again.");
      return null;
    }
    await page.waitForTimeout(1000);
    return await context.storageState();
  } finally {
    await context.close();
  }
}

/** Fetch usage data for a single account, falling back to browser if the API request fails. */
export async function fetchUsageForAccount(
  account: string | AccountRef,
  options: {
    credentialRefresh?: "refresh-if-stale" | "never";
    acquireBrowser?: BrowserAcquirer;
    onStorageStateUpdate?: (value: unknown) => void;
    signal?: AbortSignal;
    runtime?: Partial<ApiRuntime>;
  } = {},
): Promise<AccountUsage> {
  const runtime = resolveRuntime(options.runtime);
  const {
    authKey,
    name,
    profileDir: explicitProfileDir,
    renewsAt,
    storagePath: explicitStoragePath,
  } = toAccountRef(account);
  const profileDir = explicitProfileDir ?? getProfileDir(authKey);
  const storagePath = explicitStoragePath ?? getStorageStatePath(authKey);

  if (!(fs.existsSync(profileDir) || fs.existsSync(storagePath))) {
    return {
      name,
      plan: "unknown",
      renewsAt,
      orgUuid: "",
      usage: {} as UsageResponse,
      error: `No saved session. Run: gauge add ${name}`,
    };
  }

  if (options.signal?.aborted) throw options.signal.reason;

  // The token first, the cookies second. An account signed into Claude Code
  // carries an OAuth credential the Anthropic API accepts, and reading usage
  // with it costs one request and no browser at all — where the cookie path can
  // end in a Chrome launch, a Cloudflare challenge and a login to sit through.
  // Null from here means "no token, or one that is no longer accepted", which
  // is a reason to fall through quietly and never a reason to fail an account.
  const viaToken = await fetchUsageViaOAuth(name, renewsAt, runtime);
  if (viaToken) {
    return viaToken;
  }

  const requestResult = await fetchUsageViaRequest(
    name,
    storagePath,
    renewsAt,
    options.credentialRefresh,
    options.onStorageStateUpdate,
    runtime,
    options.signal,
  );
  if (requestResult) {
    return requestResult;
  }

  if (options.signal?.aborted) {
    throw options.signal.reason ?? abortError();
  }

  if (options.credentialRefresh === "never") {
    return {
      name,
      plan: "unknown",
      renewsAt,
      orgUuid: "",
      usage: {} as UsageResponse,
      error:
        "Existing credentials were rejected; credential refresh is disabled.",
    };
  }

  const acquireBrowser = options.acquireBrowser ?? ((operation) => operation());
  return acquireBrowser(() =>
    fetchUsageViaBrowser(
      name,
      profileDir,
      renewsAt,
      options,
      runtime,
      options.signal,
    ),
  );
}

async function fetchUsageViaBrowser(
  name: string,
  profileDir: string,
  renewsAt: string | null | undefined,
  options: {
    onStorageStateUpdate?: (value: unknown) => void;
  },
  runtime: ApiRuntime,
  signal?: AbortSignal,
): Promise<AccountUsage> {
  runtime.assertChromeInstalled();
  const context = await acquireAbortableResource(
    runtime.launchPersistentContext(profileDir, {
      headless: false, // Must be visible to bypass Cloudflare
      channel: "chrome",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disable-extensions",
        "--window-size=800,600",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      viewport: { width: 800, height: 600 },
    }),
    signal,
    (lateContext) => lateContext.close(),
  );

  try {
    const page =
      context.pages()[0] || (await abortable(context.newPage(), signal));
    // Navigate to get cookies working
    await abortable(
      page.goto(`${CLAUDE_URL}/settings/usage`, {
        waitUntil: "domcontentloaded",
      }),
      signal,
    );

    // Check if we hit Cloudflare
    const content = await abortable(page.content(), signal);
    if (
      content.includes("Just a moment") ||
      content.includes("challenge-platform") ||
      content.includes("cf-turnstile")
    ) {
      throw new Error(`Cloudflare block - run: gauge refresh ${name}`);
    }

    const orgs = await abortable(fetchOrganizationsFromPage(page), signal);
    const org = orgs?.[0];
    if (!org) {
      throw new Error("No organizations found");
    }

    const plan = derivePlan(org);

    const usageResponse = await abortable(
      fetchUsageFromPage(page, org.uuid),
      signal,
    );
    const fetchedRenewsAt = await abortable(
      fetchRenewalFromPage(page, org.uuid),
      signal,
    );

    options.onStorageStateUpdate?.(
      await abortable(context.storageState(), signal),
    );

    return {
      name,
      plan,
      renewsAt: fetchedRenewsAt ?? renewsAt,
      orgUuid: org.uuid,
      usage: usageResponse as UsageResponse,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("401") || message.includes("403")) {
      return expiredError(name, renewsAt);
    }

    return {
      name,
      plan: "unknown",
      renewsAt,
      orgUuid: "",
      usage: {} as UsageResponse,
      error: message,
    };
  } finally {
    await context.close();
  }
}

/**
 * Usage for one account from its Claude Code token, or null to fall back.
 *
 * The account is identified by matching the signed-in profile's `accountUuid`
 * against the browser state gauge kept when it added the account — the same
 * join that names the desktop app's account — because the token itself carries
 * no gauge account name.
 */
async function fetchUsageViaOAuth(
  name: string,
  renewsAt: string | null | undefined,
  runtime: ApiRuntime,
): Promise<AccountUsage | null> {
  try {
    const dataDir = getDataDir();
    const live = readClaudeSession();
    const liveUuid = live?.profile.accountUuid;
    const liveName =
      typeof liveUuid === "string"
        ? claudeAccountNamesByUuid(dataDir).get(liveUuid)
        : undefined;
    const token = claudeAccessTokenFor(name, dataDir, liveName);
    if (!token) return null;
    const reading = await fetchOAuthUsage(token);
    if (!reading) return null;
    const [session, weekly] = reading.windows;
    const limit = (
      window: { resetsAt: string; usedPercent: number } | undefined,
    ): UsageLimit | null =>
      window
        ? { resets_at: window.resetsAt, utilization: window.usedPercent }
        : null;
    return {
      name,
      plan: (reading.plan ?? "unknown") as AccountUsage["plan"],
      renewsAt,
      orgUuid: "",
      usage: {
        extra_usage: null,
        five_hour: limit(session),
        iguana_necktie: null,
        seven_day: limit(weekly),
        seven_day_cowork: null,
        seven_day_oauth_apps: null,
        seven_day_opus: null,
        seven_day_sonnet: null,
      },
    } satisfies AccountUsage;
  } catch {
    return null;
  }
}

/** Fetch usage data for multiple accounts sequentially. */
export async function fetchAllUsage(
  accounts: Array<string | AccountRef>,
  options: {
    credentialRefresh?: "refresh-if-stale" | "never";
    acquireBrowser?: BrowserAcquirer;
    onStorageStateUpdate?: (account: AccountRef, value: unknown) => void;
    quiet?: boolean;
    signal?: AbortSignal;
    runtime?: Partial<ApiRuntime>;
  } = {},
): Promise<AccountUsage[]> {
  // Fetch sequentially - parallel would open too many browser windows
  const results: AccountUsage[] = [];
  const quiet = options.quiet ?? false;
  for (const account of accounts) {
    const accountRef = toAccountRef(account);
    if (!quiet) {
      process.stdout.write(`  Checking ${accountRef.name}...`);
    }
    const usage = await fetchUsageForAccount(accountRef, {
      credentialRefresh: options.credentialRefresh,
      acquireBrowser: options.acquireBrowser,
      signal: options.signal,
      runtime: options.runtime,
      onStorageStateUpdate: (value) =>
        options.onStorageStateUpdate?.(accountRef, value),
    });
    if (!quiet) {
      if (usage.error) {
        console.log(" error");
      } else {
        console.log(` ${usage.usage.five_hour?.utilization ?? 0}% session`);
      }
    }
    results.push(usage);
  }
  return results;
}

async function waitForLoginSignal(
  page: Page,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<boolean> {
  const start = now();
  while (now() - start < timeoutMs) {
    const currentUrl = page.url();
    if (LOGIN_URL_RE.test(currentUrl)) {
      return true;
    }

    try {
      const ok = await raceWithTimeout(
        page.evaluate(async () => {
          try {
            const res = await fetch("https://claude.ai/api/organizations");
            return res.ok;
          } catch {
            return false;
          }
        }),
        LOGIN_PROBE_TIMEOUT_MS,
        false,
      );
      if (ok) {
        return true;
      }
    } catch {
      // Ignore transient navigation errors while the user is logging in.
    }

    await page.waitForTimeout(2000);
  }
  return false;
}

async function waitForCursorLoginSignal(
  page: Page,
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<boolean> {
  const start = now();
  while (now() - start < timeoutMs) {
    if (/cursor\.com/i.test(page.url())) {
      try {
        const ok = await raceWithTimeout(
          page.evaluate(async () => {
            try {
              const res = await fetch("/api/auth/me", {
                headers: { Accept: "application/json" },
              });
              if (!res.ok) return false;
              const data = (await res.json()) as Record<string, unknown>;
              return Boolean(data.email || data.name || data.sub || data.id);
            } catch {
              return false;
            }
          }),
          LOGIN_PROBE_TIMEOUT_MS,
          false,
        );
        if (ok) return true;
      } catch {
        // Ignore transient navigation errors while the user is logging in.
      }
    }

    await page.waitForTimeout(2000);
  }
  return false;
}

async function assertLoggedIn(page: Page): Promise<void> {
  const orgs = await fetchOrganizationsFromPage(page);
  if (!orgs || orgs.length === 0) {
    throw new Error("No organizations found");
  }
}

async function fetchOrganizationsFromPage(page: Page): Promise<Organization[]> {
  const orgsResponse = await fetchBoundedJsonFromPage(
    page,
    "https://claude.ai/api/organizations",
  );
  assertBoundedValue(orgsResponse);
  return ClaudeOrganizationListSchema.parse(orgsResponse);
}

async function fetchUsageFromPage(
  page: Page,
  uuid: string,
): Promise<UsageResponse> {
  const usageResponse = await fetchBoundedJsonFromPage(
    page,
    `https://claude.ai/api/organizations/${encodeURIComponent(uuid)}/usage`,
  );
  assertBoundedValue(usageResponse);
  return ClaudeUsageResponseSchema.parse(usageResponse);
}

async function fetchRenewalFromPage(
  page: Page,
  uuid: string,
): Promise<string | null> {
  try {
    const subscriptionDetails = await fetchBoundedJsonFromPage(
      page,
      `https://claude.ai/api/organizations/${encodeURIComponent(uuid)}/subscription_details?cached=false`,
      true,
    );
    assertBoundedValue(subscriptionDetails);
    return extractClaudeRenewal(subscriptionDetails);
  } catch {
    return null;
  }
}

async function fetchBoundedJsonFromPage(
  page: Page,
  url: string,
  nullOnHttpError = false,
): Promise<unknown> {
  return page.evaluate(
    async ({ requestUrl, returnNullOnHttpError }) => {
      const response = await fetch(requestUrl);
      if (!response.ok) {
        if (returnNullOnHttpError) return null;
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.body) throw new Error("Provider response has no body.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > 1024 * 1024) {
            await reader.cancel();
            throw new Error("Provider response exceeded the allowed size.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    },
    { requestUrl: url, returnNullOnHttpError: nullOnHttpError },
  );
}

export function extractClaudeRenewal(value: unknown): string | null {
  const parsed = ClaudeRenewalSchema.safeParse(value);
  if (!parsed.success) return null;
  return (
    normalizeDate(parsed.data.next_charge_at) ??
    normalizeDate(parsed.data.next_charge_date)
  );
}

export function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function expiredError(name: string, renewsAt?: string | null): AccountUsage {
  return {
    name,
    plan: "unknown",
    renewsAt,
    orgUuid: "",
    usage: {} as UsageResponse,
    error: `Session expired. Run: gauge refresh ${name}`,
  };
}

function checkResponse(
  name: string,
  res: APIResponse,
  renewsAt?: string | null,
): AccountUsage | null | "ok" {
  if (res.status() === 401) {
    return expiredError(name, renewsAt);
  }
  if (res.status() === 403) {
    const contentType = res.headers()["content-type"] ?? "";
    return contentType.includes("text/html")
      ? null
      : expiredError(name, renewsAt);
  }
  return res.ok() ? "ok" : null;
}

async function fetchUsageViaRequest(
  name: string,
  storagePath: string,
  renewsAt?: string | null,
  credentialRefresh: "refresh-if-stale" | "never" = "refresh-if-stale",
  onStorageStateUpdate?: (value: unknown) => void,
  runtime: ApiRuntime = defaultRuntime,
  signal?: AbortSignal,
): Promise<AccountUsage | null> {
  if (!fs.existsSync(storagePath)) {
    return null;
  }

  const api = await acquireAbortableResource(
    runtime.newRequestContext({
      baseURL: CLAUDE_URL,
      storageState: storagePath,
      extraHTTPHeaders: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    }),
    signal,
    (lateApi) => lateApi.dispose(),
  );

  try {
    const orgsRes = await abortable(api.get("/api/organizations"), signal);
    const orgsCheck = checkResponse(name, orgsRes, renewsAt);
    if (orgsCheck !== "ok") {
      return orgsCheck;
    }

    const orgs = ClaudeOrganizationListSchema.parse(
      await parseBoundedApiResponse(orgsRes, signal),
    );
    const org = orgs?.[0];
    if (!org) {
      return {
        name,
        plan: "unknown",
        renewsAt,
        orgUuid: "",
        usage: {} as UsageResponse,
        error: "No organizations found",
      };
    }

    const plan = derivePlan(org);

    const [usageRes, fetchedRenewsAt] = await Promise.all([
      abortable(
        api.get(`/api/organizations/${encodeURIComponent(org.uuid)}/usage`),
        signal,
      ),
      fetchRenewalViaRequest(api, org.uuid, signal),
    ]);
    const usageCheck = checkResponse(name, usageRes, renewsAt);
    if (usageCheck !== "ok") {
      return usageCheck;
    }

    const usage = ClaudeUsageResponseSchema.parse(
      await parseBoundedApiResponse(usageRes, signal),
    );

    if (credentialRefresh === "refresh-if-stale") {
      onStorageStateUpdate?.(await abortable(api.storageState(), signal));
    }

    return {
      name,
      plan,
      renewsAt: fetchedRenewsAt ?? renewsAt,
      orgUuid: org.uuid,
      usage,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("401")) {
      return expiredError(name, renewsAt);
    }
    return null;
  } finally {
    await api.dispose();
  }
}

async function fetchRenewalViaRequest(
  api: Awaited<ReturnType<typeof request.newContext>>,
  uuid: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await abortable(
      api.get(
        `/api/organizations/${encodeURIComponent(uuid)}/subscription_details?cached=false`,
      ),
      signal,
    );
    if (!res.ok()) return null;
    const contentType = res.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) return null;
    return extractClaudeRenewal(await parseBoundedApiResponse(res, signal));
  } catch {
    return null;
  }
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason ?? abortError());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function acquireAbortableResource<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  dispose: (resource: T) => Promise<unknown>,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.then(dispose, () => undefined).catch(() => undefined);
    return Promise.reject(signal.reason ?? abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let aborted = false;
    const abort = (): void => {
      aborted = true;
      reject(signal.reason ?? abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (resource) => {
        signal.removeEventListener("abort", abort);
        if (aborted || signal.aborted) {
          void dispose(resource).catch(() => undefined);
          return;
        }
        resolve(resource);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        if (!aborted) reject(error);
      },
    );
  });
}

async function parseBoundedApiResponse(
  response: APIResponse,
  signal?: AbortSignal,
): Promise<unknown> {
  // Providers commonly respond chunked (no content-length) — claude.ai does.
  // A declared length is advisory for early abort; the byteLength check below
  // is the real bound, matching parseBoundedResponse in provider-usage.ts.
  const declaredLength = Number(response.headers()["content-length"]);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new Error("Provider response exceeded the allowed size.");
  }
  const body = await abortable(response.body(), signal);
  if (body.byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new Error("Provider response exceeded the allowed size.");
  }
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new Error("Provider returned invalid JSON.");
  }
}

function assertBoundedValue(value: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new Error("Provider response exceeded the allowed size.");
  }
}

function abortError(): Error {
  const error = new Error("Provider request aborted.");
  error.name = "AbortError";
  return error;
}
