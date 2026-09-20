import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountDetails } from "./accounts.js";
import type { Provider } from "./domain/account.js";
import {
  CodexRefreshResponseSchema,
  CodexUsageResponseSchema,
  CursorUsageResponseSchema,
  CursorUserResponseSchema,
} from "./providers/upstream-schemas.js";

const CODEX_TOKEN_REFRESH_URL = "https://auth.openai.com/oauth/token";

const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const CODEX_TOKEN_REFRESH_AFTER_MS = 8 * 24 * 60 * 60 * 1000;

const CURSOR_BASE_URL = "https://cursor.com";

const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;

interface RateWindow {
  /** Null when the window is idle: nothing spent, so nothing counting down. */
  resetsAt: string | null;
  usedPercent: number;
}

interface UnifiedAccount {
  current?: boolean;
  email: string;
  error?: string;
  label: string;
  plan: string;
  provider: Provider;
  providerAccountId?: string;
  /**
   * Codex usage-limit resets: `resetsApplicable` of the `resetsAvailable`
   * held apply to the account's current usage state, and redeeming one
   * clears the spent limits at once.
   */
  resetsApplicable?: number;
  resetsAvailable?: number;
  renewsAt?: string | null;
  session: RateWindow | null;
  weekly: RateWindow | null;
  monthly: RateWindow | null;
}

interface CodexSource {
  email?: string;
  homePath: string;
  label?: string;
  renewsAt?: string | null;
}

interface CodexCredentials {
  accessToken: string;
  accountId?: string;
  idToken?: string;
  lastRefresh?: Date;
  refreshToken?: string;
}

export interface PendingCodexCredentialUpdate {
  accessToken: string;
  homePath: string;
  idToken?: string;
  lastRefresh: string;
  refreshToken?: string;
}

interface CursorSession {
  cookieHeader: string;
  label: string;
  renewsAt?: string | null;
}

const home = (...parts: string[]): string => path.join(os.homedir(), ...parts);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = (filePath: string): unknown =>
  JSON.parse(fs.readFileSync(filePath, "utf-8"));

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const dateValue = (value: unknown): Date | undefined => {
  const raw = stringValue(value);
  if (!raw) {
    return undefined;
  }
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
};

const labelFromEmail = (email: string): string => {
  const domain = email.split("@")[1] ?? email;
  return domain.split(".")[0] ?? email;
};

const normalizeReset = (value: unknown): string | null => {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
  }
  const numeric = numberValue(value);
  if (numeric === undefined) {
    return null;
  }
  const milliseconds = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
  return new Date(milliseconds).toISOString();
};

export const toRateWindow = (value: unknown): RateWindow | null => {
  if (!isRecord(value)) {
    return null;
  }
  const usedPercent = numberValue(
    value.used_percent ?? value.usedPercent ?? value.totalPercentUsed
  );
  if (usedPercent === undefined) {
    return null;
  }
  return {
    resetsAt: normalizeReset(value.reset_at ?? value.resetsAt),
    usedPercent,
  };
};

type CodexWindowKind = "session" | "weekly" | "monthly";

interface ClassifiedCodexWindow {
  kind: CodexWindowKind;
  window: RateWindow;
}

const classifyCodexWindow = (
  value: unknown,
  fallback: "session" | "weekly"
): ClassifiedCodexWindow | null => {
  const window = toRateWindow(value);
  if (!window) {
    return null;
  }
  const seconds = isRecord(value)
    ? numberValue(value.limit_window_seconds)
    : undefined;
  const minutes = seconds === undefined ? undefined : seconds / 60;
  return {
    kind:
      minutes === undefined
        ? fallback
        : minutes <= 24 * 60
          ? "session"
          : minutes <= 8 * 24 * 60
            ? "weekly"
            : "monthly",
    window,
  };
};

const classifiedCodexWindows = (
  rateLimit: unknown
): ClassifiedCodexWindow[] => {
  if (!isRecord(rateLimit)) {
    return [];
  }
  return [
    classifyCodexWindow(rateLimit.primary_window, "session"),
    classifyCodexWindow(rateLimit.secondary_window, "weekly"),
  ].filter((window): window is ClassifiedCodexWindow => window !== null);
};

export const decodeJwtPayload = (
  token: string | undefined
): Record<string, unknown> => {
  if (!token) {
    return {};
  }
  const part = token.split(".")[1];
  if (!part) {
    return {};
  }
  try {
    return JSON.parse(
      Buffer.from(part, "base64url").toString("utf-8")
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const titleCaseWords = (raw: string): string =>
  raw
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");

export const formatCodexPlan = (raw: unknown): string => {
  const value = stringValue(raw)?.toLowerCase();
  if (!value) {
    return "Pro";
  }
  if (value === "pro") {
    return "Pro 20x";
  }
  if (["prolite", "pro_lite", "pro-lite", "pro lite"].includes(value)) {
    return "Pro 5x";
  }
  return titleCaseWords(value);
};

const errorAccount = (
  provider: "codex" | "cursor",
  label: string,
  message: string,
  email = ""
): UnifiedAccount => ({
  email,
  error: message,
  label,
  monthly: null,
  plan: "",
  provider,
  session: null,
  weekly: null,
});

const discoverCodexSources = (): CodexSource[] => {
  const sources: CodexSource[] = [];
  const addSource = (source: CodexSource): void => {
    const authPath = path.join(source.homePath, "auth.json");
    if (!fs.existsSync(authPath)) {
      return;
    }
    if (sources.some((existing) => existing.homePath === source.homePath)) {
      return;
    }
    sources.push(source);
  };

  if (process.env.CODEX_HOME) {
    addSource({ homePath: process.env.CODEX_HOME });
    return sources;
  }

  addSource({ homePath: home(".codex") });

  return sources;
};

const codexSourcesFromAccounts = (accounts: AccountDetails[]): CodexSource[] =>
  accounts
    .filter((account) => account.provider === "codex" && account.codexHome)
    .map((account) => ({
      homePath: account.codexHome ?? "",
      label: account.name,
      renewsAt: account.renewsAt,
    }));

const loadCodexCredentials = (homePath: string): CodexCredentials => {
  const authPath = path.join(homePath, "auth.json");
  const auth = readJson(authPath);
  if (!isRecord(auth)) {
    throw new Error("Invalid Codex auth.json");
  }

  const apiKey = stringValue(auth.OPENAI_API_KEY);
  if (apiKey) {
    return { accessToken: apiKey };
  }

  const tokens = isRecord(auth.tokens) ? auth.tokens : {};
  const accessToken = stringValue(tokens.access_token ?? tokens.accessToken);
  if (!accessToken) {
    throw new Error("Codex access token missing");
  }

  return {
    accessToken,
    accountId: stringValue(tokens.account_id ?? tokens.accountId),
    idToken: stringValue(tokens.id_token ?? tokens.idToken),
    lastRefresh: dateValue(tokens.last_refresh ?? tokens.lastRefresh),
    refreshToken: stringValue(tokens.refresh_token ?? tokens.refreshToken),
  };
};

const shouldRefreshCodex = (credentials: CodexCredentials): boolean => {
  if (!credentials.refreshToken) {
    return false;
  }
  // No last_refresh means the access token's age is unknown (e.g. homes
  // managed by external tools) — treat unknown age as stale.
  if (!credentials.lastRefresh) {
    return true;
  }
  return (
    Date.now() - credentials.lastRefresh.getTime() >
    CODEX_TOKEN_REFRESH_AFTER_MS
  );
};

const readFileIfExists = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
};

const codexBaseUrl = (homePath: string): string => {
  const config = readFileIfExists(path.join(homePath, "config.toml"));
  const match = config?.match(/^\s*chatgpt_base_url\s*=\s*["']([^"']+)["']/mu);
  return match?.[1] ?? "https://chatgpt.com/backend-api/";
};

const codexUsageUrl = (baseUrl: string): string => {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const pathName = base.includes("/backend-api/")
    ? "wham/usage"
    : "api/codex/usage";
  return new URL(pathName, base).toString();
};

class ProviderHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

const isUnauthorized = (error: unknown): boolean =>
  error instanceof ProviderHttpError &&
  (error.status === 401 || error.status === 403);

const readBoundedResponseText = async (response: Response): Promise<string> => {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf-8") > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error("Provider response exceeded the allowed size.");
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Provider response exceeded the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total).toString("utf-8");
};

const parseBoundedResponse = async (response: Response): Promise<unknown> => {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new Error("Provider response exceeded the allowed size.");
  }
  const text = await readBoundedResponseText(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Provider returned invalid JSON.");
  }
};

const refreshCodexCredentials = async (
  source: CodexSource,
  credentials: CodexCredentials,
  onCredentialUpdate?: (update: PendingCodexCredentialUpdate) => void,
  signal?: AbortSignal
): Promise<CodexCredentials> => {
  if (!credentials.refreshToken) {
    return credentials;
  }

  const response = await fetch(CODEX_TOKEN_REFRESH_URL, {
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credentials.refreshToken,
      scope: "openid profile email",
    }),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    throw new Error(`Codex token refresh failed (${response.status})`);
  }

  const body = CodexRefreshResponseSchema.parse(
    await parseBoundedResponse(response)
  );
  const accessToken = body.access_token;

  const refreshed: CodexCredentials = {
    accessToken,
    accountId: credentials.accountId,
    idToken: stringValue(body.id_token) ?? credentials.idToken,
    lastRefresh: new Date(),
    refreshToken: stringValue(body.refresh_token) ?? credentials.refreshToken,
  };

  onCredentialUpdate?.({
    accessToken: refreshed.accessToken,
    homePath: source.homePath,
    lastRefresh:
      refreshed.lastRefresh?.toISOString() ?? new Date().toISOString(),
    ...(refreshed.idToken !== undefined && { idToken: refreshed.idToken }),
    ...(refreshed.refreshToken !== undefined && {
      refreshToken: refreshed.refreshToken,
    }),
  });
  return refreshed;
};

const fetchJson = async (
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<unknown> => {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "gauge",
      ...headers,
    },
    signal,
  });
  if (!response.ok) {
    throw new ProviderHttpError(response.status);
  }
  return await parseBoundedResponse(response);
};

const codexHeaders = (
  credentials: CodexCredentials
): Record<string, string> => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credentials.accessToken}`,
  };
  if (credentials.accountId) {
    headers["ChatGPT-Account-Id"] = credentials.accountId;
  }
  return headers;
};

const fetchCodexAccount = async (
  source: CodexSource,
  credentialRefresh: "refresh-if-stale" | "never" = "refresh-if-stale",
  onCredentialUpdate?: (update: PendingCodexCredentialUpdate) => void,
  signal?: AbortSignal
): Promise<UnifiedAccount> => {
  const initialCredentials = loadCodexCredentials(source.homePath);
  const mayRefresh = credentialRefresh === "refresh-if-stale";
  let credentials =
    mayRefresh && shouldRefreshCodex(initialCredentials)
      ? await refreshCodexCredentials(
          source,
          initialCredentials,
          onCredentialUpdate,
          signal
        )
      : initialCredentials;

  const usageUrl = codexUsageUrl(codexBaseUrl(source.homePath));
  let body: unknown;
  try {
    body = await fetchJson(usageUrl, codexHeaders(credentials), signal);
  } catch (error) {
    // `shouldRefreshCodex` only guesses, from how long ago the token was last
    // rotated. The server refusing it is the one authoritative answer, and it
    // routinely disagrees: a token seventeen hours old, far inside the eight-day
    // window, came back `token_expired` while a perfectly good refresh token sat
    // unused beside it. The account was reported as needing re-authentication —
    // sending the reader to do by hand what gauge could have done here.
    //
    // Only once, only on a refusal, and only when the credential has not already
    // been rotated on this pass, so a genuinely dead login still surfaces as one
    // instead of spinning.
    if (
      !mayRefresh ||
      !isUnauthorized(error) ||
      credentials !== initialCredentials ||
      !credentials.refreshToken
    ) {
      throw error;
    }
    credentials = await refreshCodexCredentials(
      source,
      credentials,
      onCredentialUpdate,
      signal
    );
    body = await fetchJson(usageUrl, codexHeaders(credentials), signal);
  }

  // Read identity from whichever token actually spoke, so a refresh that brings
  // a new `id_token` names the account by it.
  const identity = decodeJwtPayload(credentials.idToken);
  const email =
    source.email ??
    stringValue(identity.email) ??
    stringValue(identity["https://api.openai.com/auth/email"]) ??
    "";

  const usage = CodexUsageResponseSchema.parse(body);
  const windows = classifiedCodexWindows(usage.rate_limit);
  const pick = (kind: CodexWindowKind): RateWindow | null =>
    windows.find((candidate) => candidate.kind === kind)?.window ?? null;
  const session = pick("session");
  const weekly = pick("weekly");
  const monthly = pick("monthly");
  const label = source.label ?? (email ? labelFromEmail(email) : "codex");
  const resets = usage.rate_limit_reset_credits;

  return {
    email,
    label,
    monthly,
    plan: formatCodexPlan(usage.plan_type),
    provider: "codex",
    renewsAt: source.renewsAt,
    session,
    weekly,
    ...(resets && {
      resetsApplicable: resets.applicable_available_count,
      resetsAvailable: resets.available_count,
    }),
  };
};

const parseJsonString = (value: string): unknown | null => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const hasControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
};

const isSafeCookiePair = (name: string, value: string): boolean =>
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) &&
  !value.includes(";") &&
  !hasControlCharacters(value);

export const parseStorageStateCookies = (value: unknown): string | null => {
  if (!isRecord(value) || !Array.isArray(value.cookies)) {
    return null;
  }
  const pairs: string[] = [];
  for (const cookie of value.cookies) {
    if (!isRecord(cookie)) {
      continue;
    }
    const name = stringValue(cookie.name);
    const cookieValue = stringValue(cookie.value);
    const domain = stringValue(cookie.domain) ?? "";
    if (!name || !cookieValue || !isSafeCookiePair(name, cookieValue)) {
      continue;
    }
    const normalizedDomain = domain.replace(/^\./u, "").toLowerCase();
    if (
      !["cursor.com", "cursor.sh"].some(
        (root) =>
          normalizedDomain === root || normalizedDomain.endsWith(`.${root}`)
      )
    ) {
      continue;
    }
    pairs.push(`${name}=${cookieValue}`);
  }
  return pairs.length > 0 ? pairs.join("; ") : null;
};

export const parseStorageStateCookieFile = (
  filePath: string
): string | null => {
  const text = readFileIfExists(filePath);
  if (!text) {
    return null;
  }
  try {
    return parseStorageStateCookies(JSON.parse(text));
  } catch {
    return null;
  }
};

const cursorSessionsFromAccounts = (
  accounts: AccountDetails[]
): CursorSession[] => {
  const sessions: CursorSession[] = [];
  for (const account of accounts) {
    if (account.provider !== "cursor") {
      continue;
    }
    sessions.push({
      cookieHeader: parseStorageStateCookieFile(account.storagePath) ?? "",
      label: account.name,
      renewsAt: account.renewsAt,
    });
  }
  return sessions;
};

const normalizeRawCookieHeader = (value: string | undefined): string | null => {
  if (!value || hasControlCharacters(value)) {
    return null;
  }
  const pairs = value.split(";").map((pair) => pair.trim());
  if (
    pairs.length === 0 ||
    pairs.some((pair) => {
      const separator = pair.indexOf("=");
      if (separator <= 0) {
        return true;
      }
      return !isSafeCookiePair(
        pair.slice(0, separator),
        pair.slice(separator + 1)
      );
    })
  ) {
    return null;
  }
  return pairs.join("; ");
};

export const parseRawCookieFile = (filePath: string): string | null => {
  const text = readFileIfExists(filePath);
  return text ? normalizeRawCookieHeader(text) : null;
};

const discoverCursorSessions = (): CursorSession[] => {
  const sessions: CursorSession[] = [];
  const add = (
    cookieHeader: string | null | undefined,
    label: string
  ): void => {
    if (!cookieHeader) {
      return;
    }
    const trimmed = cookieHeader.trim();
    if (!trimmed) {
      return;
    }
    if (sessions.some((session) => session.cookieHeader === trimmed)) {
      return;
    }
    sessions.push({ cookieHeader: trimmed, label });
  };

  add(normalizeRawCookieHeader(process.env.GAUGE_CURSOR_COOKIE), "cursor");
  add(
    process.env.GAUGE_CURSOR_COOKIE_FILE
      ? parseRawCookieFile(process.env.GAUGE_CURSOR_COOKIE_FILE)
      : null,
    "cursor"
  );
  add(
    process.env.GAUGE_CURSOR_STORAGE_STATE_FILE
      ? parseStorageStateCookieFile(process.env.GAUGE_CURSOR_STORAGE_STATE_FILE)
      : null,
    "cursor"
  );
  add(
    process.env.GAUGE_CURSOR_STORAGE_STATE_JSON
      ? parseStorageStateCookies(
          parseJsonString(process.env.GAUGE_CURSOR_STORAGE_STATE_JSON)
        )
      : null,
    "cursor"
  );

  return sessions;
};

const ratioPercent = (used: unknown, limit: unknown): number | undefined => {
  const usedNumber = numberValue(used);
  const limitNumber = numberValue(limit);
  if (
    usedNumber === undefined ||
    limitNumber === undefined ||
    limitNumber <= 0
  ) {
    return undefined;
  }
  return (usedNumber / limitNumber) * 100;
};

export const cursorSecondaryPercent = (
  usage: Record<string, unknown>
): number | undefined => {
  const individual = isRecord(usage.individualUsage)
    ? usage.individualUsage
    : {};
  const team = isRecord(usage.teamUsage) ? usage.teamUsage : {};
  const individualOnDemand = isRecord(individual.onDemand)
    ? individual.onDemand
    : {};
  const teamOnDemand = isRecord(team.onDemand) ? team.onDemand : {};

  // A seat's own on-demand budget first; the shared pool is what constrains it
  // only when the seat has no separate limit of its own.
  return (
    ratioPercent(individualOnDemand.used, individualOnDemand.limit) ??
    ratioPercent(teamOnDemand.used, teamOnDemand.limit)
  );
};

const averagePercent = (left: unknown, right: unknown): number | undefined => {
  const values = [numberValue(left), numberValue(right)].filter(
    (value): value is number => value !== undefined
  );
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

export const cursorUsagePercent = (usage: Record<string, unknown>): number => {
  const individual = isRecord(usage.individualUsage)
    ? usage.individualUsage
    : {};
  const team = isRecord(usage.teamUsage) ? usage.teamUsage : {};
  const plan = isRecord(individual.plan) ? individual.plan : {};
  const overall = isRecord(individual.overall) ? individual.overall : {};
  const pooled = isRecord(team.pooled) ? team.pooled : {};

  return (
    numberValue(plan.totalPercentUsed) ??
    averagePercent(plan.autoPercentUsed, plan.apiPercentUsed) ??
    numberValue(plan.apiPercentUsed) ??
    numberValue(plan.autoPercentUsed) ??
    ratioPercent(plan.used, plan.limit) ??
    ratioPercent(overall.used, overall.limit) ??
    ratioPercent(pooled.used, pooled.limit) ??
    0
  );
};

const formatCursorPlan = (raw: unknown): string => {
  const value = stringValue(raw);
  if (!value) {
    return "Cursor";
  }
  const normalized = value.toLowerCase();
  if (normalized.includes("enterprise")) {
    return "Cursor Enterprise";
  }
  if (normalized.includes("team")) {
    return "Cursor Team";
  }
  if (normalized.includes("pro")) {
    return "Cursor Pro";
  }
  if (normalized.includes("hobby")) {
    return "Cursor Hobby";
  }
  return `Cursor ${titleCaseWords(value)}`;
};

const fetchCursorAccount = async (
  session: CursorSession,
  signal?: AbortSignal
): Promise<UnifiedAccount> => {
  const { cookieHeader } = session;
  if (!cookieHeader) {
    throw new Error(
      `No Cursor storage state. Run: gauge refresh cursor ${session.label}`
    );
  }
  const [usage, user] = await Promise.all([
    fetchJson(
      `${CURSOR_BASE_URL}/api/usage-summary`,
      { Cookie: cookieHeader },
      signal
    ),
    fetchJson(
      `${CURSOR_BASE_URL}/api/auth/me`,
      { Cookie: cookieHeader },
      signal
    ).catch(() => null),
  ]);
  const validatedUsage = CursorUsageResponseSchema.parse(usage);
  const end = normalizeReset(validatedUsage.billingCycleEnd);
  const secondaryPercent = cursorSecondaryPercent(validatedUsage);
  const userInfo = user === null ? {} : CursorUserResponseSchema.parse(user);
  const email = userInfo.email ?? "";

  return {
    provider: "cursor",
    label: email ? labelFromEmail(email) : session.label,
    email,
    plan: formatCursorPlan(validatedUsage.membershipType),
    renewsAt: end ?? session.renewsAt,
    // Both windows reset with the billing cycle; a cycle end gauge could not
    // read costs the countdown, never the reading itself.
    session: {
      resetsAt: end,
      usedPercent: cursorUsagePercent(validatedUsage),
    },
    weekly:
      secondaryPercent === undefined
        ? null
        : {
            resetsAt: end,
            usedPercent: secondaryPercent,
          },
    monthly: null,
  };
};

const uniquifyAccountLabels = (
  accounts: UnifiedAccount[]
): UnifiedAccount[] => {
  const totals = new Map<string, number>();
  for (const account of accounts) {
    totals.set(account.label, (totals.get(account.label) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return accounts.map((account) => {
    if ((totals.get(account.label) ?? 0) <= 1) {
      return account;
    }
    const index = (seen.get(account.label) ?? 0) + 1;
    seen.set(account.label, index);
    return {
      ...account,
      label: index === 1 ? account.label : `${account.label} ${index}`,
    };
  });
};

export const fetchCodexAccounts = async (
  configuredAccounts: AccountDetails[] = [],
  options: {
    credentialRefresh?: "refresh-if-stale" | "never";
    onCredentialUpdate?: (update: PendingCodexCredentialUpdate) => void;
    signal?: AbortSignal;
  } = {}
): Promise<UnifiedAccount[]> => {
  const configuredSources = codexSourcesFromAccounts(configuredAccounts);
  const sources =
    configuredSources.length > 0 ? configuredSources : discoverCodexSources();
  const accounts = await Promise.all(
    sources.map(async (source) => {
      try {
        return await fetchCodexAccount(
          source,
          options.credentialRefresh,
          options.onCredentialUpdate,
          options.signal
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const label =
          source.label ??
          (source.email ? labelFromEmail(source.email) : "codex");
        return errorAccount("codex", label, message, source.email);
      }
    })
  );
  return uniquifyAccountLabels(accounts);
};

export const fetchCursorAccounts = async (
  configuredAccounts: AccountDetails[] = [],
  options: { signal?: AbortSignal } = {}
): Promise<UnifiedAccount[]> => {
  const configuredSessions = cursorSessionsFromAccounts(configuredAccounts);
  const sessions =
    configuredSessions.length > 0
      ? configuredSessions
      : discoverCursorSessions();
  const accounts = await Promise.all(
    sessions.map(async (session) => {
      try {
        return await fetchCursorAccount(session, options.signal);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorAccount("cursor", session.label, message);
      }
    })
  );
  return uniquifyAccountLabels(accounts);
};
