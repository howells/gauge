import {
  Command,
  InvalidArgumentError,
  Option,
  type OptionValues,
} from "commander";
import {
  COMMAND_SPECS,
  type CommandSpec,
  type OptionSpec,
} from "./commands/specs.js";
import type { CommandName } from "./commands/wire-schemas.js";

interface CommandInvocation {
  arguments: Record<string, string | undefined>;
  options: OptionValues;
}

type CommandHandler = (invocation: CommandInvocation) => Promise<void> | void;
export type CommandHandlers = Record<CommandName, CommandHandler>;

interface ProgramOptions {
  handlers: CommandHandlers;
  version: string;
}

/** Build the public Commander surface from metadata without running handlers. */
export function createProgram(options: ProgramOptions): Command {
  const program = new Command()
    .name("gauge")
    .description(
      "At-a-glance usage dashboard for Claude, Codex, and Cursor accounts",
    )
    .version(options.version)
    .showHelpAfterError(false)
    .exitOverride();

  const rootSpec = COMMAND_SPECS.find((spec) => spec.rootAlias);
  if (rootSpec) {
    addOptions(program, rootSpec.options);
    program.action((...args: unknown[]) =>
      options.handlers[rootSpec.name](invocation(rootSpec, args)),
    );
  }

  for (const spec of COMMAND_SPECS) {
    const command = program
      .command(commandSyntax(spec))
      .description(spec.summary);
    for (const alias of spec.aliases) command.alias(alias);
    addOptions(command, spec.options);
    command.action((...args: unknown[]) =>
      options.handlers[spec.name](invocation(spec, args)),
    );
  }

  return program;
}

function commandSyntax(spec: CommandSpec): string {
  const argumentsSyntax = spec.arguments.map((argument) => {
    const value = argument.variadic ? `${argument.name}...` : argument.name;
    return argument.required ? `<${value}>` : `[${value}]`;
  });
  return [spec.name, ...argumentsSyntax].join(" ");
}

function addOptions(command: Command, specs: readonly OptionSpec[]): void {
  for (const spec of specs) {
    const value =
      spec.type === "boolean" ? "" : ` <${spec.valueName ?? "value"}>`;
    const flags = `${spec.short ? `${spec.short}, ` : ""}${spec.long}${value}`;
    const option = new Option(flags, spec.description);
    if (spec.choices) option.choices([...spec.choices]);
    if (spec.type === "integer") option.argParser(parsePositiveInteger);
    command.addOption(option);
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(
      `Expected a positive integer, received "${value}".`,
    );
  }
  return parsed;
}

function invocation(
  spec: CommandSpec,
  actionArguments: unknown[],
): CommandInvocation {
  const command = actionArguments.at(-1);
  const positional = actionArguments.slice(0, spec.arguments.length);
  return {
    arguments: Object.fromEntries(
      spec.arguments.map((argument, index) => [
        argument.name,
        typeof positional[index] === "string" ? positional[index] : undefined,
      ]),
    ),
    options: command instanceof Command ? command.optsWithGlobals() : {},
  };
}
