import process from "node:process";
import readline from "node:readline";
import chalk from "chalk";
import { runRefreshCommand, runStatusCommand } from "./commands.js";

/** An account the last reading could not read, and the keystroke that fixes it. */
interface BrokenAccount {
  name: string;
  provider: string;
}

/**
 * The accounts in a status payload that failed to read.
 *
 * Read defensively from the command's own data rather than re-deriving it: the
 * dashboard and this list must always name the same accounts, and the payload is
 * the one thing both already agree on.
 */
function brokenAccounts(data: unknown): BrokenAccount[] {
  if (typeof data !== "object" || data === null || !("accounts" in data)) {
    return [];
  }
  const { accounts } = data as { accounts?: unknown };
  if (!Array.isArray(accounts)) return [];
  return accounts.flatMap((account) => {
    if (typeof account !== "object" || account === null) return [];
    const entry = account as {
      error?: unknown;
      name?: unknown;
      provider?: unknown;
    };
    if (!entry.error) return [];
    if (typeof entry.name !== "string" || typeof entry.provider !== "string") {
      return [];
    }
    return [{ name: entry.name, provider: entry.provider }];
  });
}

/**
 * The key legend, and the re-auth offers when there is anything to fix.
 *
 * A dashboard that prints `gauge refresh codex danielhowells` has already done
 * the thinking; making the reader copy it back into the same terminal is the
 * part worth removing. Numbering the broken accounts turns that into one
 * keystroke, and the numbers match the order they appear in above.
 */
function footer(broken: BrokenAccount[]): string {
  const keys = [
    chalk.bold("r"),
    chalk.dim("reload"),
    chalk.dim("·"),
    chalk.bold("q"),
    chalk.dim("quit"),
  ].join(" ");
  if (broken.length === 0) {
    return `   ${keys}\n`;
  }
  const offers = broken
    .map(
      (account, index) =>
        `${chalk.bold(String(index + 1))} ${chalk.dim(`re-auth ${account.provider}:${account.name}`)}`,
    )
    .join(chalk.dim("  ·  "));
  return `   ${keys}\n   ${offers}\n`;
}

/** Present the shared status service as a small keyboard-controlled terminal view. */
export async function runTUI(): Promise<void> {
  let previousLineCount = 0;
  let processing = false;
  let broken: BrokenAccount[] = [];

  const writeView = (content: string): void => {
    if (previousLineCount > 0) {
      process.stdout.write(`\x1b[${previousLineCount}A\x1b[0J`);
    }
    process.stdout.write(content);
    previousLineCount = (content.match(/\n/g) ?? []).length;
  };

  const reload = async (): Promise<void> => {
    writeView(`\n   ${chalk.bold("gauge")}  ${chalk.dim("· loading...")}\n`);
    const result = await runStatusCommand({ quiet: true });
    broken = brokenAccounts(result.data);
    writeView(`${result.human}\n${footer(broken)}`);
  };

  /**
   * Hand the terminal back, run the account's real auth flow, and take it again.
   *
   * The flow opens a browser and prints for itself, so raw mode has to be off
   * while it runs or its output arrives with no line discipline and its prompts
   * cannot be answered. The redraw counter is reset rather than adjusted: what
   * the flow printed is not this view's to erase.
   */
  const reauthenticate = async (account: BrokenAccount): Promise<void> => {
    process.stdin.setRawMode(false);
    process.stdout.write(
      `\n   ${chalk.yellow("→")} ${chalk.bold(`${account.provider}:${account.name}`)} ${chalk.dim("· re-authenticating")}\n\n`,
    );
    previousLineCount = 0;
    try {
      await runRefreshCommand(account.name, {
        provider: account.provider,
        quiet: true,
      });
      process.stdout.write(`   ${chalk.green("✓")} ${chalk.dim("done")}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`   ${chalk.red("✗")} ${chalk.dim(message)}\n`);
    } finally {
      process.stdin.setRawMode(true);
    }
    await reload();
  };

  await reload();
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  try {
    await new Promise<void>((resolve, reject) => {
      const onKeypress = (
        _value: string,
        key: { ctrl?: boolean; name?: string },
      ): void => {
        if ((key.ctrl && key.name === "c") || key.name === "q") {
          resolve();
          return;
        }
        if (processing) return;
        const digit = Number.parseInt(key.name ?? "", 10);
        const chosen = Number.isInteger(digit) ? broken[digit - 1] : undefined;
        if (chosen) {
          processing = true;
          reauthenticate(chosen)
            .catch(reject)
            .finally(() => {
              processing = false;
            });
          return;
        }
        if (key.name !== "r") return;
        processing = true;
        reload()
          .catch(reject)
          .finally(() => {
            processing = false;
          });
      };
      process.stdin.on("keypress", onKeypress);
      const detach = (): void => {
        process.stdin.off("keypress", onKeypress);
      };
      process.stdin.once("end", () => {
        detach();
        resolve();
      });
      process.stdin.once("error", (error) => {
        detach();
        reject(error);
      });
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.removeAllListeners("keypress");
    // emitKeypressEvents leaves stdin resumed with an internal data listener;
    // pause it so the handle stops keeping the event loop alive and the
    // process can exit on its own after the view returns.
    process.stdin.pause();
    process.stdout.write("\n");
  }
}
