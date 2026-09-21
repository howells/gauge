import chalk from "chalk";

import { runStatusCommand } from "../commands.js";
import type { CommandResult } from "../output.js";
import { CLIError } from "../security.js";
import { createServeServer, DEFAULT_SERVE_PORT } from "../serve/server.js";
import { StatusSnapshotCache } from "../serve/snapshot.js";

export interface ServeCommandOptions {
  noCredentialRefresh?: boolean;
  port?: number;
}

// A gauge dashboard answers with this page; anything else on the port is
// some other process minding its own business.
const GAUGE_MARKER = "<title>Gauge</title>";

const isGaugeDashboard = async (port: number): Promise<boolean> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.text();
    return body.includes(GAUGE_MARKER);
  } catch {
    return false;
  }
};

/**
 * Serve the local dashboard.
 *
 * Resolves with the startup result once the socket is listening; the open
 * server handle keeps the process alive afterwards. Collection reuses the
 * status pipeline untouched, cached between polls so the browser never drives
 * provider traffic directly. When a gauge dashboard already holds the port,
 * the command points at it instead of failing.
 */
export async function runServeCommand(
  options: ServeCommandOptions
): Promise<CommandResult> {
  const port = options.port ?? DEFAULT_SERVE_PORT;
  const cache = new StatusSnapshotCache({
    fetch: async () =>
      await runStatusCommand({
        noCredentialRefresh: options.noCredentialRefresh,
        pageAll: true,
        quiet: true,
      }),
  });
  const server = createServeServer({ cache, port });
  let address: { port: number; url: string };
  try {
    address = await server.listen();
  } catch (error) {
    const inUse =
      error instanceof Error && "code" in error && error.code === "EADDRINUSE";
    if (!inUse) {
      const message =
        error instanceof Error ? error.message : "The server could not start.";
      throw new CLIError(message, {
        code: "SERVE_LISTEN_FAILED",
        exitCode: 1,
        trustedMessage: true,
      });
    }
    if (await isGaugeDashboard(port)) {
      const url = `http://127.0.0.1:${port}`;
      return {
        command: "serve",
        data: { alreadyRunning: true, refreshIntervalSeconds: 30, url },
        human: [
          "",
          `  ${chalk.bold("Gauge dashboard")} is already running at ${chalk.dim(url)}`,
          chalk.dim(
            "  Opening it again is safe; the existing tab keeps its state."
          ),
          "",
        ].join("\n"),
      };
    }
    throw new CLIError(
      `Port ${port} is already in use. Pick another with gauge serve --port <port>.`,
      {
        code: "SERVE_LISTEN_FAILED",
        exitCode: 1,
        trustedMessage: true,
      }
    );
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
