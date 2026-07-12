import { inspectLegacyState } from "../migrate.js";
import { CLIError } from "../security.js";

const MIGRATION_COMMANDS = new Set<string>(["describe", "doctor", "migrate"]);

/** Refuse account-dependent commands until legacy state is explicitly migrated. */
export function assertStateCommandAllowed(
  command: string,
  dataRoot: string,
): void {
  if (MIGRATION_COMMANDS.has(command)) {
    return;
  }
  const state = inspectLegacyState(dataRoot);
  if (!state.legacy && !state.journal) {
    return;
  }
  throw new CLIError(
    "Gauge account state must be migrated before this command can run.",
    {
      code: "MIGRATION_REQUIRED",
      exitCode: 2,
      details: {
        next_steps: [
          "gauge migrate --dry-run --format json",
          "gauge migrate --format json",
        ],
      },
    },
  );
}
