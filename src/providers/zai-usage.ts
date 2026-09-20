import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const PROVIDER_IDS = [
  "zai-coding-plan",
  "zai",
  "z-ai",
  "z.ai",
  "zhipu",
  "zhipuai",
] as const;

const KeyEntrySchema = z.union([
  z.string().min(1),
  z
    .object({ key: z.string().min(1).optional() })
    .loose()
    .transform((value) => value.key ?? null),
]);

const AuthStoreSchema = z
  .record(z.string().min(1), KeyEntrySchema)
  .nullish()
  .transform((value) => value ?? {});

const QuotaLimitSchema = z.object({
  currentValue: z.number().nullish(),
  nextResetTime: z.number().nullish(),
  number: z.number().nullish(),
  percentage: z.number().nullish(),
  type: z.string().nullish(),
  unit: z.number().nullish(),
  usage: z.number().nullish(),
});

const QuotaResponseSchema = z.object({
  data: z
    .object({
      level: z.string().nullish(),
      limits: z.array(QuotaLimitSchema).max(20).nullish(),
    })
    .nullish(),
});

export interface ZaiUsageReading {
  email: null;
  plan: string;
  session: { resetsAt: string | null; usedPercent: number } | null;
  monthly: { resetsAt: string | null; usedPercent: number } | null;
}

export const readZaiApiKey = (
  env: NodeJS.ProcessEnv = process.env
): string | null => {
  if (typeof env.ZAI_API_KEY === "string" && env.ZAI_API_KEY.length > 0) {
    return env.ZAI_API_KEY;
  }
  const home = env.HOME ?? os.homedir();
  const authPaths = [
    path.join(home, ".local", "share", "opencode", "auth.json"),
    path.join(home, ".config", "opencode", "auth.json"),
  ];
  for (const authPath of authPaths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    } catch {
      continue;
    }
    const store = AuthStoreSchema.safeParse(parsed);
    if (!store.success) {
      continue;
    }
    for (const providerId of PROVIDER_IDS) {
      const entry = store.data[providerId];
      if (typeof entry === "string" && entry.length > 0) {
        return entry;
      }
    }
  }
  return null;
};

const quotaWindow = (
  limit: z.infer<typeof QuotaLimitSchema> | undefined
): { resetsAt: string | null; usedPercent: number } | null => {
  if (!limit) {
    return null;
  }
  const pool = limit.usage;
  const spent = limit.currentValue;
  const usedPercent =
    pool !== null &&
    pool !== undefined &&
    pool > 0 &&
    spent !== null &&
    spent !== undefined
      ? Math.min(100, Math.max(0, (spent / pool) * 100))
      : (limit.percentage ?? 0);
  return {
    resetsAt:
      limit.nextResetTime !== null && limit.nextResetTime !== undefined
        ? new Date(limit.nextResetTime).toISOString()
        : null,
    usedPercent: Math.round(usedPercent * 10) / 10,
  };
};

const planFromLevel = (level: string | null | undefined): string => {
  if (!level) {
    return "Unknown";
  }
  return level.charAt(0).toUpperCase() + level.slice(1);
};

export const fetchZaiUsage = async (
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env
): Promise<ZaiUsageReading | null> => {
  const key = readZaiApiKey(env);
  if (!key) {
    return null;
  }
  let response: Response;
  try {
    response = await fetchImpl(QUOTA_URL, {
      headers: { Accept: "application/json", Authorization: key },
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }
  const parsed = QuotaResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return null;
  }
  const { data } = parsed.data;
  const limits = data?.limits ?? [];

  const session = quotaWindow(
    limits.find((limit) => limit.unit === 3 && limit.number === 5)
  );
  const monthly = quotaWindow(
    limits.find((limit) => limit.unit === 6 && limit.number === 1)
  );
  if (!session && !monthly) {
    return null;
  }
  return { email: null, monthly, plan: planFromLevel(data?.level), session };
};
