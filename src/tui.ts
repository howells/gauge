import { spawnSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import chalk from "chalk";
import {
  codexLoginRemedy,
  runRefreshCommand,
  runStatusCommand,
} from "./commands.js";
import { getDataDir } from "./paths.js";
import {
  captureClaudeSession,
  capturedClaudeSessions,
  readClaudeSession,
  switchClaudeSession,
} from "./services/claude-session.js";
import { claudeAccountNamesByUuid } from "./services/machine-logins.js";
import {
  codexSwitchTargets,
  switchCodexLogin,
} from "./services/switch-login.js";

/** One account a surface on this machine can be signed into from here. */
interface SwitchTarget {
  name: string;
  provider: "claude" | "codex";
}

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
function switchFooter(targets: SwitchTarget[]): string {
  const offers = targets
    .map(
      (target, index) =>
        `${chalk.bold(String(index + 1))} ${chalk.dim(`${target.provider}:${target.name}`)}`,
    )
    .join(chalk.dim("  ·  "));
  return `   ${chalk.dim("sign in as:")} ${offers}\n   ${chalk.dim("esc cancel")}\n`;
}

function footer(broken: BrokenAccount[], canSwitch: boolean): string {
  const keys = [
    chalk.bold("r"),
    chalk.dim("reload"),
    chalk.dim("·"),
    chalk.bold("q"),
    chalk.dim("quit"),
  ].join(" ");
  const line = canSwitch
    ? `${keys} ${chalk.dim("·")} ${chalk.bold("s")} ${chalk.dim("switch account")}`
    : keys;
  if (broken.length === 0) {
    return `   ${line}\n`;
  }
  const offers = broken
    .map(
      (account, index) =>
        `${chalk.bold(String(index + 1))} ${chalk.dim(`re-auth ${account.provider}:${account.name}`)}`,
    )
    .join(chalk.dim("  ·  "));
  return `   ${line}\n   ${offers}\n`;
}

/** Present the shared status service as a small keyboard-controlled terminal view. */
export async function runTUI(): Promise<void> {
  let previousLineCount = 0;
  let processing = false;
  let broken: BrokenAccount[] = [];
  let targets: SwitchTarget[] = [];
  let mode: "normal" | "switch" = "normal";

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
    // Capture on sight, so simply using the tools builds the set that can later
    // be switched to and nobody has to remember a capture step.
    captureSignedInClaude();
    const dataDir = getDataDir();
    targets = [
      ...codexSwitchTargets(dataDir).map(
        (target): SwitchTarget => ({ name: target.name, provider: "codex" }),
      ),
      ...capturedClaudeSessions(dataDir).map(
        (name): SwitchTarget => ({ name, provider: "claude" }),
      ),
    ];
    writeView(
      `${result.human}\n${
        mode === "switch"
          ? switchFooter(targets)
          : footer(broken, targets.length > 1)
      }`,
    );
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
      // Not `quiet`, and the result is read rather than assumed. A refresh can
      // succeed while changing nothing: an account that reads its credentials
      // from a Codex home returns ok having done nothing, because the login it
      // needs happens in the Codex CLI. Printing a tick over that is how the
      // view came to report success on an account still broken a second later.
      const result = await runRefreshCommand(account.name, {
        provider: account.provider,
      });
      // An account whose credentials live in a Codex home cannot be re-logged in
      // by gauge, and printing the command for the reader to copy back into the
      // same terminal is the copying this view exists to remove. Run it instead:
      // the terminal is already handed back, so `codex login` gets a real stdio
      // and its browser flow behaves exactly as it would if typed.
      const authMode =
        typeof result.data === "object" &&
        result.data !== null &&
        "auth_mode" in result.data
          ? (result.data as { auth_mode?: unknown }).auth_mode
          : undefined;
      const remedy =
        account.provider === "codex" && authMode === "codex-home"
          ? codexLoginRemedy(account.name)
          : null;

      if (remedy) {
        process.stdout.write(
          `   ${chalk.dim(`codex login · CODEX_HOME=${remedy.home}`)}\n\n`,
        );
        const login = spawnSync("codex", ["login"], {
          env: { ...process.env, CODEX_HOME: remedy.home },
          stdio: "inherit",
        });
        process.stdout.write(
          login.error || login.status !== 0
            ? // Fall back to the words when the CLI is absent or refuses, so the
              // reader is never left with a failure and no next move.
              `\n   ${chalk.red("✗")} ${chalk.dim(login.error ? `codex login could not run (${login.error.message})` : `codex login exited ${login.status}`)}\n${(
                result.human ?? ""
              )
                .trim()
                .split("\n")
                .map((line) => `   ${line}`)
                .join("\n")}\n`
            : `\n   ${chalk.green("✓")} ${chalk.dim("codex login finished")}\n`,
        );
      } else {
        const guidance = result.human?.trim();
        if (guidance) {
          process.stdout.write(
            `${guidance
              .split("\n")
              .map((line) => `   ${line}`)
              .join("\n")}\n`,
          );
        }
        process.stdout.write(
          result.ok
            ? `   ${chalk.green("✓")} ${chalk.dim("refresh completed")}\n`
            : `   ${chalk.red("✗")} ${chalk.dim("refresh reported a failure")}\n`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`   ${chalk.red("✗")} ${chalk.dim(message)}\n`);
    } finally {
      process.stdin.setRawMode(true);
    }
    process.stdout.write(`\n   ${chalk.dim("any key to continue")}`);
    await new Promise<void>((resolve) =>
      process.stdin.once("keypress", () => resolve()),
    );
    previousLineCount = 0;
    await reload();
  };

  /**
   * Store the Claude Code session under whichever configured account it is.
   *
   * Matched on `accountUuid`, not on the address. The sanitized status payload
   * carries no email for Claude accounts — measured: every one reports
   * `usage.email` null — so an address match silently captured nothing. The UUID
   * is in the browser state gauge kept when it signed into the account itself,
   * which is the same join that names the desktop app's account.
   */
  const captureSignedInClaude = (): void => {
    const session = readClaudeSession();
    const uuid = session?.profile.accountUuid;
    if (!session || typeof uuid !== "string") return;
    const name = claudeAccountNamesByUuid(getDataDir()).get(uuid);
    if (!name) return;
    try {
      captureClaudeSession(getDataDir(), name, session);
    } catch {
      // Capture is a convenience; never let it stop the dashboard drawing.
    }
  };

  /**
   * Sign the Codex CLI into one of the accounts gauge already holds.
   *
   * No browser and no login: the whole session is a `CODEX_HOME` directory and
   * gauge keeps one per account, so this is a copy between two directories it
   * owns. The previous credentials are kept beside the new ones, because a
   * switch that cannot be undone is a worse trade than a stale file.
   */
  const switchAccount = async (target: SwitchTarget): Promise<void> => {
    mode = "normal";
    try {
      const result =
        target.provider === "codex"
          ? switchCodexLogin(target.name, getDataDir())
          : switchClaudeSession(target.name, getDataDir());
      const surface = target.provider === "codex" ? "Codex" : "Claude Code";
      process.stdout.write(
        `\n   ${chalk.green("✓")} ${chalk.dim(`${surface} now signed in as ${target.name}`)}${
          result.backedUp ? chalk.dim(" · previous kept") : ""
        }\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`\n   ${chalk.red("✗")} ${chalk.dim(message)}\n`);
    }
    previousLineCount = 0;
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
        if (mode === "switch") {
          if (key.name === "escape" || key.name === "s") {
            mode = "normal";
            processing = true;
            reload()
              .catch(reject)
              .finally(() => {
                processing = false;
              });
            return;
          }
          const pick = Number.parseInt(key.name ?? "", 10);
          const target = Number.isInteger(pick) ? targets[pick - 1] : undefined;
          if (!target) return;
          processing = true;
          switchAccount(target)
            .catch(reject)
            .finally(() => {
              processing = false;
            });
          return;
        }
        if (key.name === "s" && targets.length > 1) {
          mode = "switch";
          processing = true;
          reload()
            .catch(reject)
            .finally(() => {
              processing = false;
            });
          return;
        }
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
