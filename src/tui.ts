import { spawnSync } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import chalk from "chalk";
import {
  codexLoginRemedy,
  runAddCommand,
  runRefreshCommand,
  runStatusCommand,
} from "./commands.js";
import { assertSafeName, getDataDir } from "./paths.js";
import {
  captureClaudeSession,
  capturedClaudeSessions,
  readClaudeSession,
  switchClaudeSession,
} from "./services/claude-session.js";
import {
  codexHomeHasLogin,
  createCodexHome,
  managedCodexHome,
  resolveCodexHomeInput,
} from "./services/codex-home.js";
import { claudeAccountNamesByUuid } from "./services/machine-logins.js";
import {
  renderStatusDashboard,
  type StatusAccountView,
  statusProviderOrder,
  statusRowOrder,
} from "./services/render-status.js";
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
 * What each column is called when the subject is the account, not the app.
 *
 * Deliberately not the app names the sign-in offer uses: you sign *Claude Code*
 * in, but the thing you add is a *Claude* account, and the two are only the same
 * word by coincidence for Codex.
 */
const SURFACE_NAME: Record<"claude" | "codex" | "cursor", string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

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
/**
 * The keys, and what Enter would do to the cell the cursor is on.
 *
 * Written against the selection rather than as a fixed legend, because a key
 * that is listed but does nothing to the thing you are looking at is worse than
 * no legend at all. Cursor is the only surface gauge cannot sign in — it has no
 * per-account credential store to move — so the legend says that where it is
 * true instead of offering an action that would fail.
 */
function footer(
  broken: BrokenAccount[],
  selected: { label: string; provider: string } | undefined,
  targets: SwitchTarget[],
): string {
  const surface =
    selected?.provider === "codex"
      ? "Codex"
      : selected?.provider === "claude"
        ? "Claude Code"
        : "Cursor";
  const available =
    selected !== undefined &&
    targets.some(
      (target) =>
        target.name === selected.label && target.provider === selected.provider,
    );
  // Three states, and the middle one used to be a dead end: a cell with nothing
  // stored said so and offered nothing, while the only way to store a session
  // was to already be signed into it. Enter starts the real login there.
  const action =
    selected?.provider === "cursor"
      ? chalk.dim("enter · Cursor cannot be signed in from here")
      : available
        ? `${chalk.bold("enter")} ${chalk.dim(`sign ${surface} in as ${selected?.label}`)}`
        : `${chalk.bold("enter")} ${chalk.dim(
            selected?.provider === "codex"
              ? `log in to Codex as ${selected?.label}`
              : "log in to Claude Code",
          )}`;
  // Two lines, split by what the key depends on. Everything above moves the
  // cursor or acts on the whole view; everything below acts on the one cell the
  // cursor is in, and rereads differently as it moves. One run of them came to
  // 113 columns against a 112-column grid, which is the point at which a legend
  // stops being glanceable anyway.
  const keys = [
    `${chalk.bold("↑↓")} ${chalk.dim("account")}`,
    `${chalk.bold("←→")} ${chalk.dim("app")}`,
    `${chalk.bold("a")} ${chalk.dim("add account")}`,
    `${chalk.bold("r")} ${chalk.dim("reload")}`,
    `${chalk.bold("q")} ${chalk.dim("quit")}`,
  ].join(chalk.dim("  ·  "));
  const lines = [keys, action];
  if (broken.length > 0) {
    lines.push(
      broken
        .map(
          (account, index) =>
            `${chalk.bold(String(index + 1))} ${chalk.dim(`re-auth ${account.provider}:${account.name}`)}`,
        )
        .join(chalk.dim("  ·  ")),
    );
  }
  return `${lines.map((line) => `   ${line}`).join("\n")}\n`;
}

/** Present the shared status service as a small keyboard-controlled terminal view. */
export async function runTUI(): Promise<void> {
  let previousLineCount = 0;
  let processing = false;
  // A typed answer is not a set of shortcuts. While a prompt is open every key
  // belongs to the line being typed, or `q` in the middle of an account name
  // would quit the view it was being added to.
  let prompting = false;
  let broken: BrokenAccount[] = [];
  let targets: SwitchTarget[] = [];
  let rowLabels: string[] = [];
  let columns: ("claude" | "codex" | "cursor")[] = [];
  let row = 0;
  let column = 0;

  const writeView = (content: string): void => {
    if (previousLineCount > 0) {
      process.stdout.write(`\x1b[${previousLineCount}A\x1b[0J`);
    }
    process.stdout.write(content);
    previousLineCount = (content.match(/\n/g) ?? []).length;
  };

  /**
   * The last reading, kept so the cursor can move without asking the network.
   *
   * Moving a cursor is not a reason to re-query every provider: it costs a
   * round trip per account and the figures cannot have changed in the time it
   * takes to press an arrow key. Drawing reads this; only `r`, and an action
   * that actually changed something, replace it.
   */
  let snapshot: {
    dashboard: string;
    recommendation: Parameters<typeof renderStatusDashboard>[1];
    views: StatusAccountView[];
  } | null = null;

  /** Repaint from what is already known — no network, no flicker. */
  const draw = (): void => {
    if (!snapshot) return;
    const label = rowLabels[row];
    const provider = columns[column];
    const selected = label && provider ? { label, provider } : undefined;
    const dashboard =
      snapshot.views.length > 0
        ? renderStatusDashboard(
            snapshot.views,
            snapshot.recommendation,
            new Date(),
            selected,
          )
        : snapshot.dashboard;
    writeView(`${dashboard}\n${footer(broken, selected, targets)}`);
  };

  /** Ask every provider again, then repaint. */
  const reload = async (): Promise<void> => {
    writeView(`\n   ${chalk.bold("gauge")}  ${chalk.dim("· loading...")}\n`);
    const result = await runStatusCommand({ quiet: true });
    broken = brokenAccounts(result.data);
    const payload = result.data as {
      accounts?: StatusAccountView[];
      recommendation?: Parameters<typeof renderStatusDashboard>[1];
    };
    const views = payload.accounts ?? [];
    // The same order the dashboard draws, so the cursor cannot highlight one
    // cell while Enter acts on another.
    rowLabels = statusRowOrder(views, new Date());
    columns = statusProviderOrder(views);
    if (row >= rowLabels.length) row = Math.max(0, rowLabels.length - 1);
    if (column >= columns.length) column = Math.max(0, columns.length - 1);
    // Capture on sight, so simply using the tools builds the set that can later
    // be switched to and nobody has to remember a capture step.
    captureSignedInClaude();
    refreshTargets();
    snapshot = {
      dashboard: result.human ?? "",
      recommendation: payload.recommendation ?? null,
      views,
    };
    draw();
  };

  /** The accounts each app could be signed into, from what gauge holds now. */
  const refreshTargets = (): void => {
    const dataDir = getDataDir();
    targets = [
      ...codexSwitchTargets(dataDir).map(
        (target): SwitchTarget => ({ name: target.name, provider: "codex" }),
      ),
      ...capturedClaudeSessions(dataDir).map(
        (name): SwitchTarget => ({ name, provider: "claude" }),
      ),
    ];
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
  /**
   * Sign one app into one account — the cell the cursor is on, and nothing else.
   *
   * Independent per app on purpose. Which account each tool is signed into is a
   * separate decision, and an action that moved them together could only ever be
   * wrong for whichever one you did not mean.
   */
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
   * Run a tool's own login, with the terminal handed back so it can use it.
   *
   * Codex is aimed at the account, because gauge owns a home per account and can
   * point CODEX_HOME at it. Claude Code has one session on the machine and no
   * way to be told which account to take, so it signs in wherever the browser is
   * taken and the result is captured under whichever account that proves to be.
   */
  const runLogin = async (
    name: string,
    provider: "claude" | "codex" | "cursor",
  ): Promise<void> => {
    if (provider === "codex") {
      const remedy = codexLoginRemedy(name);
      if (!remedy) throw new Error(`No Codex home for "${name}".`);
      const login = spawnSync("codex", ["login"], {
        env: { ...process.env, CODEX_HOME: remedy.home },
        stdio: "inherit",
      });
      if (login.error) throw login.error;
      if (login.status !== 0) {
        throw new Error(`codex login exited ${login.status}`);
      }
      return;
    }
    const login = spawnSync("claude", ["auth", "login"], { stdio: "inherit" });
    if (login.error) throw login.error;
    if (login.status !== 0) {
      throw new Error(`claude auth login exited ${login.status}`);
    }
    captureSignedInClaude();
    refreshTargets();
  };

  /**
   * One line of typed input, read from the keypress stream the view already owns.
   *
   * Not `readline.createInterface`, which is the obvious way and does not work
   * here: a second interface over the same stdin takes the keypress machinery
   * with it when it closes, and the view is left with a terminal in raw mode that
   * no longer emits anything — the grid draws, and every key after the prompt is
   * swallowed. Echoing the line by hand is a few more lines than the handoff and
   * leaves exactly one input regime for the whole view.
   *
   * Ctrl-C and escape cancel the answer rather than the process — abandoning half
   * an account name is not abandoning the dashboard — and are reported as `null`
   * so a caller can tell them apart from an empty line, which usually means "take
   * the default you just showed me".
   */
  const ask = async (question: string): Promise<string | null> => {
    // Raw mode only for the length of the answer. Everything else this flow
    // prints — and everything the browser login prints through it — wants the
    // terminal's ordinary line discipline, or a plain "\n" leaves the cursor
    // where it was and the output walks off to the right.
    process.stdin.setRawMode(true);
    process.stdout.write(question);
    const typed: string[] = [];
    return await new Promise<string | null>((resolve) => {
      const onKey = (
        value: string | undefined,
        key: {
          ctrl?: boolean;
          meta?: boolean;
          name?: string;
          sequence?: string;
        },
      ): void => {
        const done = (answer: string | null): void => {
          process.stdin.off("keypress", onKey);
          process.stdin.setRawMode(false);
          process.stdout.write("\n");
          resolve(answer);
        };
        if ((key.ctrl && key.name === "c") || key.name === "escape") {
          done(null);
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          done(typed.join("").trim());
          return;
        }
        if (key.name === "backspace") {
          if (typed.pop() !== undefined) process.stdout.write("\b \b");
          return;
        }
        // Printable single characters only. A control byte or an arrow key's
        // escape sequence must never reach the answer: both would be invisible
        // in the echo and would then be validated as part of a name.
        const character = value ?? key.sequence ?? "";
        if (key.ctrl || key.meta || character.length !== 1) return;
        if (character < " " || character === "\x7f") return;
        typed.push(character);
        process.stdout.write(character);
      };
      process.stdin.on("keypress", onKey);
    });
  };

  /**
   * Which app the account is for, defaulting to the column the cursor is in.
   *
   * Asked rather than taken from the column, even though the column is nearly
   * always the answer. The grid only draws a column for an app that already has
   * an account in it, so a first Codex account has no cell to stand on and the
   * column alone could never reach one — which is most of the point of being
   * able to add from here. Enter takes the default, so the common case is still
   * one keystroke.
   */
  const askProvider = async (
    fallback: "claude" | "codex" | "cursor" | undefined,
  ): Promise<"claude" | "codex" | "cursor" | null> => {
    const preset = fallback ?? "claude";
    for (;;) {
      const answer = await ask(
        `   ${chalk.dim(`app claude/codex/cursor [${preset}]:`)} `,
      );
      if (answer === null) return null;
      if (answer === "") return preset;
      const provider = answer.toLowerCase();
      if (
        provider === "claude" ||
        provider === "codex" ||
        provider === "cursor"
      ) {
        return provider;
      }
      process.stdout.write(
        `   ${chalk.dim(`"${answer}" is not one of them.`)}\n`,
      );
    }
  };

  /** Whether gauge already tracks this name for this app. */
  const alreadyConfigured = (name: string, provider: string): boolean =>
    (snapshot?.views ?? []).some(
      (view) =>
        view.source === "configured" &&
        view.provider === provider &&
        view.name === name,
    );

  /**
   * Give a new Codex account a home of its own, logging in if it has none.
   *
   * The Codex CLI reads whichever `auth.json` sits in `CODEX_HOME`, so a second
   * account is a second directory — and `gauge add codex` will only accept one
   * that already holds a login. Offering gauge's own path as the default is what
   * makes a *new* account possible from here: point the CLI's login at an empty
   * home and the credentials land somewhere gauge can switch back to. Typing an
   * existing home instead imports the login already in it, untouched.
   */
  const prepareCodexHome = async (name: string): Promise<string | null> => {
    const managed = managedCodexHome(getDataDir(), name);
    const typed = await ask(`   ${chalk.dim(`codex home [${managed}]:`)} `);
    if (typed === null) return null;
    const home = typed === "" ? managed : resolveCodexHomeInput(typed);
    if (codexHomeHasLogin(home)) return home;

    createCodexHome(home);
    process.stdout.write(
      `\n   ${chalk.dim(`no login there yet · codex login · CODEX_HOME=${home}`)}\n\n`,
    );
    const login = spawnSync("codex", ["login"], {
      env: { ...process.env, CODEX_HOME: home },
      stdio: "inherit",
    });
    if (login.error) throw login.error;
    if (login.status !== 0) {
      throw new Error(`codex login exited ${login.status}`);
    }
    return home;
  };

  /**
   * Add an account to the app the cursor is in, without leaving the view.
   *
   * The dashboard is where a person discovers they want another account, and
   * sending them back to a shell to type a command it could have run itself is
   * the copying this view exists to remove. The work is `runAddCommand`'s, the
   * same call the CLI makes — the view contributes the questions and nothing
   * about how an account is stored.
   */
  /**
   * The questions, in order, and what they produce.
   *
   * Separated from the handing-back below so that abandoning the flow is a
   * `return` like any other. Every one of these exits used to return from the
   * whole action, which skipped the part that gives the keyboard back — one
   * cancelled add and the grid stopped responding to any key at all.
   */
  const askForNewAccount = async (
    column: "claude" | "codex" | "cursor" | undefined,
  ): Promise<string> => {
    const provider = await askProvider(column);
    if (provider === null) return chalk.dim("cancelled");
    const surface = SURFACE_NAME[provider];
    const name = await ask(`   ${chalk.dim("name:")} `);
    if (name === null || name === "") return chalk.dim("cancelled");
    // Checked before anything is opened or logged in to, because both of the
    // failures below are certain in advance and neither is worth discovering at
    // the end of a browser flow.
    assertSafeName(name);
    if (alreadyConfigured(name, provider)) {
      return `${chalk.red("✗")} ${chalk.dim(`${surface} already has an account called ${name}`)}`;
    }

    let codexHome: string | undefined;
    if (provider === "codex") {
      const home = await prepareCodexHome(name);
      if (home === null) return chalk.dim("cancelled");
      codexHome = home;
    } else {
      process.stdout.write(
        `\n   ${chalk.dim(`opening a browser to log in to ${surface}`)}\n`,
      );
    }

    const result = await runAddCommand(name, { codexHome, provider });
    const summary = result.human?.trim();
    return `${chalk.green("✓")} ${chalk.dim(summary || `${surface} account ${name} added`)}`;
  };

  const addAccount = async (
    column: "claude" | "codex" | "cursor" | undefined,
  ): Promise<void> => {
    prompting = true;
    process.stdin.setRawMode(false);
    previousLineCount = 0;
    process.stdout.write(
      `\n   ${chalk.cyan("+")} ${chalk.bold("add an account")}\n\n`,
    );
    let outcome: string;
    try {
      outcome = await askForNewAccount(column);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = `${chalk.red("✗")} ${chalk.dim(message)}`;
    }
    // Back to the grid's own regime, which is what the wait below reads and what
    // the key handler expects to find when this returns.
    process.stdin.setRawMode(true);
    process.stdout.write(
      `\n   ${outcome}\n\n   ${chalk.dim("any key to continue")}`,
    );
    await new Promise<void>((resolve) =>
      process.stdin.once("keypress", () => resolve()),
    );
    prompting = false;
    previousLineCount = 0;
    await reload();
  };

  const signInAs = async (
    name: string,
    provider: "claude" | "codex" | "cursor",
  ): Promise<void> => {
    const surface = provider === "codex" ? "Codex" : "Claude Code";
    const stored = targets.some(
      (target) => target.name === name && target.provider === provider,
    );
    process.stdin.setRawMode(false);
    previousLineCount = 0;
    process.stdout.write("\n");
    try {
      if (!stored) {
        // Nothing to restore yet, so run the tool's own login and keep whatever
        // it produces. Codex can be aimed at this account because gauge owns its
        // home; Claude Code signs in wherever the browser is taken, and is
        // captured afterwards under whichever account that turns out to be.
        await runLogin(name, provider);
      } else if (provider === "codex") {
        switchCodexLogin(name, getDataDir());
      } else if (provider === "claude") {
        switchClaudeSession(name, getDataDir());
      }
      process.stdout.write(
        `   ${chalk.green("✓")} ${chalk.dim(stored ? `${surface} signed in as ${name}` : `${surface} login finished`)}\n`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(
        `   ${chalk.red("✗")} ${chalk.dim(`${surface}: ${message}`)}\n`,
      );
    }
    process.stdin.setRawMode(true);
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
        // Checked before the quit keys, not after: while a prompt is open these
        // keystrokes are letters in an answer, and the prompt has its own ctrl-C.
        if (prompting) return;
        if ((key.ctrl && key.name === "c") || key.name === "q") {
          resolve();
          return;
        }
        if (processing) return;
        // Direct manipulation: the cursor moves over the accounts already on
        // screen and Enter acts on the one under it, so there is no mode to be
        // in and no key to remember for a thing that is being looked at.
        // Movement repaints from the last reading. Only `r`, and an action that
        // changed something, ask a provider again.
        const move = (next: () => void): void => {
          next();
          draw();
        };
        if (key.name === "up" || key.name === "k") {
          move(() => {
            row = Math.max(0, row - 1);
          });
          return;
        }
        if (key.name === "down" || key.name === "j") {
          move(() => {
            row = Math.min(Math.max(0, rowLabels.length - 1), row + 1);
          });
          return;
        }
        if (key.name === "left" || key.name === "h") {
          move(() => {
            column = Math.max(0, column - 1);
          });
          return;
        }
        if (key.name === "right" || key.name === "l") {
          move(() => {
            column = Math.min(Math.max(0, columns.length - 1), column + 1);
          });
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          const name = rowLabels[row];
          const provider = columns[column];
          if (!name || !provider) return;
          // Cursor is the only cell Enter does nothing on; everywhere else it
          // either switches to a stored session or starts a login.
          if (provider === "cursor") return;
          processing = true;
          signInAs(name, provider)
            .catch(reject)
            .finally(() => {
              processing = false;
            });
          return;
        }
        if (key.name === "a") {
          processing = true;
          addAccount(columns[column])
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
