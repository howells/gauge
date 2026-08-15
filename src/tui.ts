import process from "node:process";
import readline from "node:readline";
import chalk from "chalk";
import { listAccountDetails } from "./accounts.js";
import { addAccount, addCursorAccount, fetchAllUsage } from "./api.js";
import { runAddCommand } from "./commands.js";
import { markCurrentAccounts } from "./current-account.js";
import {
  buildGrid,
  claudeToUnified,
  formatInteractiveDashboard,
  type GridRow,
  type ProviderGroups,
} from "./display.js";
import { fetchCodexAccounts, fetchCursorAccounts } from "./provider-usage.js";
import type { Provider } from "./types.js";

const INDENT = "   ";
const PROVIDER_CHOICES: Array<{
  description: string;
  label: string;
  provider: Provider;
}> = [
  {
    description: "browser login or storage-state file",
    label: "Claude",
    provider: "claude",
  },
  {
    description: "existing Codex home with auth.json",
    label: "Codex",
    provider: "codex",
  },
  {
    description: "browser login or storage-state file",
    label: "Cursor",
    provider: "cursor",
  },
];

async function fetchAllGroups(): Promise<ProviderGroups> {
  const allConfigs = listAccountDetails();
  const codexConfigs = allConfigs.filter(
    (account) => account.provider === "codex",
  );
  const cursorConfigs = allConfigs.filter(
    (account) => account.provider === "cursor",
  );
  const [codex, cursor] = await Promise.all([
    fetchCodexAccounts(codexConfigs),
    fetchCursorAccounts(cursorConfigs),
  ]);
  const claudeConfigs = allConfigs.filter(
    (account) => account.provider === "claude",
  );
  const claudeRaw =
    claudeConfigs.length > 0
      ? await fetchAllUsage(
          claudeConfigs.map((account) => ({
            authKey: account.authKey,
            name: account.name,
            renewsAt: account.renewsAt,
          })),
          { quiet: true },
        )
      : [];
  const claude = claudeRaw.map(claudeToUnified);
  return markCurrentAccounts(
    {
      ...(claude.length > 0 && { claude }),
      ...(codex.length > 0 && { codex }),
      ...(cursor.length > 0 && { cursor }),
    },
    allConfigs,
  );
}

export async function runTUI(): Promise<void> {
  let groups: ProviderGroups = {};
  let rows: GridRow[] = [];
  let selectedIndex = 0;
  let statusMessage: string | null = null;
  let isProcessing = false;
  let activeBrowserAbort: AbortController | null = null;
  let activeBrowserAbortCleanup: (() => void) | null = null;
  let lastLineCount = 0;

  function writeLines(content: string): void {
    if (lastLineCount > 0) {
      process.stdout.write(`\x1b[${lastLineCount}A\x1b[0J`);
    }
    process.stdout.write(content);
    lastLineCount = (content.match(/\n/g) ?? []).length;
  }

  function clearScreen(): void {
    process.stdout.write("\x1b[2J\x1b[H");
    lastLineCount = 0;
  }

  writeLines(
    `\n${INDENT}${chalk.bold("gauge")}  ${chalk.dim("·  loading...")}\n\n`,
  );

  groups = await fetchAllGroups();
  rows = buildGrid(groups);

  function redraw(): void {
    writeLines(
      formatInteractiveDashboard(groups, rows, selectedIndex, statusMessage),
    );
  }

  async function reloadValues(message = "Refreshing..."): Promise<void> {
    const selectedLabel = rows[selectedIndex]?.label;
    statusMessage = message;
    redraw();
    groups = await fetchAllGroups();
    rows = buildGrid(groups);
    selectedIndex = Math.max(
      0,
      selectedLabel
        ? rows.findIndex((row) => row.label === selectedLabel)
        : selectedIndex,
    );
    if (selectedIndex < 0) selectedIndex = 0;
    selectedIndex = Math.min(selectedIndex, Math.max(0, rows.length - 1));
    statusMessage = null;
    redraw();
  }

  redraw();

  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);

  const onKeypress = async (
    _str: string,
    key: { name: string; ctrl: boolean },
  ): Promise<void> => {
    if (!key) return;

    if (
      activeBrowserAbort &&
      (key.name === "escape" ||
        key.name === "q" ||
        (key.ctrl && key.name === "c"))
    ) {
      statusMessage = "Cancelling browser auth...";
      activeBrowserAbort.abort();
      redraw();
      return;
    }

    if ((key.ctrl && key.name === "c") || key.name === "q") {
      cleanup();
      process.exit(0);
    }

    if (isProcessing) return;

    if (key.name === "up" || key.name === "k") {
      selectedIndex = Math.max(0, selectedIndex - 1);
      redraw();
      return;
    }

    if (key.name === "down" || key.name === "j") {
      selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
      redraw();
      return;
    }

    if (key.name === "r") {
      isProcessing = true;
      await reloadValues();
      isProcessing = false;
      return;
    }

    if (key.name === "a") {
      isProcessing = true;
      await doAddAccount();
      isProcessing = false;
      return;
    }

    if (key.name === "return") {
      const row = rows[selectedIndex];
      if (row?.claude?.error != null || row?.cursor?.error != null) {
        isProcessing = true;
        await doRefresh(row);
        isProcessing = false;
      }
    }
  };

  process.stdin.on("keypress", onKeypress);

  async function doAddAccount(): Promise<void> {
    process.stdin.off("keypress", onKeypress);
    process.stdin.setRawMode(false);
    clearScreen();
    process.stdout.write(formatAddHeader());

    try {
      const provider = await promptProvider();
      if (!provider) {
        statusMessage = "Add cancelled.";
        return;
      }

      const name = await promptRequired("Account name");
      if (!name) {
        statusMessage = "Add cancelled.";
        return;
      }

      const options: {
        codexHome?: string;
        dryRun?: boolean;
        provider: Provider;
        quiet: boolean;
        renewsAt?: string;
        storageStateFile?: string;
      } = {
        provider,
        quiet: true,
      };

      if (provider === "codex") {
        const codexHome = await promptRequired(
          "Codex home",
          process.env.CODEX_HOME ?? "~/.codex",
        );
        if (!codexHome) {
          statusMessage = "Add cancelled.";
          return;
        }
        options.codexHome = expandHomePath(codexHome);
      } else {
        const storageStateFile = await promptLine(
          "Storage-state file (blank opens browser)",
        );
        if (isCancelInput(storageStateFile)) {
          statusMessage = "Add cancelled.";
          return;
        }
        if (storageStateFile) {
          options.storageStateFile = expandHomePath(storageStateFile);
        }
      }

      const renewsAt = await promptLine("Renewal date (optional, YYYY-MM-DD)");
      if (isCancelInput(renewsAt)) {
        statusMessage = "Add cancelled.";
        return;
      }
      if (renewsAt) options.renewsAt = renewsAt;

      if (!options.storageStateFile && provider !== "codex") {
        process.stdout.write(
          `\nOpening browser for ${provider}:${name}. Log in, then close the tab. Press Esc or q here to cancel.\n`,
        );
      }

      const signal =
        !options.storageStateFile && provider !== "codex"
          ? beginBrowserAuthCancel()
          : undefined;
      try {
        await runAddCommand(name, { ...options, dryRun: false, signal });
      } finally {
        endBrowserAuthCancel();
      }
      await reloadValues("Reloading...");
      statusMessage = `Added ${provider}:${name}.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = message === "Cancelled" ? "Add cancelled." : message;
    } finally {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("keypress", onKeypress);
      clearScreen();
      redraw();
    }
  }

  async function doRefresh(row: GridRow): Promise<void> {
    process.stdin.setRawMode(true);
    const provider = row.claude?.error ? "claude" : "cursor";
    statusMessage = `Opening browser for ${provider}:${row.label} — log in and close the tab. Esc/q cancels.`;
    redraw();

    const account = listAccountDetails(provider).find(
      (item) => item.name === row.label,
    );
    const signal = beginBrowserAuthCancel();
    let ok = false;
    try {
      ok =
        provider === "claude"
          ? await addAccount(row.label, {
              authKey: account?.authKey,
              quiet: true,
              signal,
            })
          : await addCursorAccount(row.label, {
              authKey: account?.authKey,
              quiet: true,
              signal,
            });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      statusMessage = message === "Cancelled" ? "Re-auth cancelled." : message;
    } finally {
      endBrowserAuthCancel();
    }

    if (ok) {
      await reloadValues("Reloading...");
    } else if (statusMessage === null) {
      statusMessage = `Re-auth failed for ${row.label}  ·  enter to retry`;
    }

    process.stdin.setRawMode(true);
    redraw();
  }

  function cleanup(): void {
    process.stdin.setRawMode(false);
    process.stdin.off("keypress", onKeypress);
    process.stdout.write("\n");
  }

  function beginBrowserAuthCancel(): AbortSignal {
    const controller = new AbortController();
    const abort = (): void => {
      if (controller.signal.aborted) return;
      statusMessage = "Cancelling browser auth...";
      controller.abort();
      redraw();
    };
    const onData = (chunk: Buffer): void => {
      if (
        chunk.includes(0x03) ||
        chunk.includes(0x1b) ||
        chunk.includes(0x71)
      ) {
        abort();
      }
    };
    activeBrowserAbort = controller;
    activeBrowserAbortCleanup = () => {
      process.stdin.off("data", onData);
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    return controller.signal;
  }

  function endBrowserAuthCancel(): void {
    activeBrowserAbort = null;
    activeBrowserAbortCleanup?.();
    activeBrowserAbortCleanup = null;
  }
}

function formatAddHeader(): string {
  const lines = [
    "",
    `${INDENT}${chalk.bold("Add account")}`,
    "",
    ...PROVIDER_CHOICES.map(
      (choice, index) =>
        `${INDENT}${index + 1}. ${choice.label.padEnd(6)} ${chalk.dim(choice.description)}`,
    ),
    "",
    `${INDENT}${chalk.dim("Type q at any prompt to cancel.")}`,
    "",
  ];
  return lines.join("\n");
}

async function promptProvider(): Promise<Provider | null> {
  const answer = await promptLine("Provider [1/2/3 or claude/codex/cursor]");
  if (isCancelInput(answer)) return null;
  const normalized = answer.toLowerCase();
  if (normalized === "1" || normalized === "claude" || normalized === "c") {
    return "claude";
  }
  if (normalized === "2" || normalized === "codex" || normalized === "x") {
    return "codex";
  }
  if (normalized === "3" || normalized === "cursor" || normalized === "u") {
    return "cursor";
  }
  process.stdout.write("Choose 1, 2, 3, claude, codex, or cursor.\n");
  return promptProvider();
}

async function promptRequired(
  label: string,
  defaultValue?: string,
): Promise<string | null> {
  const answer = await promptLine(label, defaultValue);
  if (isCancelInput(answer)) return null;
  if (answer) return answer;
  process.stdout.write(`${label} is required.\n`);
  return promptRequired(label, defaultValue);
}

async function promptLine(
  label: string,
  defaultValue?: string,
): Promise<string> {
  const suffix = defaultValue ? ` (${defaultValue})` : "";
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(`${INDENT}${label}${suffix}: `, (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed || defaultValue || "");
    });
  });
}

function isCancelInput(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "q" || normalized === "quit" || normalized === "cancel";
}

function expandHomePath(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) {
    return `${process.env.HOME ?? "~"}${value.slice(1)}`;
  }
  return value;
}
