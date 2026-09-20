import { z } from "zod";

import {
  ClaudeLimitSchema,
  scopedClaudeLimits,
  windowFromLimits,
} from "./upstream-schemas.js";

const OAUTH_BASE = "https://api.anthropic.com";

const OAUTH_BETA = "oauth-2025-04-20";

const Window = z
  .object({
    resets_at: z.string().nullish(),
    utilization: z.number().nullish(),
  })
  .nullish();

const UsageResponse = z.object({
  five_hour: Window,
  limits: z
    .array(ClaudeLimitSchema)
    .max(100)
    .nullish()
    .transform((value) => value ?? undefined),
  seven_day: Window,
});

const ProfileResponse = z.object({
  account: z.object({ email: z.string().nullish() }).nullish(),
  organization: z
    .object({
      rate_limit_tier: z.string().nullish(),
    })
    .nullish(),
});

interface OAuthUsageWindow {
  /** Null when the window is idle: nothing spent, so nothing counting down. */
  resetsAt: string | null;
  usedPercent: number;
}

export interface OAuthUsageReading {
  email: string | null;
  plan: string | null;
  session: OAuthUsageWindow | null;
  /** Model-scoped weekly sub-limits (Fable, for instance). */
  scoped: {
    model: string;
    resetsAt: string | null;
    usedPercent: number;
  }[];
  weekly: OAuthUsageWindow | null;
}

export const planFromRateLimitTier = (tier: string | null): string | null => {
  if (!tier) {
    return null;
  }
  if (tier.includes("max_20x")) {
    return "max_20x";
  }
  if (tier.includes("max_5x")) {
    return "max_5x";
  }
  if (tier.includes("max")) {
    return "max";
  }
  if (tier.includes("pro")) {
    return "pro";
  }
  if (tier.includes("free")) {
    return "free";
  }
  return null;
};

const toWindow = (
  value:
    | {
        resets_at?: string | null;
        utilization?: number | null;
      }
    | null
    | undefined
): OAuthUsageWindow | null => {
  if (!value || typeof value.utilization !== "number") {
    return null;
  }
  return { resetsAt: value.resets_at ?? null, usedPercent: value.utilization };
};

export type OAuthFetch = (
  url: string,
  init: { headers: Record<string, string> }
) => Promise<{
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
}>;

export const fetchOAuthUsage = async (
  accessToken: string,
  fetchImpl: OAuthFetch = globalThis.fetch
): Promise<OAuthUsageReading | null> => {
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "anthropic-beta": OAUTH_BETA,
  };
  try {
    const usageRes = await fetchImpl(`${OAUTH_BASE}/api/oauth/usage`, {
      headers,
    });
    if (!usageRes.ok) {
      return null;
    }
    const usage = UsageResponse.parse(await usageRes.json());
    // Same fallback as the cookie path: the named window wins, and the
    // `limits` entry for the same horizon takes over when the legacy field is
    // no longer populated.
    const fromLimits = (
      kind: "session" | "weekly_all"
    ): OAuthUsageWindow | null => {
      const window = windowFromLimits(usage.limits, kind);
      return window
        ? { resetsAt: window.resets_at, usedPercent: window.utilization }
        : null;
    };
    const session = toWindow(usage.five_hour) ?? fromLimits("session");
    const weekly = toWindow(usage.seven_day) ?? fromLimits("weekly_all");
    const scoped = scopedClaudeLimits(usage.limits).map((limit) => ({
      model: limit.model,
      resetsAt: limit.resets_at,
      usedPercent: limit.utilization,
    }));
    if (!session && !weekly && scoped.length === 0) {
      return null;
    }

    // The profile is what names the plan; usage alone cannot. A failure here
    // costs the label and not the reading.
    let email: string | null = null;
    let plan: string | null = null;
    try {
      const profileRes = await fetchImpl(`${OAUTH_BASE}/api/oauth/profile`, {
        headers,
      });
      if (profileRes.ok) {
        const profile = ProfileResponse.parse(await profileRes.json());
        email = profile.account?.email ?? null;
        plan = planFromRateLimitTier(
          profile.organization?.rate_limit_tier ?? null
        );
      }
    } catch {
      // Label only; the windows above are the reading that matters.
    }
    return { email, plan, scoped, session, weekly };
  } catch {
    return null;
  }
};
