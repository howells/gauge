import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// biome-ignore lint/suspicious/noExplicitAny: test-only JSON parsing
function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

test("package.json uses scoped gauge name and bin", () => {
  const pkg = readJson(path.join(root, "package.json"));
  assert.equal(pkg.name, "@howells/gauge");
  assert.ok(pkg.bin?.gauge);
});

test("CLI help text references gauge", () => {
  const programSource = fs.readFileSync(
    path.join(root, "src", "program.ts"),
    "utf-8",
  );
  const specsSource = fs.readFileSync(
    path.join(root, "src", "commands", "specs.ts"),
    "utf-8",
  );
  assert.match(programSource, /\.name\("gauge"\)/);
  assert.match(specsSource, /gauge add/);
});

test("package ships dist through deterministic prepack gates", () => {
  const pkg = readJson(path.join(root, "package.json"));
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes("dist"));
  assert.ok(pkg.files.includes("README.md"));
  assert.ok(pkg.files.includes("LICENSE"));
  assert.ok(pkg.files.includes("package.json"));
  // Semver, not a fixed number: this test is about the packaging shape, and
  // pinning the version here only guarantees a failure on the next release.
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  assert.equal(pkg.scripts?.prepare, undefined);
  assert.match(pkg.scripts?.prepack, /build/);
  assert.match(pkg.scripts?.prepack, /schema:check/);
  assert.deepEqual(pkg.exports, { "./package.json": "./package.json" });
});

test("src CLI begins with shebang", () => {
  const cliSource = fs.readFileSync(path.join(root, "src", "cli.ts"), "utf-8");
  const firstLine = cliSource.split("\n")[0];
  assert.equal(firstLine, "#!/usr/bin/env node");
});

test("engines.node requires Node 20 or newer", () => {
  const pkg = readJson(path.join(root, "package.json"));
  assert.ok(pkg.engines?.node);
  assert.equal(pkg.engines.node, ">=20");
});

test("dependencies has playwright-core, not playwright", () => {
  const pkg = readJson(path.join(root, "package.json"));
  assert.ok(pkg.dependencies["playwright-core"]);
  assert.equal(pkg.dependencies.playwright, undefined);
});
