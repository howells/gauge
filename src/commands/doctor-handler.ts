import { findChrome } from "../chrome.js";
import type { CommandResult } from "../output.js";
import { runDoctorChecks } from "../services/doctor.js";

export function runDoctorCommand(dataRoot: string): {
  exitCode: number;
  result: CommandResult;
} {
  const report = runDoctorChecks({
    chromePath: findChrome(),
    dataRoot,
    env: process.env,
    nodeVersion: process.versions.node,
  });
  const human = [
    "",
    "Gauge doctor",
    ...report.checks.map(
      (check) => `  ${check.status.toUpperCase()}  ${check.message}`,
    ),
    "",
  ].join("\n");
  return {
    exitCode: report.failed > 0 ? 1 : 0,
    result: { command: "doctor", data: report, human },
  };
}
