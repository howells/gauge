import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface AtomicReplaceOptions {
  close?: (descriptor: number) => void;
  fsync?: (descriptor: number) => void;
  mode?: number;
  rename?: (temporaryPath: string, destinationPath: string) => void;
  unlink?: (temporaryPath: string) => void;
  write?: (descriptor: number, content: string) => void;
}

const flushDirectory = (
  directory: string,
  fsync: (descriptor: number) => void,
  close: (descriptor: number) => void
): void => {
  const descriptor = fs.openSync(directory, "r");
  try {
    fsync(descriptor);
  } finally {
    close(descriptor);
  }
};

const isMissingPathError = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "ENOENT";

export const atomicReplace = (
  destinationPath: string,
  content: string,
  options: AtomicReplaceOptions = {}
): void => {
  const directory = path.dirname(destinationPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destinationPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const rename = options.rename ?? fs.renameSync;
  const close = options.close ?? fs.closeSync;
  const fsync = options.fsync ?? fs.fsyncSync;
  const unlink = options.unlink ?? fs.unlinkSync;
  const write =
    options.write ??
    ((fd, value) => {
      fs.writeFileSync(fd, value);
    });
  let descriptor: number | null = null;

  try {
    descriptor = fs.openSync(temporaryPath, "wx", options.mode ?? 0o666);
    write(descriptor, content);
    fsync(descriptor);
    close(descriptor);
    descriptor = null;
    rename(temporaryPath, destinationPath);
    flushDirectory(directory, fsync, close);
  } catch (error) {
    if (descriptor !== null) {
      close(descriptor);
    }
    try {
      unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isMissingPathError(cleanupError)) {
        throw new AggregateError(
          [error, cleanupError],
          "Atomic replacement and temporary-file cleanup both failed.",
          { cause: cleanupError }
        );
      }
    }
    throw error;
  }
};
