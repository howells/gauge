import { migrateLegacyAccounts, planLegacyMigration } from "../migrate.js";
import type { CommandResult } from "../output.js";

export function runMigrateCommand(
  dataRoot: string,
  dryRun: boolean,
): CommandResult {
  if (dryRun) {
    const plan = planLegacyMigration(dataRoot);
    return {
      command: "migrate",
      data: { action: "migrate", accounts: plan.accounts },
      dryRun: true,
      human: `Dry run: would migrate ${plan.accounts.length} account(s).\n`,
    };
  }
  const result = migrateLegacyAccounts(dataRoot);
  return {
    command: "migrate",
    data: { action: "migrate", migrated: result.migrated },
    human: `Migrated ${result.migrated} account(s).\n`,
  };
}
