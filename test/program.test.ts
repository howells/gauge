import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_SPECS } from "../src/commands/specs.js";
import { type CommandHandlers, createProgram } from "../src/program.js";

function handlers(): CommandHandlers {
  return Object.fromEntries(
    COMMAND_SPECS.map((spec) => [spec.name, () => undefined]),
  ) as CommandHandlers;
}

test("createProgram registers every command and option from metadata", () => {
  const program = createProgram({ handlers: handlers(), version: "test" });
  const commands = new Map(
    program.commands.map((command) => [command.name(), command]),
  );

  assert.deepEqual(
    [...commands.keys()],
    COMMAND_SPECS.map((spec) => spec.name),
  );
  for (const spec of COMMAND_SPECS) {
    const command = commands.get(spec.name);
    assert.ok(command, `missing ${spec.name}`);
    assert.deepEqual(command.aliases(), spec.aliases);
    assert.deepEqual(
      command.options.map((option) => option.long),
      spec.options.map((option) => option.long),
    );
  }
});

test("root command exposes the status root-alias options", () => {
  const program = createProgram({ handlers: handlers(), version: "test" });
  const status = COMMAND_SPECS.find((spec) => spec.name === "status");
  assert.ok(status);
  assert.deepEqual(
    program.options
      .map((option) => option.long)
      .filter((option) => option !== "--version"),
    status.options.map((option) => option.long),
  );
});
