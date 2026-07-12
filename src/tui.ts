import process from "node:process";
import readline from "node:readline";
import chalk from "chalk";
import { runStatusCommand } from "./commands.js";

/** Present the shared status service as a small keyboard-controlled terminal view. */
export async function runTUI(): Promise<void> {
  let previousLineCount = 0;
  let processing = false;

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
    writeView(`${result.human}\n${chalk.dim("   r refresh  ·  q quit")}\n`);
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
        if (key.name !== "r" || processing) return;
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
