import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import type { Provider } from "../domain/account.js";
import type { UsageRecommendation } from "../domain/recommendation.js";
import type { AccountSnapshot } from "../domain/snapshot.js";
import { getDataDir } from "../paths.js";
import {
  claudeAccountNamesByUuid,
  readMachineLogins,
} from "./machine-logins.js";
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

type WindowView = NonNullable<AccountSnapshot["usage"]>["windows"][number];

/** What to call each limit in the one line of room a cell has for it. */
const WINDOW_LABEL: Record<WindowView["kind"], string> = {
  session: "session",
  weekly: "wk",
  included: "plan",
  on_demand: "on-demand",
};

interface CellStatus {
  kind: "ready" | "blocked" | "error";
  primary: WindowView | null;
  secondary: WindowView | null;
  waitMs: number;
}

/**
 * The two windows a cell draws, and whether either of them blocks.
 *
 * Position picks which window goes where, but only the window's own `kind`
 * names it. Providers report the short horizon first, so the meter is the
 * account's most immediate limit and the detail line is the longer one; that
 * ordering is a presentation choice and no longer a claim about *meaning*,
 * which is what it silently became when an absent window let its neighbour
 * inherit its slot.
 */
function cellStatus(account: StatusAccountView, now: Date): CellStatus {
  if (account.error || !account.usage) {
    return { kind: "error", primary: null, secondary: null, waitMs: Infinity };
  }
  const windows = account.usage.windows;
  const primary = windows[0] ?? null;
  const secondary = windows[1] ?? null;
  const blocked = windows.filter((window) => window.usedPercent >= 100);
  if (blocked.length > 0) {
    const waits = blocked.map((window) =>
      window.resetsAt === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, new Date(window.resetsAt).getTime() - now.getTime()),
    );
    return { kind: "blocked", primary, secondary, waitMs: Math.min(...waits) };
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

/**
 * The reader's own row order, from `display.json` in the data directory.
 *
 * Kept out of the per-account `config.json` files deliberately: those are
 * schema-versioned account *state* that the migration and packing gates police,
 * and which account a person likes to look at first is neither state nor an
 * account's business. A missing or malformed file simply means "no preference",
 * because a display nicety must never be able to stop a status reading.
 *
 * ```json
 * { "accountOrder": ["gmail", "danielhowells", "materialinstruments"] }
 * ```
 */
function preferredOrder(): string[] {
  try {
    const raw = fs.readFileSync(
      path.join(getDataDir(), "display.json"),
      "utf8",
    );
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return [];
    const { accountOrder } = parsed as { accountOrder?: unknown };
    if (!Array.isArray(accountOrder)) return [];
    return accountOrder.filter(
      (name): name is string => typeof name === "string",
    );
  } catch {
    return [];
  }
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
  const preferred = preferredOrder();
  return [...rows.values()].sort((left, right) => {
    // A named order wins outright when one is configured. Row order is a reading
    // aid — which account you look for first is a fact about the person, not
    // about the data — so it belongs to the reader and not to the sort below.
    const leftRank = preferred.indexOf(left.label);
    const rightRank = preferred.indexOf(right.label);
    if (leftRank !== rightRank) {
      // Unlisted names keep the computed order, after every listed one.
      if (leftRank === -1) return 1;
      if (rightRank === -1) return -1;
      return leftRank - rightRank;
    }
    if (left.minWaitMs !== right.minWaitMs) {
      return left.minWaitMs - right.minWaitMs;
    }
    return left.label.localeCompare(right.label);
  });
}

// ─── Cells ───────────────────────────────────────────────────────────────────

function meterCell(
  account: StatusAccountView | undefined,
  now: Date,
  active = false,
): string {
  // Two columns of gutter on every cell so the marker costs no width and the
  // grid does not shift as the cursor moves across it.
  const gutter = active ? chalk.cyan("› ") : "  ";
  const cell = (content: string): string =>
    `${gutter}${pad(content, COL_CELL - 2)}`;
  if (!account) return cell(chalk.dim("·"));
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
    const wait = Number.isFinite(status.waitMs)
      ? ` ${chalk.dim(`· ${timeUntil(new Date(now.getTime() + status.waitMs).toISOString(), now)}`)}`
      : "";
    return cell(`${meter(100)} ${chalk.red("full")}${wait}`);
  }
  // An idle window has nothing counting down, so there is no clock to show.
  const reset =
    window.usedPercent > 0 && window.resetsAt !== null
      ? ` ${chalk.dim(`· ${timeUntil(window.resetsAt, now)}`)}`
      : "";
  return cell(`${meter(percent)} ${percent}%${reset}`);
}

function detailCell(account: StatusAccountView | undefined, now: Date): string {
  // The same two-column gutter `meterCell` reserves for the cursor, so a detail
  // line sits under its own meter and every column keeps one width.
  const width = COL_CELL - 2;
  const cell = (content: string): string => `  ${pad(content, width)}`;
  if (!account?.usage) return cell("");
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
  const reading =
    second === null
      ? null
      : `${WINDOW_LABEL[second.kind]} ${Math.round(second.usedPercent)}%${
          second.resetsAt === null
            ? ""
            : ` · ${timeUntil(second.resetsAt, now)}`
        }`;
  const renews = account.usage.renewsAt
    ? `renews ${timeUntil(account.usage.renewsAt, now)}`
    : null;

  // Widest first, and what goes when it will not fit is a judgement about which
  // of these is worth the column. The renewal date goes first; then the plan,
  // which is a static label the reader already knows and the recommendation
  // line repeats. The usage reading is never what gets dropped — it is the only
  // part that changes, and dropping it is how a team pool at 59% came to be
  // trimmed off a row that had just learned how to measure it.
  for (const tier of [
    [plan, reading, renews],
    [plan, reading],
    [reading ?? plan],
  ]) {
    const line = tier
      .filter((part): part is string => part !== null)
      .join(" · ");
    if (visibleLength(line) <= width) return cell(chalk.dim(line));
  }
  return cell(chalk.dim(truncate(reading ?? plan ?? "", width)));
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
    // Two-space gutter to match the cells, so a heading sits over its column.
    .map(
      (provider) =>
        `  ${pad(chalk.dim(PROVIDER_NAME[provider]), COL_CELL - 2)}`,
    )
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

/**
 * Which account each tool on this machine is signed into, and whether that is
 * one of the accounts above.
 *
 * The grid answers "how much is left"; this answers "and which one am I
 * actually typing into", which no amount of usage data can tell you. Worth its
 * four lines because the surfaces disagree silently: a Claude Code CLI, a Claude
 * desktop app and a Codex CLI on one machine can be three different accounts,
 * and nothing else on screen would say so.
 *
 * A login that matches a configured account is named with it. One that does not
 * is called out as untracked, because an account you are working in and not
 * watching is the one most likely to run out without warning.
 */
function machineLines(accounts: StatusAccountView[]): string[] {
  const logins = readMachineLogins();
  if (logins.length === 0) return [];

  const byEmail = new Map<string, string>();
  for (const account of accounts) {
    const email = account.usage?.email;
    if (email) byEmail.set(email.toLowerCase(), account.name);
  }
  const claudeCode = logins.find((login) => login.surface === "Claude Code");
  const byUuid = claudeAccountNamesByUuid(getDataDir());

  const width = Math.max(...logins.map((login) => login.surface.length));
  return [
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
            `an account not configured here · ${(login.accountId ?? "unknown").slice(0, 8)}…`,
          );
      return `${INDENT}${surface}  ${detail}`;
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
/**
 * The account rows in the order the dashboard draws them.
 *
 * Exported so a keyboard cursor can index the same sequence the reader sees.
 * Deriving it separately is how a cursor comes to land on a different row from
 * the one it highlights — the display is sorted by the reader's own preference,
 * and any second ordering will disagree with it the moment that file exists.
 */
export function statusRowOrder(
  accounts: StatusAccountView[],
  now: Date,
): string[] {
  return buildRows(accounts, now).map((row) => row.label);
}

/** The apps the dashboard draws columns for, in the order it draws them. */
export function statusProviderOrder(accounts: StatusAccountView[]): Provider[] {
  return PROVIDER_ORDER.filter((provider) =>
    accounts.some((account) => account.provider === provider),
  );
}

export function renderStatusDashboard(
  accounts: StatusAccountView[],
  recommendation: UsageRecommendation | null,
  now: Date,
  /**
   * The cell a keyboard is currently on, when a reader is driving this.
   *
   * A cell, not a row: this grid is accounts down and *apps* across, and which
   * app a given account is signed into is an independent fact per app. A row
   * selection could only ever offer to change all of them at once, which is not
   * a thing anybody wants to do.
   *
   * Passed only by the interactive view; every other caller renders the same
   * dashboard with nothing marked. Selection lives here rather than in a second
   * renderer because this one string is what `gauge status --format human`
   * prints too, and two renderers for one grid is how the piped output and the
   * one on screen come to disagree.
   */
  selected?: { label: string; provider: Provider },
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
    const onRow = selected?.label === row.label;
    const name = truncate(row.label, COL_LABEL);
    const label = pad(
      onRow ? chalk.cyan.bold(name) : chalk.white(name),
      COL_LABEL,
    );
    const meters = providers
      .map((provider) =>
        meterCell(
          row.accounts[provider],
          now,
          onRow && selected?.provider === provider,
        ),
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
  lines.push("");
  lines.push(`${INDENT}${chalk.dim("─".repeat(width))}`);
  lines.push(recommendationLine(recommendation, accounts, now));
  lines.push(...errorLines(accounts));
  lines.push(...machineLines(accounts));
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
