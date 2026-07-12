import type { Provider } from "../domain/account.js";
import { CLIError } from "../security.js";

/**
 * Single source of truth for how a person adds each provider, shared by the
 * empty-state dashboard, the missing-name errors, and the CLI help. The mental
 * model is deliberately small: Claude and Cursor open a browser to log in;
 * Codex reads an existing Codex CLI login from a folder.
 */
interface AddStep {
  command: string;
  label: string;
  provider: Provider;
}

export const ADD_STEPS: readonly AddStep[] = [
  { provider: "claude", label: "Claude", command: "gauge add <name>" },
  {
    provider: "codex",
    label: "Codex",
    command: "gauge add codex <name> --codex-home <path>",
  },
  { provider: "cursor", label: "Cursor", command: "gauge add cursor <name>" },
];

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
};

/** Aligned "how to add each provider" table, indented by `indent`. */
export function addGuide(indent = ""): string {
  const width = Math.max(...ADD_STEPS.map((step) => step.label.length));
  return ADD_STEPS.map(
    (step) => `${indent}${step.label.padEnd(width)}   ${step.command}`,
  ).join("\n");
}

interface ProviderDetail {
  command: string;
  example: string;
  note: string;
}

function providerDetail(provider: Provider): ProviderDetail {
  switch (provider) {
    case "claude":
      return {
        command: "gauge add <name>",
        note: "Opens a browser so you can log in to Claude.",
        example: "gauge add personal",
      };
    case "cursor":
      return {
        command: "gauge add cursor <name>",
        note: "Opens a browser so you can log in to Cursor.",
        example: "gauge add cursor work",
      };
    case "codex":
      return {
        command: "gauge add codex <name> --codex-home <path>",
        note: "<path> is the folder holding the Codex CLI's auth.json (often ~/.codex).",
        example: "gauge add codex work --codex-home ~/.codex",
      };
  }
}

/**
 * A person ran a mutating command without naming the account. Return an error
 * that shows exactly what to type next instead of a schema-validation dump.
 */
export function missingAccountName(
  command: "add" | "refresh" | "remove",
  provider?: Provider,
): CLIError {
  return new CLIError(missingNameMessage(command, provider), {
    code: "ACCOUNT_NAME_REQUIRED",
    exitCode: 2,
    details: provider ? { provider } : {},
    // Static guidance with example paths (~/.codex); must survive redaction.
    trustedMessage: true,
  });
}

function missingNameMessage(
  command: "add" | "refresh" | "remove",
  provider?: Provider,
): string {
  if (command !== "add") {
    const verb = command === "refresh" ? "refresh" : "remove";
    const subject = provider
      ? `${PROVIDER_LABEL[provider]} account`
      : "account";
    const syntax = provider
      ? `gauge ${verb} ${provider} <name>`
      : `gauge ${verb} <name>`;
    return [
      `Name the ${subject} you want to ${verb}:`,
      "",
      `  ${syntax}`,
      "",
      "See your accounts with: gauge list",
    ].join("\n");
  }
  if (provider) {
    const detail = providerDetail(provider);
    return [
      `Name the ${PROVIDER_LABEL[provider]} account you want to add:`,
      "",
      `  ${detail.command}`,
      "",
      detail.note,
      `Example: ${detail.example}`,
    ].join("\n");
  }
  return [
    "Name the account you want to add. Pick a provider:",
    "",
    addGuide("  "),
    "",
    "Claude and Cursor open a browser to log in.",
    "Codex reads an existing Codex CLI login from a folder.",
    "",
    "Example: gauge add personal",
  ].join("\n");
}
