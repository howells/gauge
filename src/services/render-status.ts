import chalk from "chalk";
import type { Provider } from "../domain/account.js";
import type { UsageRecommendation } from "../domain/recommendation.js";
import type { AccountSnapshot } from "../domain/snapshot.js";
import { ADD_STEPS } from "./onboarding.js";

/** One account as mapped by the status result for presentation. */
export interface StatusAccountView {
  error: AccountSnapshot["error"];
  name: string;
  provider: string;
  source: string;
  usage: AccountSnapshot["usage"];
}

// ─── ANSI-aware string helpers ───────────────────────────────────────────────

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping needs ESC.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(value: string): number {
  return value.replace(ANSI_RE, "").length;
}

function pad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - visibleLength(value)));
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

// ─── Time ────────────────────────────────────────────────────────────────────

function timeUntil(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  return `${Math.max(1, minutes)}m`;
}

// ─── Meters ──────────────────────────────────────────────────────────────────

const METER_WIDTH = 10;

function meterColor(percent: number): (value: string) => string {
  if (percent >= 90) return chalk.red;
  if (percent >= 60) return chalk.yellow;
  return chalk.green;
}

function meter(percent: number): string {
  const clamped = Math.min(100, Math.max(0, percent));
  // Any nonzero usage shows at least one cell so activity is never invisible.
  const filled =
    clamped > 0 ? Math.max(1, Math.round((clamped / 100) * METER_WIDTH)) : 0;
  const bar = "█".repeat(filled) + chalk.dim("░".repeat(METER_WIDTH - filled));
  return filled > 0 ? meterColor(clamped)(bar) : bar;
}

// ─── Account status ──────────────────────────────────────────────────────────

interface WindowView {
  resetsAt: string;
  usedPercent: number;
}

interface CellStatus {
  kind: "ready" | "blocked" | "error";
  primary: WindowView | null;
  secondary: WindowView | null;
  waitMs: number;
}

function cellStatus(account: StatusAccountView, now: Date): CellStatus {
  if (account.error || !account.usage) {
    return { kind: "error", primary: null, secondary: null, waitMs: Infinity };
  }
  const windows = account.usage.windows;
  const primary = windows[0] ?? null;
  const secondary = windows[1] ?? null;
  const blocked = windows.filter((window) => window.usedPercent >= 100);
  if (blocked.length > 0) {
    const waitMs = Math.min(
      ...blocked.map((window) =>
        Math.max(0, new Date(window.resetsAt).getTime() - now.getTime()),
      ),
    );
    return { kind: "blocked", primary, secondary, waitMs };
  }
  return { kind: "ready", primary, secondary, waitMs: 0 };
}

// ─── Layout ──────────────────────────────────────────────────────────────────

const INDENT = "   ";
const COL_LABEL = 21;
const COL_CELL = 27;

const PROVIDER_ORDER: Provider[] = ["claude", "codex", "cursor"];
const PROVIDER_NAME: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

interface GridRow {
  label: string;
  accounts: Partial<Record<Provider, StatusAccountView>>;
  minWaitMs: number;
}

function isProvider(value: string): value is Provider {
  return (PROVIDER_ORDER as string[]).includes(value);
}

function buildRows(accounts: StatusAccountView[], now: Date): GridRow[] {
  const rows = new Map<string, GridRow>();
  for (const account of accounts) {
    if (!isProvider(account.provider)) continue;
    const row = rows.get(account.name) ?? {
      label: account.name,
      accounts: {},
      minWaitMs: Infinity,
    };
    // First entry wins on a label collision — configured sources come first.
    row.accounts[account.provider] ??= account;
    rows.set(account.name, row);
  }
  for (const row of rows.values()) {
    row.minWaitMs = Math.min(
      ...Object.values(row.accounts).map(
        (account) => cellStatus(account, now).waitMs,
      ),
    );
  }
  return [...rows.values()].sort((left, right) => {
    if (left.minWaitMs !== right.minWaitMs) {
      return left.minWaitMs - right.minWaitMs;
    }
    return left.label.localeCompare(right.label);
  });
}

// ─── Cells ───────────────────────────────────────────────────────────────────

function meterCell(account: StatusAccountView | undefined, now: Date): string {
  if (!account) return pad(chalk.dim("·"), COL_CELL);
  const status = cellStatus(account, now);
  if (status.kind === "error") {
    return pad(chalk.red("needs re-auth"), COL_CELL);
  }
  const window = status.primary;
  if (!window) {
    // No active window means nothing used — an idle, fully available account.
    return pad(`${meter(0)} 0%`, COL_CELL);
  }
  const percent = Math.round(window.usedPercent);
  if (status.kind === "blocked") {
    const wait = timeUntil(
      new Date(now.getTime() + status.waitMs).toISOString(),
      now,
    );
    return pad(
      `${meter(100)} ${chalk.red("full")} ${chalk.dim(`· ${wait}`)}`,
      COL_CELL,
    );
  }
  const reset =
    window.usedPercent > 0
      ? ` ${chalk.dim(`· ${timeUntil(window.resetsAt, now)}`)}`
      : "";
  return pad(`${meter(percent)} ${percent}%${reset}`, COL_CELL);
}

function detailCell(account: StatusAccountView | undefined, now: Date): string {
  if (!account?.usage) return pad("", COL_CELL);
  const status = cellStatus(account, now);
  const parts: string[] = [];
  if (account.usage.plan) parts.push(account.usage.plan);
  const weekly = status.secondary;
  if (weekly && weekly.usedPercent < 100) {
    parts.push(
      `wk ${Math.round(weekly.usedPercent)}% · ${timeUntil(weekly.resetsAt, now)}`,
    );
  }
  if (account.usage.renewsAt) {
    parts.push(`renews ${timeUntil(account.usage.renewsAt, now)}`);
  }
  // Drop trailing parts rather than truncating text mid-word.
  while (parts.length > 1 && parts.join(" · ").length > COL_CELL) {
    parts.pop();
  }
  return pad(chalk.dim(truncate(parts.join(" · "), COL_CELL)), COL_CELL);
}

// ─── Sections ────────────────────────────────────────────────────────────────

function header(accounts: StatusAccountView[], now: Date): string {
  const ready = accounts.filter(
    (account) => cellStatus(account, now).kind === "ready",
  ).length;
  const counts = `${accounts.length} account${accounts.length === 1 ? "" : "s"} · ${ready} ready`;
  return `${INDENT}${chalk.bold("gauge")}  ${chalk.dim(counts)}`;
}

function columnHeader(providers: Provider[]): string {
  const cells = providers
    .map((provider) => pad(chalk.dim(PROVIDER_NAME[provider]), COL_CELL))
    .join("  ");
  return `${INDENT}${" ".repeat(COL_LABEL)}  ${cells}`.trimEnd();
}

function recommendationLine(
  recommendation: UsageRecommendation | null,
  accounts: StatusAccountView[],
  now: Date,
): string {
  if (!recommendation) {
    return `${INDENT}${chalk.dim("No account is currently usable.")}`;
  }
  const id = `${recommendation.account.provider}:${recommendation.account.name}`;
  const picked = accounts.find(
    (account) =>
      account.provider === recommendation.account.provider &&
      account.name === recommendation.account.name,
  );
  const plan = picked?.usage?.plan ? chalk.dim(` · ${picked.usage.plan}`) : "";
  if (recommendation.status === "use_now") {
    const line = `${INDENT}${chalk.green("→")} ${chalk.bold(id)}  ${chalk.dim("ready now")}${plan}`;
    // The second line is the one the dashboard could not say before: something
    // better is about to free up, and switching now would be the worse move.
    const alternative = recommendation.waitFor;
    if (!alternative) return line;
    const waitId = `${alternative.account.provider}:${alternative.account.name}`;
    const waitPlan = alternative.plan ? ` · ${alternative.plan}` : "";
    const left = `${100 - alternative.maximumUtilization}% free`;
    return `${line}\n${INDENT}  ${chalk.dim(`or wait ${timeUntil(alternative.availableAt, now)} for`)} ${chalk.bold(waitId)}${chalk.dim(`${waitPlan} · ${left}`)}`;
  }
  const wait = recommendation.availableAt
    ? timeUntil(recommendation.availableAt, now)
    : "soon";
  return `${INDENT}${chalk.yellow("→")} ${chalk.bold(id)}  ${chalk.dim(`free in ${wait}`)}${plan}`;
}

function errorLines(accounts: StatusAccountView[]): string[] {
  const failed = accounts.filter((account) => account.error);
  if (failed.length === 0) return [];
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
}

function renderEmptyState(): string {
  const width = Math.max(...ADD_STEPS.map((step) => step.label.length));
  const rows = ADD_STEPS.map(
    (step) =>
      `${INDENT}${chalk.white(step.label.padEnd(width))}   ${chalk.dim(step.command)}`,
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
}

// ─── Entry points ────────────────────────────────────────────────────────────

/** Render the full human status dashboard. */
export function renderStatusDashboard(
  accounts: StatusAccountView[],
  recommendation: UsageRecommendation | null,
  now: Date,
): string {
  if (accounts.length === 0) {
    return renderEmptyState();
  }
  const providers = PROVIDER_ORDER.filter((provider) =>
    accounts.some((account) => account.provider === provider),
  );
  const rows = buildRows(accounts, now);
  const width = COL_LABEL + 2 + (COL_CELL + 2) * providers.length - 2;

  const lines: string[] = [""];
  lines.push(header(accounts, now));
  lines.push("");
  lines.push(columnHeader(providers));
  for (const row of rows) {
    const label = pad(chalk.white(truncate(row.label, COL_LABEL)), COL_LABEL);
    const meters = providers
      .map((provider) => meterCell(row.accounts[provider], now))
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
  lines.push("");
  lines.push(`${INDENT}${chalk.dim("─".repeat(width))}`);
  lines.push(recommendationLine(recommendation, accounts, now));
  lines.push(...errorLines(accounts));
  lines.push("");
  return lines.join("\n");
}

/** Render the single-line quick recommendation. */
export function renderQuickRecommendation(
  recommendation: UsageRecommendation | null,
  now: Date,
): string {
  if (!recommendation) return "No account recommendation available.\n";
  const id = `${recommendation.account.provider}:${recommendation.account.name}`;
  if (recommendation.status === "use_now") {
    return `${chalk.green("→")} ${chalk.bold(id)}  ${chalk.dim("ready now")}\n`;
  }
  const wait = recommendation.availableAt
    ? timeUntil(recommendation.availableAt, now)
    : "soon";
  return `${chalk.yellow("→")} ${chalk.bold(id)}  ${chalk.dim(`free in ${wait}`)}\n`;
}
