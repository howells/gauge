import {
  OutputPathViolation,
  resolveConfinedOutputPath,
  writeConfinedOutput,
} from "./persistence/output-writer.js";

const SAFE_IDENTIFIER_RE = /^[a-zA-Z0-9_-]+$/u;

const ENCODED_SEGMENT_RE = /%(?:2e|2f|5c|3f|23)/iu;

export class CLIError extends Error {
  code: string;
  exitCode: number;
  details?: unknown;
  /**
   * When true, the message is author-written guidance with no interpolated
   * user data, so the path/token redactor must leave it intact (it would
   * otherwise mangle example paths like `~/.codex` in onboarding help).
   */
  trustedMessage: boolean;

  constructor(
    message: string,
    options?: {
      code?: string;
      exitCode?: number;
      details?: unknown;
      trustedMessage?: boolean;
    }
  ) {
    super(message);
    this.name = "CLIError";
    this.code = options?.code ?? "CLI_ERROR";
    this.exitCode = options?.exitCode ?? 1;
    this.details = options?.details;
    this.trustedMessage = options?.trustedMessage ?? false;
  }
}

const isSensitiveDiagnosticKey = (key: string): boolean =>
  /(?:apiKey|authKey|authorization|cookie|credential|password|secret|token)/iu.test(
    key
  );

export const redactDiagnosticValue = <T>(
  value: T,
  context: { cwd: string; home?: string }
): T => {
  if (typeof value === "string") {
    let redacted: string = value;
    for (const [pathValue, label] of [
      [context.cwd, "<cwd>"],
      [context.home, "<home>"],
    ] as const) {
      if (pathValue !== undefined && pathValue !== "") {
        redacted = redacted.split(pathValue).join(label);
      }
    }
    redacted = redacted
      .replaceAll(
        /(["'])(?:\/[^"'\r\n]+|[A-Za-z]:\\[^"'\r\n]+)\1/gu,
        "$1<redacted-path>$1"
      )
      .replaceAll(/\bBearer\s+\S+/giu, "Bearer <redacted-token>")
      .replaceAll(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "<redacted-token>")
      .replaceAll(
        /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/gu,
        "<redacted-token>"
      )
      .replaceAll(
        /(?<![A-Za-z0-9_.>])\/(?:[^\s"'<>:]+\/?)+/gu,
        "<redacted-path>"
      )
      .replaceAll(
        /(?<![A-Za-z0-9_.])[A-Za-z]:\\(?:[^\s"'<>]+\\?)+/gu,
        "<redacted-path>"
      );
    return redacted as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDiagnosticValue(item, context)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) =>
        isSensitiveDiagnosticKey(key)
          ? [key, "<redacted-secret>"]
          : [key, redactDiagnosticValue(nested, context)]
      )
    ) as T;
  }
  return value;
};

const mapOutputPathViolation = <T>(
  operation: () => T,
  cwd: string,
  requestedPath: string
): T => {
  try {
    return operation();
  } catch (error) {
    if (!(error instanceof OutputPathViolation)) {
      throw error;
    }
    throw new CLIError(error.message, {
      code: "INVALID_OUTPUT_PATH",
      details: { cwd, requestedPath },
      exitCode: 2,
    });
  }
};

export const resolveOutputPath = (cwd: string, requestedPath: string): string =>
  mapOutputPathViolation(
    () => resolveConfinedOutputPath(cwd, requestedPath),
    cwd,
    requestedPath
  );

export const writeSandboxedOutput = (
  cwd: string,
  requestedPath: string,
  content: string
): string =>
  mapOutputPathViolation(
    () => writeConfinedOutput(cwd, requestedPath, content),
    cwd,
    requestedPath
  );

const containsControlCharacters = (value: string): boolean => {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
};

export const assertSafeIdentifier = (
  value: string,
  label = "identifier"
): void => {
  if (value.length === 0) {
    throw new CLIError(`${label} contains invalid characters or is empty.`, {
      code: "INVALID_IDENTIFIER",
      exitCode: 2,
    });
  }

  if (containsControlCharacters(value)) {
    throw new CLIError(`${label} contains control characters.`, {
      code: "INVALID_IDENTIFIER",
      details: { label, value },
      exitCode: 2,
    });
  }

  if (
    value.includes("../") ||
    value.includes("..\\") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new CLIError(
      `${label} contains invalid characters or traversal sequences.`,
      {
        code: "INVALID_IDENTIFIER",
        details: { label, value },
        exitCode: 2,
      }
    );
  }

  if (ENCODED_SEGMENT_RE.test(value)) {
    throw new CLIError(
      `${label} must not contain percent-encoded path or query segments.`,
      {
        code: "INVALID_IDENTIFIER",
        details: { label, value },
        exitCode: 2,
      }
    );
  }

  if (value.includes("?") || value.includes("#")) {
    throw new CLIError(
      `${label} must not contain embedded query or fragment characters.`,
      {
        code: "INVALID_IDENTIFIER",
        details: { label, value },
        exitCode: 2,
      }
    );
  }

  if (!SAFE_IDENTIFIER_RE.test(value)) {
    throw new CLIError(
      `${label} contains invalid characters. Use letters, numbers, hyphens, or underscores only.`,
      {
        code: "INVALID_IDENTIFIER",
        details: { label, value },
        exitCode: 2,
      }
    );
  }
};

const stripControlCharacters = (value: string): string => {
  let output = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code > 31 && code !== 127) {
      output += character;
    }
  }
  return output;
};

export const sanitizeAgentText = (value: string): string =>
  stripControlCharacters(value).trim();

export const sanitizeForAgent = <T>(value: T): T => {
  if (typeof value === "string") {
    return sanitizeAgentText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForAgent(item)) as T;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value).map(([key, nestedValue]) => [
      key,
      sanitizeForAgent(nestedValue),
    ]);
    return Object.fromEntries(entries) as T;
  }

  return value;
};
