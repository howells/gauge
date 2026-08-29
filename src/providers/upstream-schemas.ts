import { z } from "zod";

const BoundedString = z.string().max(4_096);
const ShortString = z.string().max(320);
const NormalizedDate = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date.")
  .transform((value) => new Date(value).toISOString());
const Percentage = z
  .number()
  .finite()
  .transform((value) => Math.min(100, Math.max(0, value)));
const ResetValue = z.union([BoundedString, z.number().finite()]);

const ClaudeWindow = z
  .object({
    utilization: Percentage,
    resets_at: NormalizedDate.nullish(),
  })
  // A window with no activity reports `resets_at: null`: nothing is counting
  // down because nothing has been spent. That is a reading — "idle, wholly
  // available" — and not an absence.
  //
  // It used to be collapsed to null here, which read as "this window does not
  // exist". Downstream then dropped it from an array whose *positions* carried
  // the meaning, so an idle five-hour window let the seven-day figure slide
  // into the five-hour slot and be drawn as the session meter. The weekly
  // number barely moves, so those accounts looked frozen. Keep the window.
  .transform((value) => ({
    utilization: value.utilization,
    resets_at: value.resets_at ?? null,
  }));

export const ClaudeOrganizationListSchema = z
  .array(
    z.object({
      billing_type: ShortString.nullish().transform((value) => value ?? null),
      capabilities: z.array(ShortString).max(100).default([]),
      id: z.number().finite().default(0),
      name: ShortString,
      rate_limit_tier: ShortString.nullish().transform(
        (value) => value ?? null,
      ),
      uuid: ShortString,
    }),
  )
  .max(100);

/**
 * One entry of the `limits` array that now ships beside the legacy windows.
 *
 * The named windows (`five_hour`, `seven_day`, …) still carry the readings, so
 * the array is parsed only as the fallback they will need when the legacy
 * fields stop being populated. `weekly_scoped` — a model-scoped sub-limit — is
 * deliberately not mapped onto anything yet: it meters a slice of the week, not
 * the week, and drawing it as the weekly figure would understate usage.
 */
export const ClaudeLimitSchema = z.object({
  is_active: z
    .boolean()
    .nullish()
    .transform((value) => value ?? false),
  kind: ShortString,
  percent: Percentage,
  resets_at: NormalizedDate.nullish().transform((value) => value ?? null),
  scope: z.unknown().optional(),
});

export type ClaudeLimit = z.infer<typeof ClaudeLimitSchema>;

/**
 * The named limit a window falls back to, or null when the array is absent or
 * does not carry that kind.
 */
export function windowFromLimits(
  limits: ClaudeLimit[] | undefined,
  kind: "session" | "weekly_all",
): { resets_at: string | null; utilization: number } | null {
  const limit = limits?.find((entry) => entry.kind === kind);
  if (!limit) return null;
  return { resets_at: limit.resets_at, utilization: limit.percent };
}

export const ClaudeUsageResponseSchema = z
  .object({
    five_hour: ClaudeWindow.nullish(),
    iguana_necktie: ClaudeWindow.nullish(),
    seven_day: ClaudeWindow.nullish(),
    seven_day_cowork: ClaudeWindow.nullish(),
    seven_day_oauth_apps: ClaudeWindow.nullish(),
    seven_day_opus: ClaudeWindow.nullish(),
    seven_day_sonnet: ClaudeWindow.nullish(),
    limits: z
      .array(ClaudeLimitSchema)
      .max(100)
      .nullish()
      .transform((value) => value ?? undefined),
  })
  .transform((value) => {
    // The legacy window wins whenever it is present; the `limits` entry is the
    // reading for the same horizon and only takes over when the legacy field
    // has stopped being populated.
    return {
      extra_usage: null,
      five_hour: value.five_hour ?? windowFromLimits(value.limits, "session"),
      iguana_necktie: value.iguana_necktie ?? null,
      seven_day:
        value.seven_day ?? windowFromLimits(value.limits, "weekly_all"),
      seven_day_cowork: value.seven_day_cowork ?? null,
      seven_day_oauth_apps: value.seven_day_oauth_apps ?? null,
      seven_day_opus: value.seven_day_opus ?? null,
      seven_day_sonnet: value.seven_day_sonnet ?? null,
    };
  });

export const ClaudeRenewalSchema = z.object({
  next_charge_at: NormalizedDate.optional(),
  next_charge_date: NormalizedDate.optional(),
});

const ProviderWindow = z.object({
  reset_at: ResetValue.optional(),
  resetsAt: ResetValue.optional(),
  totalPercentUsed: Percentage.optional(),
  used_percent: Percentage.optional(),
  usedPercent: Percentage.optional(),
});

export const CodexUsageResponseSchema = z.object({
  plan_type: ShortString.optional(),
  rate_limit: z
    .object({
      // Accounts without an active window report null, not absence.
      primary_window: ProviderWindow.nullish(),
      secondary_window: ProviderWindow.nullish(),
    })
    .default({}),
});

export const CodexRefreshResponseSchema = z.object({
  access_token: BoundedString.min(1),
  id_token: BoundedString.optional(),
  refresh_token: BoundedString.optional(),
});

// `limit`/`used` come back null on unlimited or team-pooled plans; treat null
// as "not reported" rather than rejecting the whole usage response.
const CursorCount = z
  .number()
  .finite()
  .nonnegative()
  .nullish()
  .transform((value) => value ?? undefined);

const CursorMetric = z.object({
  apiPercentUsed: Percentage.optional(),
  autoPercentUsed: Percentage.optional(),
  limit: CursorCount,
  totalPercentUsed: Percentage.optional(),
  used: CursorCount,
});

export const CursorUsageResponseSchema = z.object({
  billingCycleEnd: ResetValue.optional(),
  individualUsage: z
    .object({
      onDemand: CursorMetric.optional(),
      overall: CursorMetric.optional(),
      plan: CursorMetric.optional(),
    })
    .default({}),
  membershipType: ShortString.optional(),
  teamUsage: z
    .object({
      onDemand: CursorMetric.optional(),
      pooled: CursorMetric.optional(),
    })
    .default({}),
});

export const CursorUserResponseSchema = z.object({
  email: z.string().email().max(320).optional(),
});
