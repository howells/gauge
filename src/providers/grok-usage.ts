import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { z } from "zod";

const CREDITS_URL =
  "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig";

const AuthEntrySchema = z.object({
  email: z.string().min(1).nullish(),
  expires_at: z.string().min(1).nullish(),
  key: z.string().min(1).nullish(),
});

const AuthStoreSchema = z.record(z.string().min(1), AuthEntrySchema.loose());

const CreditsResponseSchema = z.object({
  config: z
    .object({
      creditUsagePercent: z.number().nullish(),
      productUsage: z
        .array(
          z.object({
            product: z.number().nullish(),
            usagePercent: z.number().nullish(),
          })
        )
        .max(20)
        .nullish(),
    })
    .nullish(),
});

export interface GrokUsageReading {
  email: string | null;
  plan: "Grok Build";
  session: { resetsAt: string | null; usedPercent: number } | null;
  tokenExpired: boolean;
}

export interface GrokAccount {
  email: string | null;
  expiresAt: Date | null;
  token: string;
}

const defaultGrokHome = (): string =>
  process.env.GROK_HOME ?? path.join(os.homedir(), ".grok");

export const readGrokAccounts = (
  grokHome: string = defaultGrokHome()
): GrokAccount[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(grokHome, "auth.json"), "utf-8")
    );
  } catch {
    return [];
  }
  const store = AuthStoreSchema.safeParse(parsed);
  if (!store.success) {
    return [];
  }
  return Object.values(store.data)
    .filter(
      (entry): entry is typeof entry & { key: string } =>
        typeof entry.key === "string" && entry.key.length > 0
    )
    .map((entry) => ({
      email: entry.email ?? null,
      expiresAt: entry.expires_at ? new Date(entry.expires_at) : null,
      token: entry.key,
    }))
    .sort(
      (left, right) =>
        (left.expiresAt?.getTime() ?? Infinity) -
        (right.expiresAt?.getTime() ?? Infinity)
    );
};

export const liveGrokAccount = (
  accounts: readonly GrokAccount[]
): GrokAccount | null => {
  const now = Date.now();
  for (let index = accounts.length - 1; index >= 0; index -= 1) {
    const account = accounts[index];
    if (account && (!account.expiresAt || account.expiresAt.getTime() > now)) {
      return account;
    }
  }
  return null;
};

export const fetchGrokUsage = async (
  account: GrokAccount,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<GrokUsageReading | null> => {
  let response: Response;
  try {
    response = await fetchImpl(CREDITS_URL, {
      body: "{}",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${account.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const parsed = CreditsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return null;
  }
  const { config } = parsed.data;
  if (!config) {
    return null;
  }
  const build = (config.productUsage ?? []).find(
    (entry) => entry.product === 2 && entry.usagePercent !== null
  );
  const usedPercent = build?.usagePercent ?? config.creditUsagePercent ?? null;
  if (usedPercent === null) {
    return null;
  }
  return {
    email: account.email,
    plan: "Grok Build",
    session: {
      resetsAt: null,
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
    },
    tokenExpired: false,
  };
};

export const expiredGrokReading = (
  account: GrokAccount | undefined
): GrokUsageReading => ({
  email: account?.email ?? null,
  plan: "Grok Build",
  session: null,
  tokenExpired: true,
});
