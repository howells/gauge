import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const BASELINE_COMMIT = "45f9cb571107a8e568fc4ce46de6cc9339cd50ea";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let buildRoot = "";

before(() => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-v2-fixed-point-"));
  const archive = spawnSync("git", ["archive", BASELINE_COMMIT], {
    cwd: root,
    maxBuffer: 50 * 1024 * 1024,
  });
  assert.equal(archive.status, 0, archive.stderr.toString());
  const extract = spawnSync("tar", ["-x", "-C", buildRoot], {
    input: archive.stdout,
  });
  assert.equal(extract.status, 0, extract.stderr.toString());
  fs.symlinkSync(
    path.join(root, "node_modules"),
    path.join(buildRoot, "node_modules"),
  );
  const compile = spawnSync(
    path.join(root, "node_modules", ".bin", "tsc"),
    ["-p", path.join(buildRoot, "tsconfig.json")],
    { cwd: buildRoot, encoding: "utf8" },
  );
  assert.equal(compile.status, 0, compile.stderr);
});

after(() => {
  fs.rmSync(buildRoot, { force: true, recursive: true });
});

test("v2.0.1 fixed point executes help, discovery, reads, aliases, and errors", () => {
  assert.equal(runV2(["--version"]).stdout.trim(), "2.0.1");

  const help = runV2(["--help"]);
  assert.equal(help.status, 0);
  for (const command of [
    "status",
    "list",
    "describe",
    "add",
    "refresh",
    "remove",
  ]) {
    assert.match(help.stdout, new RegExp(`^  ${command}(?: | \\[)`, "m"));
  }

  const describe = parseJson(runV2(["describe", "--format", "json"]));
  assert.equal(describe.command, "describe");
  assert.deepEqual(
    (describe.data as { commands: Array<{ command: string }> }).commands.map(
      ({ command }) => command,
    ),
    ["status", "list", "describe", "add", "refresh", "remove"],
  );

  const list = parseJson(runV2(["list", "--format", "json"]));
  assert.deepEqual(
    { command: list.command, data: list.data, ok: list.ok },
    { command: "list", data: { accounts: [] }, ok: true },
  );
  const ndjson = runV2(["list", "--format", "ndjson"]);
  assert.equal(ndjson.status, 0);
  assert.equal(ndjson.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(ndjson.stdout).command, "list");

  const rootAlias = parseJson(runV2(["--quick", "--format", "json"]));
  assert.equal(rootAlias.command, "status");

  const invalid = runV2(["add", "../bad", "--format", "json"]);
  assert.equal(invalid.status, 2);
  assert.deepEqual(
    (
      (JSON.parse(invalid.stdout) as Record<string, unknown>).error as {
        code: string;
      }
    ).code,
    "INVALID_IDENTIFIER",
  );
});

function runV2(args: string[]): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-v2-run-"));
  const home = path.join(fixture, "home");
  const cwd = path.join(fixture, "cwd");
  fs.mkdirSync(home);
  fs.mkdirSync(cwd);
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(buildRoot, "dist", "cli.js"), ...args],
      {
        cwd,
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, "");
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
}

function parseJson(result: ReturnType<typeof runV2>): Record<string, unknown> {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}
