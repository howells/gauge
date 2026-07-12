import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  COMMAND_SPECS,
  COMMAND_SPECS_BY_NAME,
  renderCommandExamplesMarkdown,
} from "../src/commands/specs.js";
import {
  AddWireSchema,
  COMMAND_WIRE_JSON_SCHEMAS,
  RefreshWireSchema,
} from "../src/commands/wire-schemas.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("registry contains every v3 command with unique names and aliases", () => {
  assert.deepEqual(
    COMMAND_SPECS.map((spec) => spec.name),
    [
      "status",
      "list",
      "describe",
      "add",
      "refresh",
      "remove",
      "doctor",
      "migrate",
    ],
  );

  const identifiers = COMMAND_SPECS.flatMap((spec) => [
    spec.name,
    ...spec.aliases,
  ]);
  assert.equal(new Set(identifiers).size, identifiers.length);
  assert.deepEqual(
    COMMAND_SPECS.filter((spec) => spec.rootAlias).map((spec) => spec.name),
    ["status"],
  );
  assert.equal(COMMAND_SPECS_BY_NAME.status.name, "status");
  assert.ok(
    COMMAND_SPECS_BY_NAME.status.sideEffects.includes("writes_credentials"),
  );
});

test("wire schemas reject unknown properties and invalid types", () => {
  const unknownProperty = AddWireSchema.safeParse({
    name: "work",
    unexpected: true,
  });
  assert.equal(unknownProperty.success, false);
  if (!unknownProperty.success) {
    assert.equal(unknownProperty.error.issues[0]?.code, "unrecognized_keys");
  }

  const invalidType = AddWireSchema.safeParse({ name: 42 });
  assert.equal(invalidType.success, false);
  if (!invalidType.success) {
    assert.equal(invalidType.error.issues[0]?.code, "invalid_type");
    assert.deepEqual(invalidType.error.issues[0]?.path, ["name"]);
  }
});

test("add and refresh accept string and object storage-state JSON", () => {
  const storageState = {
    cookies: [
      {
        domain: ".cursor.com",
        expires: -1,
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "Lax" as const,
        secure: true,
        value: "secret",
      },
    ],
    origins: [
      {
        localStorage: [{ name: "theme", value: "dark" }],
        origin: "https://cursor.com",
      },
    ],
  };

  assert.equal(
    AddWireSchema.safeParse({
      name: "work",
      storage_state_json: JSON.stringify(storageState),
    }).success,
    true,
  );
  assert.equal(
    AddWireSchema.safeParse({ name: "work", storage_state_json: storageState })
      .success,
    true,
  );
  assert.equal(
    RefreshWireSchema.safeParse({
      name: "work",
      storage_state_json: storageState,
    }).success,
    true,
  );
});

test("every command spec is complete metadata with examples", () => {
  for (const spec of COMMAND_SPECS) {
    assert.ok(spec.summary.length > 0, `${spec.name} needs a summary`);
    assert.ok(spec.examples.length > 0, `${spec.name} needs examples`);
    assert.ok(spec.examples.every((example) => example.startsWith("gauge ")));
    for (const example of spec.examples) validateExample(spec, example);
    assert.equal(typeof spec.output.paginated, "boolean");
    assert.equal(typeof spec.output.supportsFields, "boolean");
    assert.equal(typeof spec.output.supportsNdjson, "boolean");
    assert.equal(typeof spec.safety.dryRun, "boolean");
    assert.equal(typeof spec.safety.sanitizesRemoteStrings, "boolean");
    assert.ok(Array.isArray(spec.sideEffects));
    assert.ok(spec.wireSchema instanceof z.ZodType);
    if (spec.safety.dryRun) {
      const realRuns = new Set(
        spec.examples.filter((example) => !example.includes(" --dry-run")),
      );
      for (const example of spec.examples.filter((candidate) =>
        candidate.includes(" --dry-run"),
      )) {
        assert.ok(
          realRuns.has(example.replace(" --dry-run", "")),
          `${spec.name} dry-run example needs an exact real pair: ${example}`,
        );
      }
    }
  }
});

test("generated command example reference exactly matches canonical specs", () => {
  assert.equal(
    fs.readFileSync(path.join(root, "docs", "command-examples.md"), "utf8"),
    renderCommandExamplesMarkdown(),
  );
});

test("canonical command examples are published in README, AGENTS, or bundled skills", () => {
  const documentation = [
    "README.md",
    "AGENTS.md",
    "skills/README.md",
    "skills/headless-auth/SKILL.md",
    "skills/mutations/SKILL.md",
    "skills/status/SKILL.md",
  ]
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");

  for (const spec of COMMAND_SPECS) {
    for (const example of spec.examples) {
      assert.ok(
        documentation.includes(example),
        `Canonical ${spec.name} example is missing from docs: ${example}`,
      );
    }
  }
});

test("wire schemas export JSON Schema for discovery", () => {
  assert.deepEqual(Object.keys(COMMAND_WIRE_JSON_SCHEMAS), [
    "status",
    "list",
    "describe",
    "add",
    "refresh",
    "remove",
    "doctor",
    "migrate",
  ]);
  const addSchema = COMMAND_WIRE_JSON_SCHEMAS.add as {
    additionalProperties?: boolean;
    properties?: Record<string, unknown>;
    required?: string[];
    type?: string;
  };
  assert.equal(addSchema.type, "object");
  assert.equal(addSchema.additionalProperties, false);
  assert.deepEqual(addSchema.required, ["name"]);
  assert.ok(addSchema.properties?.storage_state_json);
});

test("metadata module imports without operational initialization", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-spec-import-"));
  const home = path.join(fixture, "home");
  fs.mkdirSync(home);
  const tsxImport = path.join(
    root,
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );
  const specsPath = path.join(root, "src", "commands", "specs.ts");
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      tsxImport,
      "--eval",
      `await import(${JSON.stringify(specsPath)})`,
    ],
    {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    },
  );

  try {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(fs.existsSync(path.join(home, ".gauge")), false);
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
});

function validateExample(
  spec: (typeof COMMAND_SPECS)[number],
  example: string,
): void {
  const tokens = tokenizeShell(example);
  assert.equal(tokens.shift(), "gauge");
  if (tokens[0] === spec.name || spec.aliases.includes(tokens[0] ?? "")) {
    tokens.shift();
  } else {
    assert.equal(spec.rootAlias, true, `${example} omits a non-root command`);
  }

  const options = new Map(
    spec.options.flatMap((option) => [
      [option.long, option] as const,
      ...(option.short ? ([[option.short, option]] as const) : []),
    ]),
  );
  let positionalCount = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    assert.ok(token);
    if (!token.startsWith("-")) {
      positionalCount += 1;
      continue;
    }
    const option = options.get(token);
    assert.ok(option, `${example} uses undeclared option ${token}`);
    if (option.type !== "boolean") {
      const value = tokens[++index];
      assert.ok(value && !value.startsWith("-"), `${token} needs a value`);
      if (option.type === "integer") {
        assert.match(value, /^\d+$/, `${token} needs an integer`);
      }
      if (option.choices) {
        assert.ok(
          option.choices.includes(value),
          `${token} has invalid ${value}`,
        );
      }
    }
  }
  const variadic = spec.arguments.some((argument) => argument.variadic);
  assert.ok(
    variadic || positionalCount <= spec.arguments.length,
    `${example} has too many positional arguments`,
  );
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  const expression = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|[^\s]+/g;
  for (const match of command.matchAll(expression)) {
    tokens.push(match[1] ?? match[2] ?? match[0]);
  }
  return tokens;
}
