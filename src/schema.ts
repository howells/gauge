import { COMMAND_SPECS, type CommandSpec } from "./commands/specs.js";
import { COMMAND_WIRE_JSON_SCHEMAS } from "./commands/wire-schemas.js";

/** Return metadata-derived schemas for all (or a specific) CLI command. */
export function describeCommands(
  commandName?: string,
): Record<string, unknown> {
  const commands = COMMAND_SPECS.filter((spec) =>
    matchesCommand(spec, commandName),
  ).map((spec) => ({
    command: spec.name,
    aliases: spec.aliases,
    root_alias: spec.rootAlias,
    kind: hasWriteEffect(spec) ? "mutating" : "read",
    summary: spec.summary,
    examples: spec.examples,
    arguments: spec.arguments,
    options: spec.options,
    side_effects: spec.sideEffects,
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
    safety: {
      dry_run: spec.safety.dryRun,
      sanitizes_remote_strings: spec.safety.sanitizesRemoteStrings,
    },
  }));

  return {
    generated_at: new Date().toISOString(),
    security_posture:
      "The agent is not a trusted operator. Use --dry-run for mutating commands, use --fields on reads, and keep output paths inside the current working directory.",
    runtime: {
      non_tty_default_format: "json",
      headless_auth: true,
      minimum_node_major: 20,
      supported_surfaces: ["binary", "json", "ndjson"],
    },
    global_options: COMMAND_SPECS.find((spec) => spec.rootAlias)?.options ?? [],
    commands,
  };
}

function matchesCommand(
  spec: CommandSpec,
  commandName: string | undefined,
): boolean {
  return (
    !commandName ||
    spec.name === commandName ||
    spec.aliases.some((alias) => alias === commandName)
  );
}

function hasWriteEffect(spec: CommandSpec): boolean {
  return spec.sideEffects.some((effect) => effect === "writes_local_state");
}
