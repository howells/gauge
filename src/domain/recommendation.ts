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
  plan?: string;
  windows: RecommendationWindow[];
}

/**
 * A blocked account worth waiting for rather than switching away from.
 *
 * Present only when the account being recommended right now is a *worse
 * instrument* than one that unblocks shortly — see {@link findWaitFor}.
 */
export interface RecommendationAlternative {
  account: RecommendationAccountId;
  availableAt: string;
  maximumUtilization: number;
  plan: string | null;
}

export interface UsageRecommendation {
  account: RecommendationAccountId;
  availableAt: string | null;
  averageUtilization: number;
  maximumUtilization: number;
  status: "use_now" | "wait";
  /** A better account that frees up soon, when one exists. Never replaces `account`. */
  waitFor?: RecommendationAlternative;
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

  const waitFor =
    best.resetAt === 0 ? findWaitFor(best, current, now.getTime()) : undefined;

  return {
    account: best.candidate.id,
    availableAt:
      best.resetAt === 0 ? null : new Date(best.resetAt).toISOString(),
    averageUtilization: best.averageUtilization,
    maximumUtilization: best.maximumUtilization,
    status: best.resetAt === 0 ? "use_now" : "wait",
    ...(waitFor && { waitFor }),
  };
}

/** How long a wait can be before switching accounts beats sitting still. */
const WAIT_HORIZON_MS = 60 * 60 * 1000;

/**
 * How much more of a window a blocked account must offer once it resets before
 * waiting is worth suggesting, in percentage points of headroom.
 */
const MATERIAL_HEADROOM_GAIN = 20;

/**
 * Rank a plan by how much instrument it is, not how much of it is left.
 *
 * Headroom and capability are different axes and the ranking above only knows the
 * first. Measured on a real set of twelve accounts, every paid Claude plan sat
 * between 92% and 100% while a Free Codex plan sat at 0%, so the most-headroom
 * answer was "abandon Max 20x for a free tier" — true about capacity and useless
 * as advice. This is the second axis, used *only* to decide whether a wait is
 * worth mentioning; it never reorders the recommendation itself.
 */
function planRank(plan: string | undefined): number {
  if (!plan) return 0;
  const value = plan.toLowerCase();
  if (value.includes("max")) return 3;
  if (value.includes("20x")) return 2;
  if (value.includes("free")) return 0;
  return 1;
}

/**
 * The usage a blocked account will be carrying the moment it unblocks.
 *
 * Windows that reset at or before that moment are back to zero; the rest keep
 * what they are already using. A session window at 100% resetting in the hour,
 * over a weekly window at 20%, is an account that is about to be nearly empty —
 * which is exactly the case this whole function exists to notice.
 */
function utilizationAfter(entry: RankedCandidate): number {
  const survivors = entry.candidate.windows.filter(
    (window) => Date.parse(window.resetsAt) > entry.resetAt,
  );
  return survivors.reduce(
    (highest, window) => Math.max(highest, window.usedPercent),
    0,
  );
}

/**
 * Find an account worth waiting for instead of switching to {@link best}.
 *
 * Additive by design: the recommendation still names the account that is usable
 * right now, because that is the answer to "what can I use". This answers the
 * question the dashboard could not previously express — "is something better
 * about to free up?" — and lets the reader decide. It fires when a blocked
 * account unblocks inside the hour and is then either a materially bigger window
 * or a materially better plan than the one being recommended.
 */
function findWaitFor(
  best: RankedCandidate,
  current: RankedCandidate[],
  now: number,
): RecommendationAlternative | undefined {
  const bestHeadroom = 100 - best.maximumUtilization;
  const bestRank = planRank(best.candidate.plan);

  const contenders = current
    .filter(
      (entry) => entry.resetAt > 0 && entry.resetAt - now <= WAIT_HORIZON_MS,
    )
    .map((entry) => ({ entry, utilization: utilizationAfter(entry) }))
    .filter(
      ({ entry, utilization }) =>
        100 - utilization >= bestHeadroom + MATERIAL_HEADROOM_GAIN ||
        planRank(entry.candidate.plan) > bestRank,
    );

  const winner = contenders.sort(
    (left, right) =>
      planRank(right.entry.candidate.plan) -
        planRank(left.entry.candidate.plan) ||
      left.utilization - right.utilization ||
      left.entry.resetAt - right.entry.resetAt,
  )[0];

  if (!winner) return undefined;
  return {
    account: winner.entry.candidate.id,
    availableAt: new Date(winner.entry.resetAt).toISOString(),
    maximumUtilization: winner.utilization,
    plan: winner.entry.candidate.plan ?? null,
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
