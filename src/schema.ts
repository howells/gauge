import { COMMAND_SPECS } from "./commands/specs.js";
import type { CommandSpec } from "./commands/specs.js";
import { COMMAND_WIRE_JSON_SCHEMAS } from "./commands/wire-schemas.js";

const matchesCommand = (
  spec: CommandSpec,
  commandName: string | undefined
): boolean =>
  !commandName ||
  spec.name === commandName ||
  spec.aliases.some((alias) => alias === commandName);

const hasWriteEffect = (spec: CommandSpec): boolean =>
  spec.sideEffects.some((effect) => effect === "writes_local_state");

export const describeCommands = (
  commandName?: string
): Record<string, unknown> => {
  const commands = COMMAND_SPECS.filter((spec) =>
    matchesCommand(spec, commandName)
  ).map((spec) => ({
    aliases: spec.aliases,
    arguments: spec.arguments,
    command: spec.name,
    examples: spec.examples,
    kind: hasWriteEffect(spec) ? "mutating" : "read",
    options: spec.options,
    raw_payload: {
      accepts_json_option: spec.options.some((option) => option.key === "json"),
      accepts_stdin: spec.options.some((option) => option.key === "inputFile"),
      schema: COMMAND_WIRE_JSON_SCHEMAS[spec.name],
    },
    response: {
      paginated: spec.output.paginated,
      supports_fields: spec.output.supportsFields,
      supports_ndjson: spec.output.supportsNdjson,
    },
    root_alias: spec.rootAlias,
    safety: {
      dry_run: spec.safety.dryRun,
      sanitizes_remote_strings: spec.safety.sanitizesRemoteStrings,
    },
    side_effects: spec.sideEffects,
    summary: spec.summary,
  }));

  return {
    commands,
    generated_at: new Date().toISOString(),
    global_options: COMMAND_SPECS.find((spec) => spec.rootAlias)?.options ?? [],
    runtime: {
      headless_auth: true,
      minimum_node_major: 20,
      non_tty_default_format: "json",
      supported_surfaces: ["binary", "json", "ndjson"],
    },
    security_posture:
      "The agent is not a trusted operator. Use --dry-run for mutating commands, use --fields on reads, and keep output paths inside the current working directory.",
  };
};
