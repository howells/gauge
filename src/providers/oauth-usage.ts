import { z } from "zod";

/**
 * Read a Claude account's usage from its Claude Code OAuth token.
 *
 * The browser dance exists to obtain claude.ai session cookies, because that is
 * what `claude.ai/api/*` authenticates with — a Bearer token is refused there
 * with 403. But the account is *already* signed in on this machine through the
 * Claude Code CLI, and that login carries an OAuth token which the Anthropic API
 * accepts:
 *
 * ```
 * GET https://api.anthropic.com/api/oauth/usage
 * → { five_hour: { utilization, resets_at }, seven_day: { … } }
 * ```
 *
 * Which is the same pair of windows the dashboard draws. So for any account
 * signed into Claude Code there is no browser, no separate Chrome profile with
 * extensions disabled, no Cloudflare, and no login to sit through — the session
 * you already have is the credential.
 *
 * It does not replace the cookie path. An account used only on the web has no
 * Claude Code token to borrow, and a token that has expired needs the refresh
 * exchange this does not yet implement, so both fall back.
 */
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

export interface OAuthUsageWindow {
  resetsAt: string;
  usedPercent: number;
}

export interface OAuthUsageReading {
  email: string | null;
  plan: string | null;
  windows: OAuthUsageWindow[];
}

/**
 * Turn `default_claude_max_20x` into the plan *code* the pipeline uses.
 *
 * A code, not the label. `local-adapters` owns the one map from code to the
 * words on screen, and returning "Max 20x" from here instead of "max_20x" put a
 * value through that map which it had no key for — the reading validated away
 * to an empty account with no plan and no windows, on data that was correct all
 * the way up to the last step.
 */
export function planFromRateLimitTier(tier: string | null): string | null {
  if (!tier) return null;
  if (tier.includes("max_20x")) return "max_20x";
  if (tier.includes("max_5x")) return "max_5x";
  if (tier.includes("max")) return "max";
  if (tier.includes("pro")) return "pro";
  if (tier.includes("free")) return "free";
  return null;
}

function toWindow(value: {
  resets_at?: string | null;
  utilization?: number | null;
}): OAuthUsageWindow | null {
  if (!value.resets_at || typeof value.utilization !== "number") return null;
  return { resetsAt: value.resets_at, usedPercent: value.utilization };
}

export type OAuthFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  json: () => Promise<unknown>;
  ok: boolean;
  status: number;
}>;

/**
 * Fetch usage for one access token, or null when the token cannot serve it.
 *
 * Null rather than throwing on any refusal, because this is an optimisation over
 * a path that still works: a 401 from an expired token has to fall through to
 * the cookies quietly, not surface as a failed account.
 */
export async function fetchOAuthUsage(
  accessToken: string,
  fetchImpl: OAuthFetch = globalThis.fetch as unknown as OAuthFetch,
): Promise<OAuthUsageReading | null> {
  const headers = {
    "anthropic-beta": OAUTH_BETA,
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  try {
    const usageRes = await fetchImpl(`${OAUTH_BASE}/api/oauth/usage`, {
      headers,
    });
    if (!usageRes.ok) return null;
    const usage = UsageResponse.parse(await usageRes.json());
    const windows = [usage.five_hour, usage.seven_day]
      .map((value) => (value ? toWindow(value) : null))
      .filter((value): value is OAuthUsageWindow => value !== null);
    if (windows.length === 0) return null;

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
          profile.organization?.rate_limit_tier ?? null,
        );
      }
    } catch {
      // Label only; the windows above are the reading that matters.
    }
    return { email, plan, windows };
  } catch {
    return null;
  }
}
