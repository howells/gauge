import { z } from "zod";

const ProviderSchema = z.enum(["claude", "codex", "cursor"]);
export type Provider = z.infer<typeof ProviderSchema>;

const AccountNameSchema = z
  .string()
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Account name must use only letters, numbers, hyphens, or underscores.",
  );

export const AccountIdSchema = z.strictObject({
  name: AccountNameSchema,
  provider: ProviderSchema,
});
export type AccountId = z.infer<typeof AccountIdSchema>;

export const AccountConfigV3Schema = z.strictObject({
  schema_version: z.literal(3),
  provider: ProviderSchema,
  name: AccountNameSchema,
  addedAt: z.iso.datetime(),
  codexHome: z.string().min(1).optional(),
  renewsAt: z.iso.datetime().optional(),
});
export type AccountConfigV3 = z.infer<typeof AccountConfigV3Schema>;

export function parseProvider(value: unknown): Provider {
  return ProviderSchema.parse(value);
}

export function parseAccountName(value: unknown): string {
  return AccountNameSchema.parse(value);
}

/** Encode an account identity as a versioned, provider-scoped artifact key. */
export function encodeAccountId(accountId: AccountId): string {
  return `v3-${accountId.provider}-${accountId.name}`;
}
