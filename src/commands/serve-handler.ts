import chalk from "chalk";

import { runStatusCommand } from "../commands.js";
import type { CommandResult } from "../output.js";
import { CLIError } from "../security.js";
import { createServeServer } from "../serve/server.js";
import { StatusSnapshotCache } from "../serve/snapshot.js";

export interface ServeCommandOptions {
  noCredentialRefresh?: boolean;
  port?: number;
}

/**
 * Serve the local dashboard.
 *
 * Resolves with the startup result once the socket is listening; the open
 * server handle keeps the process alive afterwards. Collection reuses the
 * status pipeline untouched, cached between polls so the browser never drives
 * provider traffic directly.
 */
export async function runServeCommand(
  options: ServeCommandOptions
): Promise<CommandResult> {
  const cache = new StatusSnapshotCache({
    fetch: async () =>
      await runStatusCommand({
        noCredentialRefresh: options.noCredentialRefresh,
        pageAll: true,
        quiet: true,
      }),
  });
  const server = createServeServer({ cache, port: options.port });
  let address: { port: number; url: string };
  try {
    address = await server.listen();
  } catch (error) {
    const message =
      error instanceof Error && "code" in error && error.code === "EADDRINUSE"
        ? `Port ${options.port} is already in use.`
        : error instanceof Error
          ? error.message
          : "The server could not start.";
    throw new CLIError(message, {
      code: "SERVE_LISTEN_FAILED",
      exitCode: 1,
      trustedMessage: true,
    });
  }

  const human = [
    "",
    `  ${chalk.bold("Gauge dashboard")}  ${chalk.dim(address.url)}`,
    chalk.dim(
      `  Collecting on demand; the page refreshes itself every 30 seconds.`
    ),
    chalk.dim("  Press Ctrl+C to stop."),
    "",
  ].join("\n");

  const shutdown = (): void => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(0)
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return {
    command: "serve",
    data: { refreshIntervalSeconds: 30, url: address.url },
    human,
  };
}
