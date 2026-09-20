import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("TUI depends on the shared command service rather than providers or account files", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const source = fs.readFileSync(path.join(root, "src", "tui.ts"), "utf-8");

  assert.match(source, /runStatusCommand/u);
  assert.doesNotMatch(source, /provider-usage|\.\/api|\.\/accounts/u);
  assert.match(source, /finally/u);
  assert.match(source, /setRawMode\(false\)/u);
});

test("domain and service layers preserve the declared dependency direction", () => {
  const root = path.resolve(import.meta.dirname, "..");
  for (const file of fs.readdirSync(path.join(root, "src", "domain"))) {
    const source = fs.readFileSync(
      path.join(root, "src", "domain", file),
      "utf-8"
    );
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:providers|persistence|services|commands|cli|tui|accounts|api)/u,
      `domain/${file} imports an operational layer`
    );
  }
  for (const file of fs.readdirSync(path.join(root, "src", "services"))) {
    const source = fs.readFileSync(
      path.join(root, "src", "services", file),
      "utf-8"
    );
    assert.doesNotMatch(
      source,
      /(?:\.\.\/commands|\.\.\/cli|\.\.\/tui)/u,
      `services/${file} imports a presentation layer`
    );
  }
  const adapters = fs.readFileSync(
    path.join(root, "src", "providers", "local-adapters.ts"),
    "utf-8"
  );
  assert.doesNotMatch(adapters, /\.\.\/(?:display|types)\.js/u);

  for (const file of walkTypeScript(path.join(root, "src"))) {
    assert.doesNotMatch(
      fs.readFileSync(file, "utf-8"),
      /(?:export\s+)?(?:const|function)\s+__test/u,
      `${path.relative(root, file)} exposes a production __test hook`
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
