import process from "node:process";
import { sanitizeForAgent, writeSandboxedOutput } from "./security.js";

export type OutputFormat = "human" | "json" | "ndjson";

export interface OutputOptions {
  debug?: boolean;
  fields?: string;
  format?: string;
  outputFile?: string;
  page?: number;
  pageAll?: boolean;
  pageSize?: number;
  sanitize?: boolean;
}

export interface CommandResult {
  command: string;
  data: unknown;
  dryRun?: boolean;
  exitCode?: number;
  human: string;
  ok?: boolean;
  paginated?: {
    items: unknown[];
    itemName: string;
    summary?: Record<string, unknown>;
  };
  result?: "complete" | "failed" | "partial";
}

interface PagePayload {
  data: Record<string, unknown>;
  page_info: {
    index: number;
    page_size: number;
    total_items: number;
    total_pages: number;
  };
}

interface RenderedOutput {
  content: string;
  format: OutputFormat;
  outputPath?: string;
}

/** Determine the output format, defaulting to JSON for non-TTY and human for TTY. */
export function resolveOutputFormat(
  requestedFormat: string | undefined,
  isTTY = process.stdout.isTTY ?? false,
): OutputFormat {
  if (
    requestedFormat === "human" ||
    requestedFormat === "json" ||
    requestedFormat === "ndjson"
  ) {
    return requestedFormat;
  }

  return isTTY ? "human" : "json";
}

/** Parse a comma-separated field mask string into path segments. */
function parseFieldMask(fields: string | undefined): string[][] {
  if (!fields || fields.trim().length === 0 || fields.trim() === "*") {
    return [];
  }

  return fields
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean)
    .map((field) => field.split(".").filter(Boolean));
}

/** Project a value down to only the paths specified by the field mask. */
export function applyFieldMask<T>(value: T, fields: string | undefined): T {
  const mask = parseFieldMask(fields);
  if (mask.length === 0) {
    return value;
  }

  return maskValue(value, mask) as T;
}

function maskValue(value: unknown, mask: string[][]): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, mask));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const path of mask) {
    assignPath(result, value as Record<string, unknown>, path);
  }
  return result;
}

function assignPath(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  path: string[],
): void {
  if (path.length === 0) {
    return;
  }

  const segment = path[0];
  const rest = path.slice(1);
  if (!segment || !(segment in source)) {
    return;
  }

  const sourceValue = source[segment];
  if (rest.length === 0) {
    target[segment] = sourceValue;
    return;
  }

  if (Array.isArray(sourceValue)) {
    const existing = Array.isArray(target[segment])
      ? (target[segment] as unknown[])
      : [];
    target[segment] = sourceValue.map((item, index) => {
      if (!item || typeof item !== "object") {
        return item;
      }
      const previous = existing[index];
      const nestedTarget: Record<string, unknown> =
        previous && typeof previous === "object" && !Array.isArray(previous)
          ? { ...(previous as Record<string, unknown>) }
          : {};
      assignPath(nestedTarget, item as Record<string, unknown>, rest);
      return nestedTarget;
    });
    return;
  }

  if (!sourceValue || typeof sourceValue !== "object") {
    return;
  }

  const nestedTarget =
    target[segment] && typeof target[segment] === "object"
      ? (target[segment] as Record<string, unknown>)
      : {};
  assignPath(nestedTarget, sourceValue as Record<string, unknown>, rest);
  target[segment] = nestedTarget;
}

/** Split items into page payloads for structured output. */
export function paginateItems(
  items: unknown[],
  options: { page?: number; pageAll?: boolean; pageSize?: number },
  itemName: string,
  summary?: Record<string, unknown>,
): PagePayload[] {
  const pageSize = Math.max(1, options.pageSize ?? items.length ?? 1);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));

  if (options.pageAll) {
    return Array.from({ length: totalPages }, (_, index) =>
      buildPage(items, itemName, summary, index + 1, pageSize, totalPages),
    );
  }

  const page = Math.min(Math.max(1, options.page ?? 1), totalPages);
  return [buildPage(items, itemName, summary, page, pageSize, totalPages)];
}

function buildPage(
  items: unknown[],
  itemName: string,
  summary: Record<string, unknown> | undefined,
  page: number,
  pageSize: number,
  totalPages: number,
): PagePayload {
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);
  return {
    data: {
      ...(summary ?? {}),
      [itemName]: pageItems,
    },
    page_info: {
      index: page,
      page_size: pageSize,
      total_items: items.length,
      total_pages: totalPages,
    },
  };
}

/** Render a command result to the appropriate format with optional file output. */
export function renderCommandResult(
  result: CommandResult,
  options: OutputOptions,
  context: { cwd: string; isTTY?: boolean },
): RenderedOutput {
  const format = resolveOutputFormat(options.format, context.isTTY);
  const sanitize = options.sanitize ?? true;

  if (format === "human") {
    return writeMaybeToFile(
      result.human,
      format,
      options.outputFile,
      context.cwd,
    );
  }

  const pages = result.paginated
    ? paginateItems(
        result.paginated.items,
        {
          page: options.page,
          pageAll: options.pageAll,
          pageSize: options.pageSize,
        },
        result.paginated.itemName,
        result.paginated.summary,
      )
    : [
        {
          data: result.data as Record<string, unknown>,
          page_info: {
            index: 1,
            page_size: 1,
            total_items: 1,
            total_pages: 1,
          },
        },
      ];

  const structuredPages = pages.map((page) =>
    buildEnvelope(
      result.command,
      applyFieldMask(
        sanitize ? sanitizeForAgent(page.data) : page.data,
        options.fields,
      ),
      page.page_info,
      result.dryRun ?? false,
      sanitize,
      result.ok ?? true,
      result.result,
    ),
  );

  const content =
    format === "json"
      ? `${JSON.stringify(
          structuredPages.length === 1
            ? structuredPages[0]
            : {
                ok: result.ok ?? true,
                command: result.command,
                data: { pages: structuredPages.map((page) => page.data) },
                meta: structuredPages[0]?.meta,
              },
          null,
          2,
        )}\n`
      : `${structuredPages.map((page) => JSON.stringify(page)).join("\n")}\n`;

  return writeMaybeToFile(content, format, options.outputFile, context.cwd);
}

/** Render an error to the appropriate format with optional file output. */
export function renderError(
  error: { code?: string; message: string; details?: unknown },
  options: OutputOptions,
  context: { cwd: string; isTTY?: boolean; command: string },
): RenderedOutput {
  const format = resolveOutputFormat(options.format, context.isTTY);
  if (format === "human") {
    return writeMaybeToFile(
      `${error.message}\n`,
      format,
      options.outputFile,
      context.cwd,
    );
  }

  const payload = {
    ok: false,
    command: context.command,
    error: {
      code: error.code ?? "CLI_ERROR",
      message: error.message,
      ...(error.details !== undefined && {
        details:
          (options.sanitize ?? true)
            ? sanitizeForAgent(error.details)
            : error.details,
      }),
    },
    meta: {
      format,
      generated_at: new Date().toISOString(),
      sanitized: options.sanitize ?? true,
    },
  };
  const content =
    format === "json"
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${JSON.stringify(payload)}\n`;
  return writeMaybeToFile(content, format, options.outputFile, context.cwd);
}

function buildEnvelope(
  command: string,
  data: unknown,
  pageInfo: PagePayload["page_info"],
  dryRun: boolean,
  sanitized: boolean,
  ok: boolean,
  result?: "complete" | "failed" | "partial",
): Record<string, unknown> {
  return {
    ok,
    command,
    data,
    meta: {
      dry_run: dryRun,
      format: "structured",
      generated_at: new Date().toISOString(),
      page_info: pageInfo,
      ...(result !== undefined && { result }),
      sanitized,
    },
  };
}

function writeMaybeToFile(
  content: string,
  format: OutputFormat,
  outputFile: string | undefined,
  cwd: string,
): RenderedOutput {
  if (!outputFile) {
    return { content, format };
  }

  const outputPath = writeSandboxedOutput(cwd, outputFile, content);
  return { content, format, outputPath };
}
