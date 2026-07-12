#!/usr/bin/env node

import { createRequire } from "node:module";
import process from "node:process";
import { CommanderError } from "commander";
import { runDoctorCommand } from "./commands/doctor-handler.js";
import { runMigrateCommand } from "./commands/migrate-handler.js";
import { COMMAND_SPECS } from "./commands/specs.js";
import {
  runAddCommand,
  runDescribeCommand,
  runListCommand,
  runRefreshCommand,
  runRemoveCommand,
  runStatusCommand,
} from "./commands.js";
import type { Provider } from "./domain/account.js";
import {
  type CommandResult,
  type OutputOptions,
  renderCommandResult,
  renderError,
  resolveOutputFormat,
} from "./output.js";
import { getDataDir } from "./paths.js";
import { type CommandHandlers, createProgram } from "./program.js";
import { CLIError, redactDiagnosticValue } from "./security.js";
import { assertStateCommandAllowed } from "./services/state-preflight.js";
import { runTUI } from "./tui.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };

const rawArgv = process.argv.slice(2);
const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
const parseArgv = [
  process.argv[0] ?? "node",
  process.argv[1] ?? "gauge",
  ...argv,
];
const requestedFormat = detectRequestedFormat(argv);
const isTTY = process.stdout.isTTY ?? false;
const resolvedFormat =
  requestedFormat !== undefined || isMetaOutputRequest(argv)
    ? resolveOutputFormat(requestedFormat ?? "human", true)
    : resolveOutputFormat(requestedFormat, isTTY);

const handlers: CommandHandlers = {
  status: async ({ options }) => {
    assertStateCommandAllowed("status", getDataDir());
    if (isTTY && !requestedFormat && !options.quick) {
      await runTUI();
      return;
    }
    await emitResult(
      await runStatusCommand({
        ...options,
        quiet:
          resolveOutputFormat(
            typeof options.format === "string"
              ? options.format
              : requestedFormat,
            isTTY,
          ) !== "human",
      }),
      options,
    );
  },
  list: ({ options }) => {
    assertStateCommandAllowed("list", getDataDir());
    emitResult(runListCommand(), options);
  },
  describe: ({ arguments: positional, options }) => {
    emitResult(runDescribeCommand(positional.command), options);
  },
  add: async ({ arguments: positional, options }) => {
    assertStateCommandAllowed("add", getDataDir());
    const target = resolveAccountTarget(
      positional.providerOrName,
      positional.name,
      options.provider,
    );
    await emitResult(
      await runAddCommand(target.name, {
        ...options,
        provider: target.provider,
        quiet:
          resolveOutputFormat(
            typeof options.format === "string"
              ? options.format
              : requestedFormat,
            isTTY,
          ) !== "human",
      }),
      options,
    );
  },
  refresh: async ({ arguments: positional, options }) => {
    assertStateCommandAllowed("refresh", getDataDir());
    const target = resolveAccountTarget(
      positional.providerOrName,
      positional.name,
      options.provider,
    );
    await emitResult(
      await runRefreshCommand(target.name, {
        ...options,
        provider: target.provider,
        quiet:
          resolveOutputFormat(
            typeof options.format === "string"
              ? options.format
              : requestedFormat,
            isTTY,
          ) !== "human",
      }),
      options,
    );
  },
  remove: ({ arguments: positional, options }) => {
    assertStateCommandAllowed("remove", getDataDir());
    const target = resolveAccountTarget(
      positional.providerOrName,
      positional.name,
      options.provider,
    );
    emitResult(
      runRemoveCommand(target.name, {
        ...options,
        provider: target.provider,
      }),
      options,
    );
  },
  doctor: ({ options }) => {
    const outcome = runDoctorCommand(getDataDir());
    emitResult(outcome.result, options);
    process.exitCode = outcome.exitCode;
  },
  migrate: ({ options }) => {
    emitResult(
      runMigrateCommand(getDataDir(), options.dryRun === true),
      options,
    );
  },
};

const program = createProgram({
  handlers,
  version: packageJson.version ?? "0.0.0",
});
program.configureOutput({
  writeErr: (str) => {
    if (resolvedFormat === "human") {
      process.stderr.write(str);
    }
  },
  writeOut: (str) => {
    if (resolvedFormat === "human") {
      process.stdout.write(str);
    }
  },
  outputError: (str, write) => {
    if (resolvedFormat === "human") {
      write(str);
    }
  },
});

try {
  await program.parseAsync(parseArgv);
} catch (error) {
  if (error instanceof CommanderError && isBenignCommanderExit(error)) {
    process.exitCode = error.exitCode;
  } else {
    const normalized = normalizeError(error);
    const redactionContext = {
      cwd: process.cwd(),
      home: process.env.HOME,
    };
    const rendered = renderError(
      {
        code: normalized.code,
        details: redactDiagnosticValue(normalized.details, redactionContext),
        message: normalized.trustedMessage
          ? normalized.message
          : String(redactDiagnosticValue(normalized.message, redactionContext)),
      },
      {
        format: requestedFormat,
        outputFile: peekFlagValue(argv, "--output-file"),
        sanitize: !argv.includes("--no-sanitize"),
        debug: argv.includes("--debug"),
      },
      {
        command: detectCommandName(argv),
        cwd: process.cwd(),
        isTTY,
      },
    );

    emitRendered(rendered.content, rendered.outputPath);
    process.exitCode = normalized.exitCode;
  }
}

function emitResult(result: CommandResult, options: OutputOptions): void {
  const rendered = renderCommandResult(
    result,
    normalizeOutputOptions(options),
    {
      cwd: process.cwd(),
      isTTY,
    },
  );
  emitRendered(rendered.content, rendered.outputPath);
  if (result.exitCode !== undefined) {
    process.exitCode = result.exitCode;
  }
}

function emitRendered(content: string, outputPath?: string): void {
  if (!outputPath) {
    process.stdout.write(content);
    return;
  }

  if (resolvedFormat === "human") {
    process.stdout.write(`Wrote output to ${outputPath}\n`);
    return;
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, output_path: outputPath })}\n`,
  );
}

function detectRequestedFormat(args: string[]): string | undefined {
  return peekFlagValue(args, "--format");
}

function isMetaOutputRequest(args: string[]): boolean {
  return (
    args.includes("--help") ||
    args.includes("-h") ||
    args.includes("--version") ||
    args.includes("-V")
  );
}

function detectCommandName(args: string[]): string {
  return (
    COMMAND_SPECS.find(
      (spec) =>
        args.includes(spec.name) ||
        spec.aliases.some((alias) => args.includes(alias)),
    )?.name ?? "status"
  );
}

function peekFlagValue(args: string[], flag: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      return args[index + 1];
    }
    if (args[index]?.startsWith(`${flag}=`)) {
      return args[index]?.slice(flag.length + 1);
    }
  }
  return undefined;
}

function resolveAccountTarget(
  first: string | undefined,
  second: string | undefined,
  providerOption: unknown,
): { name: string | undefined; provider?: Provider } {
  if (typeof providerOption === "string") {
    return {
      name: second ?? first,
      provider: providerOption as Provider,
    };
  }

  if (second && isProvider(first)) {
    return {
      name: second,
      provider: first,
    };
  }

  // A lone provider keyword ("gauge add cursor") means "add a <provider>
  // account" with the name still missing — carry that intent through so the
  // command can guide, instead of treating "cursor"/"codex" as a Claude
  // account name and silently opening a Claude browser login.
  if (second === undefined && isProvider(first)) {
    return { name: undefined, provider: first };
  }

  return { name: first };
}

function isProvider(value: string | undefined): value is Provider {
  return value === "claude" || value === "codex" || value === "cursor";
}

function normalizeOutputOptions(options: OutputOptions): OutputOptions {
  return {
    ...options,
    fields: options.fields ?? peekFlagValue(argv, "--fields"),
    format: options.format ?? requestedFormat,
    outputFile: options.outputFile ?? peekFlagValue(argv, "--output-file"),
    page: options.page ?? parseOptionalInteger(peekFlagValue(argv, "--page")),
    pageAll: options.pageAll ?? argv.includes("--page-all"),
    pageSize:
      options.pageSize ??
      parseOptionalInteger(peekFlagValue(argv, "--page-size")),
    sanitize: argv.includes("--no-sanitize")
      ? false
      : (options.sanitize ?? true),
  };
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  return Number.parseInt(value, 10);
}

function normalizeError(error: unknown): {
  code: string;
  details?: unknown;
  exitCode: number;
  message: string;
  trustedMessage?: boolean;
} {
  if (error instanceof CLIError) {
    return {
      code: error.code,
      details: error.details,
      exitCode: error.exitCode,
      message: error.message,
      trustedMessage: error.trustedMessage,
    };
  }

  if (error instanceof CommanderError) {
    return {
      code: error.code,
      exitCode: error.exitCode,
      message: error.message,
    };
  }

  if (error instanceof Error) {
    return {
      code: "CLI_ERROR",
      details: argv.includes("--debug")
        ? redactDiagnosticValue(error.stack, {
            cwd: process.cwd(),
            home: process.env.HOME,
          })
        : undefined,
      exitCode: 1,
      message: error.message,
    };
  }

  return {
    code: "CLI_ERROR",
    details: error,
    exitCode: 1,
    message: String(error),
  };
}

function isBenignCommanderExit(error: CommanderError): boolean {
  return (
    error.code === "commander.help" ||
    error.code === "commander.helpDisplayed" ||
    error.code === "commander.version"
  );
}
