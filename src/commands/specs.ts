import type { z } from "zod";
import { COMMAND_WIRE_SCHEMAS, type CommandName } from "./wire-schemas.js";

type CommandSideEffect =
  | "browser"
  | "network"
  | "reads_local_state"
  | "writes_credentials"
  | "writes_local_state";

interface PositionalArgumentSpec {
  description: string;
  name: string;
  required: boolean;
  variadic?: boolean;
}

export interface OptionSpec {
  choices?: readonly string[];
  description: string;
  key: string;
  long: string;
  short?: string;
  type: "boolean" | "integer" | "string";
  valueName?: string;
}

export interface CommandSpec {
  aliases: readonly string[];
  arguments: readonly PositionalArgumentSpec[];
  examples: readonly string[];
  name: CommandName;
  options: readonly OptionSpec[];
  output: {
    paginated: boolean;
    supportsFields: boolean;
    supportsNdjson: boolean;
  };
  rootAlias: boolean;
  safety: {
    dryRun: boolean;
    sanitizesRemoteStrings: boolean;
  };
  sideEffects: readonly CommandSideEffect[];
  summary: string;
  wireSchema: z.ZodType;
}

const FORMAT_OPTION: OptionSpec = {
  choices: ["human", "json", "ndjson"],
  description: "Output format.",
  key: "format",
  long: "--format",
  type: "string",
  valueName: "format",
};
const FIELDS_OPTION: OptionSpec = {
  description: "Comma-separated field mask for structured output.",
  key: "fields",
  long: "--fields",
  type: "string",
  valueName: "mask",
};
const OUTPUT_FILE_OPTION: OptionSpec = {
  description: "Write output to a path inside the current working directory.",
  key: "outputFile",
  long: "--output-file",
  type: "string",
  valueName: "path",
};
const SANITIZE_OPTION: OptionSpec = {
  description: "Disable response sanitization in structured output.",
  key: "sanitize",
  long: "--no-sanitize",
  type: "boolean",
};
const DEBUG_OPTION: OptionSpec = {
  description: "Include redacted diagnostics for trusted troubleshooting.",
  key: "debug",
  long: "--debug",
  type: "boolean",
};
const PAGE_OPTIONS: readonly OptionSpec[] = [
  {
    description: "Return a single page of results.",
    key: "page",
    long: "--page",
    type: "integer",
    valueName: "number",
  },
  {
    description: "Set the structured result page size.",
    key: "pageSize",
    long: "--page-size",
    type: "integer",
    valueName: "number",
  },
  {
    description: "Emit every page of structured results.",
    key: "pageAll",
    long: "--page-all",
    type: "boolean",
  },
];
const READ_OPTIONS: readonly OptionSpec[] = [
  FORMAT_OPTION,
  FIELDS_OPTION,
  OUTPUT_FILE_OPTION,
  SANITIZE_OPTION,
  DEBUG_OPTION,
];
const DRY_RUN_OPTION: OptionSpec = {
  description: "Validate the action without mutating local state.",
  key: "dryRun",
  long: "--dry-run",
  type: "boolean",
};
const RAW_INPUT_OPTIONS: readonly OptionSpec[] = [
  {
    description: "Raw JSON payload for the command.",
    key: "json",
    long: "--json",
    type: "string",
    valueName: "payload",
  },
  {
    description: "JSON payload file, or '-' to read from stdin.",
    key: "inputFile",
    long: "--input-file",
    type: "string",
    valueName: "path",
  },
];
const MUTATION_OPTIONS: readonly OptionSpec[] = [
  ...READ_OPTIONS,
  DRY_RUN_OPTION,
  ...RAW_INPUT_OPTIONS,
];
const PROVIDER_OPTION: OptionSpec = {
  description: "Account provider.",
  key: "provider",
  long: "--provider",
  type: "string",
  valueName: "provider",
};
const SESSION_OPTIONS: readonly OptionSpec[] = [
  PROVIDER_OPTION,
  {
    description: "Use a Playwright storage-state JSON file.",
    key: "storageStateFile",
    long: "--storage-state-file",
    type: "string",
    valueName: "path",
  },
  {
    description: "Use inline Playwright storage-state JSON.",
    key: "storageStateJson",
    long: "--storage-state-json",
    type: "string",
    valueName: "payload",
  },
  {
    description: "Manual subscription renewal timestamp, or 'none' to clear.",
    key: "renewsAt",
    long: "--renews-at",
    type: "string",
    valueName: "timestamp",
  },
  {
    description: "Codex home containing auth.json.",
    key: "codexHome",
    long: "--codex-home",
    type: "string",
    valueName: "path",
  },
];

const ACCOUNT_ARGUMENTS: readonly PositionalArgumentSpec[] = [
  {
    description: "Provider name or account name.",
    name: "providerOrName",
    required: false,
  },
  {
    description: "Account name when the provider is positional.",
    name: "name",
    required: false,
  },
];

function readOutput(paginated: boolean): CommandSpec["output"] {
  return {
    paginated,
    supportsFields: true,
    supportsNdjson: true,
  };
}

function safety(dryRun: boolean): CommandSpec["safety"] {
  return { dryRun, sanitizesRemoteStrings: true };
}

export const COMMAND_SPECS = [
  {
    aliases: [],
    arguments: [],
    examples: [
      "gauge status --format json --fields recommendation.account.name,accounts.name",
      "gauge --quick --format json",
      "gauge status --provider codex --account work --quick --format json",
      "gauge status --format ndjson --page-size 1 --page-all",
    ],
    name: "status",
    options: [
      ...READ_OPTIONS,
      ...PAGE_OPTIONS,
      {
        description: "Show only the recommended account.",
        key: "quick",
        long: "--quick",
        short: "-q",
        type: "boolean",
      },
      PROVIDER_OPTION,
      {
        description: "Select one configured account by name.",
        key: "account",
        long: "--account",
        type: "string",
        valueName: "name",
      },
      {
        description: "Prohibit every credential write during acquisition.",
        key: "noCredentialRefresh",
        long: "--no-credential-refresh",
        type: "boolean",
      },
    ],
    output: readOutput(true),
    rootAlias: true,
    safety: safety(false),
    sideEffects: ["reads_local_state", "network", "writes_credentials"],
    summary:
      "Fetch usage for configured accounts and recommend the next account.",
    wireSchema: COMMAND_WIRE_SCHEMAS.status,
  },
  {
    aliases: [],
    arguments: [],
    examples: [
      "gauge list --format json",
      "gauge list --format ndjson --page-size 10 --page-all",
    ],
    name: "list",
    options: [...READ_OPTIONS, ...PAGE_OPTIONS],
    output: readOutput(true),
    rootAlias: false,
    safety: safety(false),
    sideEffects: ["reads_local_state"],
    summary: "List configured accounts and their local artifact state.",
    wireSchema: COMMAND_WIRE_SCHEMAS.list,
  },
  {
    aliases: [],
    arguments: [
      {
        description: "Optional command to describe.",
        name: "command",
        required: false,
      },
    ],
    examples: [
      "gauge describe --format json",
      "gauge describe add --fields commands.command,commands.raw_payload.schema",
    ],
    name: "describe",
    options: READ_OPTIONS,
    output: readOutput(false),
    rootAlias: false,
    safety: safety(false),
    sideEffects: [],
    summary: "Describe command contracts and agent guardrails.",
    wireSchema: COMMAND_WIRE_SCHEMAS.describe,
  },
  {
    aliases: [],
    arguments: ACCOUNT_ARGUMENTS,
    examples: [
      "gauge add personal --dry-run",
      "gauge add personal",
      "gauge add codex work --codex-home ~/.codex-work --dry-run",
      "gauge add codex work --codex-home ~/.codex-work",
      "gauge add cursor work --storage-state-file ./cursor-state.json --dry-run",
      "gauge add cursor work --storage-state-file ./cursor-state.json",
      `gauge add --json '{"name":"personal","storage_state_json":{"cookies":[],"origins":[]}}' --dry-run --format json`,
      `gauge add --json '{"name":"personal","storage_state_json":{"cookies":[],"origins":[]}}' --format json`,
    ],
    name: "add",
    options: [...MUTATION_OPTIONS, ...SESSION_OPTIONS],
    output: readOutput(false),
    rootAlias: false,
    safety: safety(true),
    sideEffects: ["browser", "network", "writes_local_state"],
    summary: "Add an account using browser, Codex home, or storage-state auth.",
    wireSchema: COMMAND_WIRE_SCHEMAS.add,
  },
  {
    aliases: [],
    arguments: ACCOUNT_ARGUMENTS,
    examples: [
      "gauge refresh personal --dry-run",
      "gauge refresh personal",
      "gauge refresh codex work --renews-at 2026-07-12 --dry-run",
      "gauge refresh codex work --renews-at 2026-07-12",
      "gauge refresh cursor work --storage-state-file ./cursor-state.json --dry-run",
      "gauge refresh cursor work --storage-state-file ./cursor-state.json",
    ],
    name: "refresh",
    options: [...MUTATION_OPTIONS, ...SESSION_OPTIONS],
    output: readOutput(false),
    rootAlias: false,
    safety: safety(true),
    sideEffects: ["browser", "network", "writes_local_state"],
    summary: "Refresh an account session or update its auth source.",
    wireSchema: COMMAND_WIRE_SCHEMAS.refresh,
  },
  {
    aliases: [],
    arguments: ACCOUNT_ARGUMENTS,
    examples: [
      "gauge remove personal --dry-run",
      "gauge remove personal",
      `gauge remove --json '{"name":"personal"}' --dry-run --format json`,
      `gauge remove --json '{"name":"personal"}' --format json`,
    ],
    name: "remove",
    options: [...MUTATION_OPTIONS, PROVIDER_OPTION],
    output: readOutput(false),
    rootAlias: false,
    safety: safety(true),
    sideEffects: ["writes_local_state"],
    summary: "Remove an account and its local authentication artifacts.",
    wireSchema: COMMAND_WIRE_SCHEMAS.remove,
  },
  {
    aliases: [],
    arguments: [],
    examples: ["gauge doctor --format json"],
    name: "doctor",
    options: READ_OPTIONS,
    output: readOutput(false),
    rootAlias: false,
    safety: safety(false),
    sideEffects: ["reads_local_state"],
    summary:
      "Check runtime, schema, and local-state readiness without mutation.",
    wireSchema: COMMAND_WIRE_SCHEMAS.doctor,
  },
  {
    aliases: [],
    arguments: [],
    examples: [
      "gauge migrate --dry-run --format json",
      "gauge migrate --format json",
    ],
    name: "migrate",
    options: [...READ_OPTIONS, DRY_RUN_OPTION],
    output: readOutput(false),
    rootAlias: false,
    safety: safety(true),
    sideEffects: ["writes_local_state"],
    summary: "Migrate legacy account artifacts to the current storage format.",
    wireSchema: COMMAND_WIRE_SCHEMAS.migrate,
  },
] as const satisfies readonly CommandSpec[];

export const COMMAND_SPECS_BY_NAME = {
  status: COMMAND_SPECS[0],
  list: COMMAND_SPECS[1],
  describe: COMMAND_SPECS[2],
  add: COMMAND_SPECS[3],
  refresh: COMMAND_SPECS[4],
  remove: COMMAND_SPECS[5],
  doctor: COMMAND_SPECS[6],
  migrate: COMMAND_SPECS[7],
} satisfies Record<CommandName, CommandSpec>;

/** Render the checked-in command example reference from canonical metadata. */
export function renderCommandExamplesMarkdown(): string {
  return [
    "# Gauge command examples",
    "",
    "<!-- Generated by `pnpm docs:generate`; do not edit by hand. -->",
    "",
    ...COMMAND_SPECS.flatMap((spec) => [
      `## ${spec.name}`,
      "",
      ...spec.examples.map((example) => `- \`${example}\``),
      "",
    ]),
  ].join("\n");
}
