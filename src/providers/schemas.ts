import { z } from "zod";
import { USAGE_WINDOW_KINDS } from "../domain/snapshot.js";

const NormalizedDateSchema = z
  .string()
  .max(64)
  .refine((value) => Number.isFinite(Date.parse(value)), "Invalid date.")
  .transform((value) => new Date(value).toISOString());

const UsageWindowSchema = z.strictObject({
  kind: z.enum(USAGE_WINDOW_KINDS),
  // Null is a reading, not a gap: an idle window has spent nothing, so it has
  // nothing to count down to. Dropping such a window is what let a seven-day
  // figure be drawn as a five-hour one.
  resetsAt: z.union([NormalizedDateSchema, z.null()]),
  usedPercent: z
    .number()
    .finite()
    .transform((value) => Math.min(100, Math.max(0, value))),
});

/** Allowlisted DTO emitted by every provider adapter. */
export const ProviderUsageReadingSchema = z.strictObject({
  email: z.string().email().max(320).optional(),
  plan: z.string().min(1).max(100),
  renewsAt: z.union([NormalizedDateSchema, z.null()]).optional(),
  windows: z.array(UsageWindowSchema).max(16),
});
