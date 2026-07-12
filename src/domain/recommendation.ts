type RecommendationProvider = "claude" | "codex" | "cursor";

interface RecommendationAccountId {
  name: string;
  provider: RecommendationProvider;
}

interface RecommendationError {
  code: string;
  message: string;
  retryable: boolean;
}

interface RecommendationWindow {
  resetsAt: string;
  usedPercent: number;
}

export interface RecommendationCandidate {
  error?: RecommendationError;
  id: RecommendationAccountId;
  order: number;
  windows: RecommendationWindow[];
}

export interface UsageRecommendation {
  account: RecommendationAccountId;
  availableAt: string | null;
  averageUtilization: number;
  maximumUtilization: number;
  status: "use_now" | "wait";
}

interface RankedCandidate {
  averageUtilization: number;
  candidate: RecommendationCandidate;
  maximumUtilization: number;
  resetAt: number;
}

/** Select an account using the public v3 recommendation policy. */
export function recommendUsage(
  candidates: RecommendationCandidate[],
  now: Date,
): UsageRecommendation | null {
  const current = candidates.flatMap((candidate) => {
    if (candidate.error) {
      return [];
    }

    const windows = candidate.windows.filter((window) => {
      const resetAt = Date.parse(window.resetsAt);
      return Number.isFinite(resetAt) && resetAt > now.getTime();
    });
    if (windows.length === 0) {
      return [];
    }

    const utilizations = windows.map((window) => window.usedPercent);
    const blockers = windows.filter((window) => window.usedPercent >= 100);
    const resetAt = blockers.reduce(
      (latest, window) => Math.max(latest, Date.parse(window.resetsAt)),
      0,
    );

    return [
      {
        averageUtilization:
          utilizations.reduce((sum, value) => sum + value, 0) /
          utilizations.length,
        candidate,
        maximumUtilization: Math.max(...utilizations),
        resetAt,
      },
    ];
  });

  if (current.length === 0) {
    return null;
  }

  const usable = current.filter((entry) => entry.resetAt === 0);
  const ranked = usable.length > 0 ? usable : current;
  ranked.sort((left, right) =>
    compareCandidates(left, right, usable.length > 0),
  );

  const best = ranked[0];
  if (!best) {
    return null;
  }

  return {
    account: best.candidate.id,
    availableAt:
      best.resetAt === 0 ? null : new Date(best.resetAt).toISOString(),
    averageUtilization: best.averageUtilization,
    maximumUtilization: best.maximumUtilization,
    status: best.resetAt === 0 ? "use_now" : "wait",
  };
}

function compareCandidates(
  left: RankedCandidate,
  right: RankedCandidate,
  usable: boolean,
): number {
  if (!usable && left.resetAt !== right.resetAt) {
    return left.resetAt - right.resetAt;
  }
  if (usable && left.maximumUtilization !== right.maximumUtilization) {
    return left.maximumUtilization - right.maximumUtilization;
  }
  if (usable && left.averageUtilization !== right.averageUtilization) {
    return left.averageUtilization - right.averageUtilization;
  }
  return left.candidate.order - right.candidate.order;
}
