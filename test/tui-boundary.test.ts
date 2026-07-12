import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("TUI depends on the shared command service rather than providers or account files", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = fs.readFileSync(path.join(root, "src", "tui.ts"), "utf8");

  assert.match(source, /runStatusCommand/);
  assert.doesNotMatch(source, /provider-usage|\.\/api|\.\/accounts/);
  assert.match(source, /finally/);
  assert.match(source, /setRawMode\(false\)/);
});

test("domain and service layers preserve the declared dependency direction", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  for (const file of fs.readdirSync(path.join(root, "src", "domain"))) {
    const source = fs.readFileSync(
      path.join(root, "src", "domain", file),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:providers|persistence|services|commands|cli|tui|accounts|api)/,
      `domain/${file} imports an operational layer`,
    );
  }
  for (const file of fs.readdirSync(path.join(root, "src", "services"))) {
    const source = fs.readFileSync(
      path.join(root, "src", "services", file),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /(?:\.\.\/commands|\.\.\/cli|\.\.\/tui)/,
      `services/${file} imports a presentation layer`,
    );
  }
  const adapters = fs.readFileSync(
    path.join(root, "src", "providers", "local-adapters.ts"),
    "utf8",
  );
  assert.doesNotMatch(adapters, /\.\.\/(?:display|types)\.js/);

  for (const file of walkTypeScript(path.join(root, "src"))) {
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /(?:export\s+)?(?:const|function)\s+__test/,
      `${path.relative(root, file)} exposes a production __test hook`,
    );
  }
});

function walkTypeScript(directory: string): string[] {
  return fs.readdirSync(directory).flatMap((name) => {
    const target = path.join(directory, name);
    const status = fs.statSync(target);
    return status.isDirectory()
      ? walkTypeScript(target)
      : target.endsWith(".ts")
        ? [target]
        : [];
  });
}
