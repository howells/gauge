import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";

import type { Provider } from "../domain/account.js";
import type { UsageRecommendation } from "../domain/recommendation.js";
import type { AccountSnapshot } from "../domain/snapshot.js";
import { getDataDir } from "../paths.js";
import { claudeSwitchesWithin } from "./claude-session.js";
import type { LastClaudeSwitch } from "./claude-session.js";
import {
  claudeAccountNamesByUuid,
  readMachineLogins,
} from "./machine-logins.js";
import { ADD_STEPS } from "./onboarding.js";

export interface StatusAccountView {
  error: AccountSnapshot["error"];
  name: string;
  provider: string;
  source: string;
  usage: AccountSnapshot["usage"];
}

const ANSI_RE = /\u001B\[[0-9;]*m/gu;

const visibleLength = (value: string): number =>
  value.replace(ANSI_RE, "").length;

const pad = (value: string, width: number): string =>
  value + " ".repeat(Math.max(0, width - visibleLength(value)));

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

const timeUntil = (iso: string, now: Date): string => {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) {
    return "now";
  }
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}d`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${Math.max(1, minutes)}m`;
};

const renewalLabel = (iso: string, now: Date): string | null => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const month = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
  const year = date.getUTCFullYear();
  return year === now.getUTCFullYear()
    ? month
    : `${month} ${String(year).slice(2)}`;
};

const METER_WIDTH = 10;

const meterColor = (percent: number): ((value: string) => string) => {
  if (percent >= 90) {
    return chalk.red;
  }
  if (percent >= 60) {
    return chalk.yellow;
  }
  return chalk.green;
};

const meter = (percent: number): string => {
  const clamped = Math.min(100, Math.max(0, percent));
  // Any nonzero usage shows at least one cell so activity is never invisible.
  const filled =
    clamped > 0 ? Math.max(1, Math.round((clamped / 100) * METER_WIDTH)) : 0;
  const bar = "█".repeat(filled) + chalk.dim("░".repeat(METER_WIDTH - filled));
  return filled > 0 ? meterColor(clamped)(bar) : bar;
};

type WindowView = NonNullable<AccountSnapshot["usage"]>["windows"][number];

const WINDOW_LABEL: Record<WindowView["kind"], string> = {
  included: "plan",
  monthly: "mo",
  on_demand: "on-demand",
  scoped: "scoped",
  session: "session",
  weekly: "wk",
};

const compactWindowLabel = (window: WindowView): string | null => {
  if (!window.label) {
    return null;
  }
  return window.label.replace(/^GPT-[^-]+-Codex-/u, "");
};

interface CellStatus {
  kind: "ready" | "blocked" | "error";
  primary: WindowView | null;
  secondary: WindowView | null;
  waitMs: number;
}

const cellStatus = (account: StatusAccountView, now: Date): CellStatus => {
  if (account.error || !account.usage) {
    return { kind: "error", primary: null, secondary: null, waitMs: Infinity };
  }
  const { windows } = account.usage;
  const primary = windows[0] ?? null;
  const secondary = windows[1] ?? null;
  // A labelled window belongs to one model pool. It can be full without the
  // account being blocked for every other Codex model.
  const blocked = windows.filter(
    (window) => !window.label && window.usedPercent >= 100
  );
  if (blocked.length > 0) {
    const waits = blocked.map((window) =>
      window.resetsAt === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, new Date(window.resetsAt).getTime() - now.getTime())
    );
    return { kind: "blocked", primary, secondary, waitMs: Math.min(...waits) };
  }
  return { kind: "ready", primary, secondary, waitMs: 0 };
};

const INDENT = "   ";

const COL_LABEL = 21;

const COL_CELL = 34;

const PROVIDER_ORDER: Provider[] = ["claude", "codex", "cursor", "zai", "grok"];

const PROVIDER_NAME: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  zai: "Z.AI",
};

interface GridRow {
  label: string;
  accounts: Partial<Record<Provider, StatusAccountView>>;
  minWaitMs: number;
}

const isProvider = (value: string): value is Provider =>
  (PROVIDER_ORDER as string[]).includes(value);

const preferredOrder = (): string[] => {
  try {
    const raw = fs.readFileSync(
      path.join(getDataDir(), "display.json"),
      "utf-8"
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return [];
    }
    const { accountOrder } = parsed as { accountOrder?: unknown };
    if (!Array.isArray(accountOrder)) {
      return [];
    }
    return accountOrder.filter(
      (name): name is string => typeof name === "string"
    );
  } catch {
    return [];
  }
};

const buildRows = (accounts: StatusAccountView[], now: Date): GridRow[] => {
  const rows = new Map<string, GridRow>();
  for (const account of accounts) {
    if (!isProvider(account.provider)) {
      continue;
    }
    const row = rows.get(account.name) ?? {
      accounts: {},
      label: account.name,
      minWaitMs: Infinity,
    };
    // First entry wins on a label collision — configured sources come first.
    row.accounts[account.provider] ??= account;
    rows.set(account.name, row);
  }
  for (const row of rows.values()) {
    row.minWaitMs = Math.min(
      ...Object.values(row.accounts).map(
        (account) => cellStatus(account, now).waitMs
      )
    );
  }
  const preferred = preferredOrder();
  return [...rows.values()].sort((left, right) => {
    // A named order wins outright when one is configured. Row order is a reading
    // aid — which account you look for first is a fact about the person, not
    // about the data — so it belongs to the reader and not to the sort below.
    const leftRank = preferred.indexOf(left.label);
    const rightRank = preferred.indexOf(right.label);
    if (leftRank !== rightRank) {
      // Unlisted names keep the computed order, after every listed one.
      if (leftRank === -1) {
        return 1;
      }
      if (rightRank === -1) {
        return -1;
      }
      return leftRank - rightRank;
    }
    if (left.minWaitMs !== right.minWaitMs) {
      return left.minWaitMs - right.minWaitMs;
    }
    return left.label.localeCompare(right.label);
  });
};

const meterCell = (
  account: StatusAccountView | undefined,
  now: Date,
  active = false
): string => {
  // Two columns of gutter on every cell so the marker costs no width and the
  // grid does not shift as the cursor moves across it.
  const gutter = active ? chalk.cyan("› ") : "  ";
  const cell = (content: string): string =>
    `${gutter}${pad(content, COL_CELL - 2)}`;
  if (!account) {
    return cell(chalk.dim("·"));
  }
  const status = cellStatus(account, now);
  if (status.kind === "error") {
    return cell(chalk.red("needs re-auth"));
  }
  const window = status.primary;
  if (!window) {
    // No windows at all is the provider declining to report, which is not the
    // same as reporting nothing spent. An idle account now arrives as real
    // windows at 0% and takes the ordinary path below; drawing "0%" here too
    // would put a number where there is no reading.
    return cell(chalk.dim("no usage reported"));
  }
  const percent = Math.round(window.usedPercent);
  if (status.kind === "blocked") {
    // When the account holds an applicable usage-limit reset, that is the
    // answer the reader came for: the wait countdown describes a wait a
    // redeemed reset removes. The count still travels in the JSON output.
    const resets = account.usage?.resetsApplicable ?? 0;
    if (resets > 0) {
      return cell(
        `${meter(100)} ${chalk.red("full")} ${chalk.dim(`· ${resets} reset${resets === 1 ? "" : "s"}`)}`
      );
    }
    const wait = Number.isFinite(status.waitMs)
      ? ` ${chalk.dim(`· ${timeUntil(new Date(now.getTime() + status.waitMs).toISOString(), now)}`)}`
      : "";
    return cell(`${meter(100)} ${chalk.red("full")}${wait}`);
  }
  // An idle window has nothing counting down, so there is no clock to show.
  const horizon = ["weekly", "monthly"].includes(window.kind)
    ? ` ${chalk.dim(`· ${WINDOW_LABEL[window.kind]}`)}`
    : "";
  const reset =
    window.usedPercent > 0 && window.resetsAt !== null
      ? ` ${chalk.dim(`· ${timeUntil(window.resetsAt, now)}`)}`
      : "";
  return cell(`${meter(percent)} ${percent}%${horizon}${reset}`);
};

const detailCell = (
  account: StatusAccountView | undefined,
  now: Date
): string => {
  // The same two-column gutter `meterCell` reserves for the cursor, so a detail
  // line sits under its own meter and every column keeps one width.
  const width = COL_CELL - 2;
  const cell = (content: string): string => `  ${pad(content, width)}`;
  if (!account?.usage) {
    return cell("");
  }
  const status = cellStatus(account, now);

  const plan = account.usage.plan || null;
  // Named from the window itself. The old line said "wk" over whatever landed
  // in the second slot, which was a guess dressed as a fact.
  //
  // Shown even at 100%, which it used to be hidden at. The meter above can only
  // say the account is *full*; it cannot say which limit filled. Those are
  // different situations — a spent session frees up in the hour, a spent week
  // does not — and the one being hidden was precisely the case where naming it
  // matters most.
  const second = status.secondary;
  const primaryScope = status.primary
    ? compactWindowLabel(status.primary)
    : null;
  const scopedPrimary =
    primaryScope && status.primary
      ? `${primaryScope} ${WINDOW_LABEL[status.primary.kind]}`
      : null;
  const reading =
    second === null
      ? null
      : `${WINDOW_LABEL[second.kind]} ${Math.round(second.usedPercent)}%${
          second.resetsAt === null
            ? ""
            : ` · ${timeUntil(second.resetsAt, now)}`
        }`;
  // Resets the account holds, only when it holds any. A holding of zero is
  // the common case and not worth a permanent column of noise.
  const resetsHeld = account.usage.resetsAvailable ?? 0;
  const resets =
    resetsHeld > 0 ? `${resetsHeld} reset${resetsHeld === 1 ? "" : "s"}` : null;
  // Where a drawn countdown already lands on the renewal instant — Cursor's
  // windows reset on the billing date — the date would say the same thing
  // twice, so the countdown stands in for it.
  const renewsAt = account.usage.renewsAt ?? null;
  const drawnResets = [
    ...(status.primary && status.primary.usedPercent > 0
      ? [status.primary.resetsAt]
      : []),
    ...(status.secondary ? [status.secondary.resetsAt] : []),
  ];
  const renewalDate = renewsAt ? renewalLabel(renewsAt, now) : null;
  const renewsAtMs = renewsAt ? Date.parse(renewsAt) : null;
  const renews =
    renewalDate &&
    renewsAtMs !== null &&
    !drawnResets.some(
      (reset) => reset !== null && Date.parse(reset) === renewsAtMs
    )
      ? `renews ${renewalDate}`
      : null;

  // Widest first, and what goes when it will not fit is a judgement about which
  // of these is worth the column. The usage reading is never what gets dropped
  // — it is the only part that changes, and dropping it is how a team pool at
  // 59% came to be trimmed off a row that had just learned how to measure it.
  // The plan label goes before the renewal date does: the renewal is the fact
  // the reader came for, and the plan is the one the recommendation line
  // already repeats for whichever account it picks.
  for (const tier of [
    [plan, scopedPrimary, reading, resets, renews],
    [scopedPrimary, reading, resets, renews],
    [scopedPrimary, reading, resets],
    [reading ?? scopedPrimary ?? plan],
    [resets ?? renews],
  ]) {
    const line = tier
      .filter((part): part is string => part !== null)
      .join(" · ");
    if (visibleLength(line) <= width) {
      return cell(chalk.dim(line));
    }
  }
  return cell(chalk.dim(truncate(reading ?? plan ?? renews ?? "", width)));
};

const header = (accounts: StatusAccountView[], now: Date): string => {
  const ready = accounts.filter(
    (account) => cellStatus(account, now).kind === "ready"
  ).length;
  const counts = `${accounts.length} account${accounts.length === 1 ? "" : "s"} · ${ready} ready`;
  return `${INDENT}${chalk.bold("gauge")}  ${chalk.dim(counts)}`;
};

const columnHeader = (providers: Provider[]): string => {
  const cells = providers
    // Two-space gutter to match the cells, so a heading sits over its column.
    .map(
      (provider) => `  ${pad(chalk.dim(PROVIDER_NAME[provider]), COL_CELL - 2)}`
    )
    .join("  ");
  return `${INDENT}${" ".repeat(COL_LABEL)}  ${cells}`.trimEnd();
};

const recommendationLine = (
  recommendation: UsageRecommendation | null,
  accounts: StatusAccountView[],
  now: Date
): string => {
  if (!recommendation) {
    return `${INDENT}${chalk.dim("No account is currently usable.")}`;
  }
  const id = `${recommendation.account.provider}:${recommendation.account.name}`;
  const picked = accounts.find(
    (account) =>
      account.provider === recommendation.account.provider &&
      account.name === recommendation.account.name
  );
  const plan = picked?.usage?.plan ? chalk.dim(` · ${picked.usage.plan}`) : "";
  if (recommendation.status === "use_now") {
    // Naming the cost keeps "ready now" honest: this pick stands usable
    // because redeeming a reset would clear it, and the credit is spent.
    const ready = chalk.dim(
      recommendation.viaReset ? "ready now · via reset" : "ready now"
    );
    const line = `${INDENT}${chalk.green("→")} ${chalk.bold(id)}  ${ready}${plan}`;
    // The second line is the one the dashboard could not say before: something
    // better is about to free up, and switching now would be the worse move.
    const alternative = recommendation.waitFor;
    if (!alternative) {
      return line;
    }
    const waitId = `${alternative.account.provider}:${alternative.account.name}`;
    const waitPlan = alternative.plan ? ` · ${alternative.plan}` : "";
    const left = `${100 - alternative.maximumUtilization}% free`;
    return `${line}\n${INDENT}  ${chalk.dim(`or wait ${timeUntil(alternative.availableAt, now)} for`)} ${chalk.bold(waitId)}${chalk.dim(`${waitPlan} · ${left}`)}`;
  }
  const wait = recommendation.availableAt
    ? timeUntil(recommendation.availableAt, now)
    : "soon";
  return `${INDENT}${chalk.yellow("→")} ${chalk.bold(id)}  ${chalk.dim(`free in ${wait}`)}${plan}`;
};

const errorLines = (accounts: StatusAccountView[]): string[] => {
  const failed = accounts.filter((account) => account.error);
  if (failed.length === 0) {
    return [];
  }
  return [
    "",
    ...failed.map((account) => {
      const id = `${account.provider}:${account.name}`;
      const fix =
        account.source === "configured"
          ? `gauge refresh ${account.provider} ${account.name}`
          : `check ${account.provider} credentials`;
      return `${INDENT}${chalk.yellow("⚠")} ${id} ${chalk.dim(`— ${fix}`)}`;
    }),
  ];
};

const machineLines = (accounts: StatusAccountView[]): string[] => {
  const logins = readMachineLogins();
  if (logins.length === 0) {
    return [];
  }

  const byEmail = new Map<string, string>();
  for (const account of accounts) {
    const email = account.usage?.email;
    if (email) {
      byEmail.set(email.toLowerCase(), account.name);
    }
  }
  const claudeCode = logins.find((login) => login.surface === "Claude Code");
  const byUuid = claudeAccountNamesByUuid(getDataDir());

  const width = Math.max(...logins.map((login) => login.surface.length));
  const lines: string[] = [
    "",
    `${INDENT}${chalk.dim("signed in on this machine")}`,
    ...logins.map((login) => {
      const surface = chalk.white(login.surface.padEnd(width));
      if (login.email) {
        const known = byEmail.get(login.email.toLowerCase());
        const tail = known
          ? chalk.dim(`· ${known}`)
          : chalk.yellow("· not tracked here");
        return `${INDENT}${surface}  ${login.email}  ${tail}`;
      }
      // Only an identifier is readable for this surface. Name it from the state
      // gauge kept when it signed into these accounts itself, and fall back to
      // the one fact left — whether it is the CLI's account — when it matches
      // nothing configured.
      const named = login.accountId ? byUuid.get(login.accountId) : undefined;
      if (named) {
        return `${INDENT}${surface}  ${chalk.dim(`· ${named}`)}`;
      }
      const sameAsCli =
        claudeCode?.accountId && login.accountId === claudeCode.accountId;
      const detail = sameAsCli
        ? chalk.dim(`same account as ${claudeCode?.surface}`)
        : chalk.yellow(
            `an account not configured here · ${(login.accountId ?? "unknown").slice(0, 8)}…`
          );
      return `${INDENT}${surface}  ${detail}`;
    }),
  ];
  return lines;
};

const SWITCH_WARNING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ClaudeSwitchWarning {
  /** Every account displaced by a recent switch, named for display. */
  previous: string[];
  /** When the most recent of those switches happened. */
  switchedAt: Date;
}

export const renderSwitchWarning = (
  switched: ClaudeSwitchWarning | null,
  now: Date
): string | null => {
  if (!switched || switched.previous.length === 0) {
    return null;
  }
  const ageMs = now.getTime() - switched.switchedAt.getTime();
  if (ageMs <= 0 || ageMs > SWITCH_WARNING_MAX_AGE_MS) {
    return null;
  }
  const minutes = Math.floor(ageMs / 60_000);
  const hours = Math.floor(minutes / 60);
  const ago = hours > 0 ? `${hours}h` : `${Math.max(1, minutes)}m`;
  const names = switched.previous.join(" and ");
  const spend = switched.previous.length > 1 ? "one of them" : names;
  return `${INDENT}${chalk.yellow("⚠")} switched from ${chalk.white(names)} ${chalk.dim(`${ago} ago`)} ${chalk.dim("·")} Claude Code sessions opened before then may still be spending ${chalk.white(spend)} ${chalk.dim("· restart them")}`;
};

const readClaudeCodeLogin = (): {
  uuid: string | null;
  email: string | null;
} => {
  const login = readMachineLogins().find(
    (candidate) => candidate.surface === "Claude Code"
  );
  return { email: login?.email ?? null, uuid: login?.accountId ?? null };
};

const sameIdentity = (
  entry: LastClaudeSwitch,
  signedIn: { uuid: string | null; email: string | null }
): boolean => {
  if (entry.previousUuid !== null && entry.previousUuid === signedIn.uuid) {
    return true;
  }
  return (
    entry.previousEmail != null &&
    signedIn.email != null &&
    entry.previousEmail.toLowerCase() === signedIn.email.toLowerCase()
  );
};

const switchWarningLines = (
  accounts: StatusAccountView[],
  now: Date
): string[] => {
  const switches = claudeSwitchesWithin(
    getDataDir(),
    now,
    SWITCH_WARNING_MAX_AGE_MS
  );
  if (switches.length === 0) {
    return [];
  }
  const byUuid = claudeAccountNamesByUuid(getDataDir());
  const byEmail = new Map<string, string>();
  for (const account of accounts) {
    const email = account.usage?.email;
    if (email) {
      byEmail.set(email.toLowerCase(), account.name);
    }
  }
  const signedIn = readClaudeCodeLogin();
  const live = switches.filter((entry) => !sameIdentity(entry, signedIn));
  if (live.length === 0) {
    return [];
  }
  const names = [
    ...new Set(
      live.map(
        (entry) =>
          (entry.previousUuid ? byUuid.get(entry.previousUuid) : undefined) ??
          (entry.previousEmail
            ? (byEmail.get(entry.previousEmail.toLowerCase()) ??
              entry.previousEmail)
            : undefined) ??
          "another account"
      )
    ),
  ];
  const mostRecent = live.reduce((latest, entry) =>
    entry.switchedAt.getTime() > latest.switchedAt.getTime() ? entry : latest
  );
  const warning = renderSwitchWarning(
    { previous: names, switchedAt: mostRecent.switchedAt },
    now
  );
  return warning ? [warning] : [];
};

const renderEmptyState = (): string => {
  const width = Math.max(...ADD_STEPS.map((step) => step.label.length));
  const rows = ADD_STEPS.map(
    (step) =>
      `${INDENT}${chalk.white(step.label.padEnd(width))}   ${chalk.dim(step.command)}`
  );
  return [
    "",
    `${INDENT}${chalk.bold("gauge")}  ${chalk.dim("no accounts yet")}`,
    "",
    `${INDENT}${chalk.dim("Add an account to track its usage:")}`,
    "",
    ...rows,
    "",
    `${INDENT}${chalk.dim("Claude and Cursor open a browser to log in.")}`,
    `${INDENT}${chalk.dim("Codex reads an existing Codex CLI login from a folder.")}`,
    "",
  ].join("\n");
};

export const statusRowOrder = (
  accounts: StatusAccountView[],
  now: Date
): string[] => buildRows(accounts, now).map((row) => row.label);

export const statusProviderOrder = (
  accounts: StatusAccountView[]
): Provider[] =>
  PROVIDER_ORDER.filter((provider) =>
    accounts.some((account) => account.provider === provider)
  );

export const renderStatusDashboard = (
  accounts: StatusAccountView[],
  recommendation: UsageRecommendation | null,
  now: Date,
  selected?: { label: string; provider: Provider }
): string => {
  if (accounts.length === 0) {
    return renderEmptyState();
  }
  const providers = PROVIDER_ORDER.filter((provider) =>
    accounts.some((account) => account.provider === provider)
  );
  const rows = buildRows(accounts, now);
  const width = COL_LABEL + 2 + (COL_CELL + 2) * providers.length - 2;

  const lines: string[] = [""];
  lines.push(
    header(accounts, now),
    ...switchWarningLines(accounts, now),
    "",
    columnHeader(providers)
  );
  for (const row of rows) {
    const onRow = selected?.label === row.label;
    const name = truncate(row.label, COL_LABEL);
    const label = pad(
      onRow ? chalk.cyan.bold(name) : chalk.white(name),
      COL_LABEL
    );
    const meters = providers
      .map((provider) =>
        meterCell(
          row.accounts[provider],
          now,
          onRow && selected?.provider === provider
        )
      )
      .join("  ");
    const details = providers
      .map((provider) => detailCell(row.accounts[provider], now))
      .join("  ");
    lines.push(`${INDENT}${label}  ${meters}`.trimEnd());
    const detailText = details.trimEnd();
    if (detailText.length > 0) {
      lines.push(`${INDENT}${" ".repeat(COL_LABEL)}  ${details}`.trimEnd());
    }
  }
  lines.push(
    "",
    `${INDENT}${chalk.dim("─".repeat(width))}`,
    recommendationLine(recommendation, accounts, now),
    ...errorLines(accounts),
    ...machineLines(accounts),
    ""
  );
  return lines.join("\n");
};

export const renderQuickRecommendation = (
  recommendation: UsageRecommendation | null,
  now: Date
): string => {
  if (!recommendation) {
    return "No account recommendation available.\n";
  }
  const id = `${recommendation.account.provider}:${recommendation.account.name}`;
  if (recommendation.status === "use_now") {
    const ready = chalk.dim(
      recommendation.viaReset ? "ready now · via reset" : "ready now"
    );
    return `${chalk.green("→")} ${chalk.bold(id)}  ${ready}\n`;
  }
  const wait = recommendation.availableAt
    ? timeUntil(recommendation.availableAt, now)
    : "soon";
  return `${chalk.yellow("→")} ${chalk.bold(id)}  ${chalk.dim(`free in ${wait}`)}\n`;
};
