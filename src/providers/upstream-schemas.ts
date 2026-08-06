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

export const ClaudeUsageResponseSchema = z
  .object({
    five_hour: ClaudeWindow.nullish(),
    iguana_necktie: ClaudeWindow.nullish(),
    seven_day: ClaudeWindow.nullish(),
    seven_day_cowork: ClaudeWindow.nullish(),
    seven_day_oauth_apps: ClaudeWindow.nullish(),
    seven_day_opus: ClaudeWindow.nullish(),
    seven_day_sonnet: ClaudeWindow.nullish(),
  })
  .transform((value) => ({
    extra_usage: null,
    five_hour: value.five_hour ?? null,
    iguana_necktie: value.iguana_necktie ?? null,
    seven_day: value.seven_day ?? null,
    seven_day_cowork: value.seven_day_cowork ?? null,
    seven_day_oauth_apps: value.seven_day_oauth_apps ?? null,
    seven_day_opus: value.seven_day_opus ?? null,
    seven_day_sonnet: value.seven_day_sonnet ?? null,
  }));

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
