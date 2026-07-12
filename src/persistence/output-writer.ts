import fs from "node:fs";
import path from "node:path";
import { atomicReplace } from "./atomic-replace.js";

export class OutputPathViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputPathViolation";
  }
}

/** Resolve an output path against the canonical cwd without following child symlinks. */
export function resolveConfinedOutputPath(
  cwd: string,
  requestedPath: string,
): string {
  if (containsControlCharacters(requestedPath)) {
    throw new OutputPathViolation("Output path contains control characters.");
  }
  if (requestedPath.startsWith("~")) {
    throw escapedCwdError();
  }

  const lexicalCwd = path.resolve(cwd);
  const canonicalCwd = canonicalDirectory(lexicalCwd);
  const lexicalDestination = path.resolve(lexicalCwd, requestedPath);
  const relativeDestination = path.relative(lexicalCwd, lexicalDestination);
  if (!isConfinedRelativePath(relativeDestination)) {
    throw escapedCwdError();
  }

  const canonicalDestination = path.resolve(canonicalCwd, relativeDestination);
  const canonicalRelative = path.relative(canonicalCwd, canonicalDestination);
  if (!isConfinedRelativePath(canonicalRelative)) {
    throw escapedCwdError();
  }
  return canonicalDestination;
}

/** Write output beneath the canonical cwd without following symlinked path components. */
export function writeConfinedOutput(
  cwd: string,
  requestedPath: string,
  content: string,
  runtime: {
    lstat?: typeof fs.lstatSync;
    mkdir?: typeof fs.mkdirSync;
  } = {},
): string {
  const canonicalCwd = canonicalDirectory(path.resolve(cwd));
  const destinationPath = resolveConfinedOutputPath(cwd, requestedPath);
  ensureSafeParentDirectories(
    canonicalCwd,
    path.dirname(destinationPath),
    runtime,
  );
  const destination = readPathStatus(destinationPath, runtime.lstat);
  if (destination?.isSymbolicLink()) {
    throw new OutputPathViolation(
      "Output path has a symlinked output destination.",
    );
  }
  if (destination && !destination.isFile()) {
    throw new OutputPathViolation("Output destination must be a regular file.");
  }

  atomicReplace(destinationPath, content, {
    ...(destination && { mode: destination.mode & 0o777 }),
  });
  return destinationPath;
}

function canonicalDirectory(directoryPath: string): string {
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(directoryPath);
  } catch {
    throw new OutputPathViolation(
      "Output working directory must be an existing directory.",
    );
  }
  if (!fs.statSync(canonicalPath).isDirectory()) {
    throw new OutputPathViolation(
      "Output working directory must be an existing directory.",
    );
  }
  return canonicalPath;
}

function ensureSafeParentDirectories(
  canonicalCwd: string,
  destinationParent: string,
  runtime: {
    lstat?: typeof fs.lstatSync;
    mkdir?: typeof fs.mkdirSync;
  },
): void {
  const relativeParent = path.relative(canonicalCwd, destinationParent);
  if (!isConfinedRelativePath(relativeParent)) {
    throw escapedCwdError();
  }

  let currentPath = canonicalCwd;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    let status = readPathStatus(currentPath, runtime.lstat);
    if (!status) {
      try {
        (runtime.mkdir ?? fs.mkdirSync)(currentPath, { mode: 0o700 });
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          throw error;
        }
      }
      status = readPathStatus(currentPath, runtime.lstat);
    }
    if (status?.isSymbolicLink()) {
      throw new OutputPathViolation(
        "Output path has a symlinked output path component.",
      );
    }
    if (!status?.isDirectory()) {
      throw new OutputPathViolation(
        "Every output path ancestor must be a directory.",
      );
    }
  }
}

function readPathStatus(
  filePath: string,
  lstat: typeof fs.lstatSync = fs.lstatSync,
): fs.Stats | null {
  try {
    return lstat(filePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

function isConfinedRelativePath(relativePath: string): boolean {
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function escapedCwdError(): OutputPathViolation {
  return new OutputPathViolation(
    "Output path must stay inside the current working directory. The agent is not a trusted operator.",
  );
}

function containsControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}

function isMissingPathError(error: unknown): boolean {
  return isErrorCode(error, "ENOENT");
}

function isAlreadyExistsError(error: unknown): boolean {
  return isErrorCode(error, "EEXIST");
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
