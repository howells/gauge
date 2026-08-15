import fs from "node:fs";
import {
  type APIResponse,
  chromium,
  type Page,
  request,
} from "playwright-core";
import { assertChromeInstalled } from "./chrome.js";
import { getProfileDir, getStorageStatePath, lockFile } from "./paths.js";
import type {
  AccountUsage,
  Organization,
  Plan,
  UsageResponse,
} from "./types.js";

interface AccountRef {
  authKey: string;
  name: string;
  renewsAt?: string | null;
}

function toAccountRef(account: string | AccountRef): AccountRef {
  return typeof account === "string"
    ? { authKey: account, name: account }
    : account;
}

function derivePlan(org: Organization): Plan {
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
  if (org.capabilities.includes("chat")) {
    return "pro";
  }
  return "unknown";
}

const CLAUDE_URL = "https://claude.ai";
const CURSOR_URL = "https://cursor.com";
const LOGIN_URL_RE = /claude\.ai\/(new|recents|chat|settings)/;
const LOGIN_TIMEOUT_MS = 300_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/** Open a Chrome browser for the user to log in and persist the session. */
export async function addAccount(
  name: string,
  options: { authKey?: string; quiet?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  assertChromeInstalled();
  const authKey = options.authKey ?? name;
  const profileDir = getProfileDir(authKey);
  const quiet = options.quiet ?? false;
  const signal = options.signal;
  throwIfAborted(signal);

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

  const context = await chromium.launchPersistentContext(profileDir, {
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
    throwIfAborted(signal);
    const page = context.pages()[0] || (await context.newPage());

    await raceWithAbort(
      page.goto(`${CLAUDE_URL}/login`, { waitUntil: "domcontentloaded" }),
      signal,
    );

    const loginDetected = await waitForLoginSignal(
      page,
      LOGIN_TIMEOUT_MS,
      signal,
    );
    if (!loginDetected) {
      if (!quiet) {
        console.error("Login timed out. Please try again.");
      }
      return false;
    }

    if (!quiet) {
      console.log("Login detected, verifying...");
    }

    // Give it a moment for cookies to settle
    await waitForTimeout(page, 2000, signal);

    try {
      await assertLoggedIn(page);
    } catch {
      if (!quiet) {
        console.error(
          "Login verification failed. Please make sure you're logged in.",
        );
      }
      return false;
    }

    const storagePath = getStorageStatePath(authKey);
    await context.storageState({ path: storagePath });
    lockFile(storagePath);
    return true;
  } finally {
    await context.close();
  }
}

/** Open Chrome for Cursor login and persist the session as storage state. */
export async function addCursorAccount(
  name: string,
  options: { authKey?: string; quiet?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  assertChromeInstalled();
  const authKey = options.authKey ?? name;
  const profileDir = getProfileDir(authKey);
  const quiet = options.quiet ?? false;
  const signal = options.signal;
  throwIfAborted(signal);

  if (!quiet) {
    console.log(`\nOpening browser for Cursor account "${name}"...`);
    console.log(
      "Please log in to Cursor. The browser will close automatically when done.\n",
    );
  }

  const context = await chromium.launchPersistentContext(profileDir, {
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
    throwIfAborted(signal);
    const page = context.pages()[0] || (await context.newPage());
    await raceWithAbort(
      page.goto(`${CURSOR_URL}/login`, { waitUntil: "domcontentloaded" }),
      signal,
    );

    const loginDetected = await waitForCursorLoginSignal(
      page,
      LOGIN_TIMEOUT_MS,
      signal,
    );
    if (!loginDetected) {
      if (!quiet) {
        console.error("Cursor login timed out. Please try again.");
      }
      return false;
    }

    await waitForTimeout(page, 1000, signal);
    const storagePath = getStorageStatePath(authKey);
    await context.storageState({ path: storagePath });
    lockFile(storagePath);

    return true;
  } finally {
    await context.close();
  }
}

/** Fetch usage data for a single account, falling back to browser if the API request fails. */
export async function fetchUsageForAccount(
  account: string | AccountRef,
): Promise<AccountUsage> {
  const { authKey, name, renewsAt } = toAccountRef(account);
  const profileDir = getProfileDir(authKey);
  const storagePath = getStorageStatePath(authKey);

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

  const requestResult = await fetchUsageViaRequest(name, storagePath, renewsAt);
  if (requestResult) {
    return requestResult;
  }

  assertChromeInstalled();

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false, // Must be visible to bypass Cloudflare
    channel: "chrome",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-extensions",
      "--window-size=800,600",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    viewport: { width: 800, height: 600 },
  });

  const page = context.pages()[0] || (await context.newPage());

  try {
    // Navigate to get cookies working
    await page.goto(`${CLAUDE_URL}/settings/usage`, {
      waitUntil: "domcontentloaded",
    });

    // Check if we hit Cloudflare
    const content = await page.content();
    if (
      content.includes("Just a moment") ||
      content.includes("challenge-platform") ||
      content.includes("cf-turnstile")
    ) {
      throw new Error(`Cloudflare block - run: gauge refresh ${name}`);
    }

    const orgs = await fetchOrganizationsFromPage(page);
    const org = orgs?.[0];
    if (!org) {
      throw new Error("No organizations found");
    }

    const plan = derivePlan(org);

    const usageResponse = await fetchUsageFromPage(page, org.uuid);
    const fetchedRenewsAt = await fetchRenewalFromPage(page, org.uuid);

    await context.storageState({ path: storagePath });
    lockFile(storagePath);

    await context.close();

    return {
      name,
      plan,
      renewsAt: fetchedRenewsAt ?? renewsAt,
      orgUuid: org.uuid,
      usage: usageResponse as UsageResponse,
    };
  } catch (error) {
    await context.close();
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
  }
}

/** Fetch usage data for multiple accounts sequentially. */
export async function fetchAllUsage(
  accounts: Array<string | AccountRef>,
  options: { quiet?: boolean } = {},
): Promise<AccountUsage[]> {
  // Fetch sequentially - parallel would open too many browser windows
  const results: AccountUsage[] = [];
  const quiet = options.quiet ?? false;
  for (const account of accounts) {
    const accountRef = toAccountRef(account);
    if (!quiet) {
      process.stdout.write(`  Checking ${accountRef.name}...`);
    }
    const usage = await fetchUsageForAccount(accountRef);
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
  signal?: AbortSignal,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    const currentUrl = page.url();
    if (LOGIN_URL_RE.test(currentUrl)) {
      return true;
    }

    try {
      const ok = await page.evaluate(async () => {
        try {
          const res = await fetch("https://claude.ai/api/organizations");
          return res.ok;
        } catch {
          return false;
        }
      });
      if (ok) {
        return true;
      }
    } catch {
      // Ignore transient navigation errors while the user is logging in.
    }

    await waitForTimeout(page, 2000, signal);
  }
  return false;
}

async function waitForCursorLoginSignal(
  page: Page,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    if (/cursor\.com/i.test(page.url())) {
      try {
        const ok = await page.evaluate(async () => {
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
        });
        if (ok) return true;
      } catch {
        // Ignore transient navigation errors while the user is logging in.
      }
    }

    await waitForTimeout(page, 2000, signal);
  }
  return false;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Cancelled");
  }
}

async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return Promise.race([promise, abortPromise(signal)]);
}

async function waitForTimeout(
  page: Page,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  await raceWithAbort(page.waitForTimeout(ms), signal);
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = (): void => reject(new Error("Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function assertLoggedIn(page: Page): Promise<void> {
  const orgs = await fetchOrganizationsFromPage(page);
  if (!orgs || orgs.length === 0) {
    throw new Error("No organizations found");
  }
}

async function fetchOrganizationsFromPage(page: Page): Promise<Organization[]> {
  const orgsResponse = await page.evaluate(async () => {
    const res = await fetch("https://claude.ai/api/organizations");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  });
  return orgsResponse as Organization[];
}

async function fetchUsageFromPage(
  page: Page,
  uuid: string,
): Promise<UsageResponse> {
  const usageResponse = await page.evaluate(async (orgUuid: string) => {
    const res = await fetch(
      `https://claude.ai/api/organizations/${encodeURIComponent(orgUuid)}/usage`,
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }, uuid);
  return usageResponse as UsageResponse;
}

async function fetchRenewalFromPage(
  page: Page,
  uuid: string,
): Promise<string | null> {
  try {
    const subscriptionDetails = await page.evaluate(async (orgUuid: string) => {
      const res = await fetch(
        `https://claude.ai/api/organizations/${encodeURIComponent(orgUuid)}/subscription_details?cached=false`,
      );
      if (!res.ok) return null;
      return res.json();
    }, uuid);
    return extractClaudeRenewal(subscriptionDetails);
  } catch {
    return null;
  }
}

function extractClaudeRenewal(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return (
    normalizeDate(record.next_charge_at) ??
    normalizeDate(record.next_charge_date)
  );
}

function normalizeDate(value: unknown): string | null {
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
): Promise<AccountUsage | null> {
  if (!fs.existsSync(storagePath)) {
    return null;
  }

  const api = await request.newContext({
    baseURL: CLAUDE_URL,
    storageState: storagePath,
    extraHTTPHeaders: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
  });

  try {
    const orgsRes = await api.get("/api/organizations");
    const orgsCheck = checkResponse(name, orgsRes, renewsAt);
    if (orgsCheck !== "ok") {
      return orgsCheck;
    }

    const orgs = (await orgsRes.json()) as Organization[];
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

    const usageRes = await api.get(
      `/api/organizations/${encodeURIComponent(org.uuid)}/usage`,
    );
    const usageCheck = checkResponse(name, usageRes, renewsAt);
    if (usageCheck !== "ok") {
      return usageCheck;
    }

    const usage = (await usageRes.json()) as UsageResponse;
    const fetchedRenewsAt = await fetchRenewalViaRequest(api, org.uuid);

    await api.storageState({ path: storagePath });
    lockFile(storagePath);

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
): Promise<string | null> {
  try {
    const res = await api.get(
      `/api/organizations/${encodeURIComponent(uuid)}/subscription_details?cached=false`,
    );
    if (!res.ok()) return null;
    const contentType = res.headers()["content-type"] ?? "";
    if (!contentType.includes("application/json")) return null;
    return extractClaudeRenewal(await res.json());
  } catch {
    return null;
  }
}
