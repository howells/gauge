import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const smokeRoot = path.join(root, ".package-smoke");
fs.rmSync(smokeRoot, { force: true, recursive: true });
fs.mkdirSync(smokeRoot, { recursive: true });

const pack = run("pnpm", ["pack", "--pack-destination", smokeRoot], root);
const tarballName = pack.stdout
  .trim()
  .split(/\r?\n/)
  .findLast((line) => line.endsWith(".tgz"));
assert.ok(tarballName, `pnpm pack did not report a tarball:\n${pack.stdout}`);
const tarball = path.resolve(root, tarballName);

fs.writeFileSync(
  path.join(smokeRoot, "package.json"),
  `${JSON.stringify({ name: "gauge-package-smoke", private: true })}\n`,
  { mode: 0o600 },
);
run("npm", ["install", "--ignore-scripts", tarball], smokeRoot);

const bin = path.join(smokeRoot, "node_modules", ".bin", "gauge");
const version = run(bin, ["--version"], smokeRoot);
assert.equal(version.stdout.trim(), "3.0.0");

const deepImport = spawnSync(
  process.execPath,
  ["--input-type=module", "--eval", "import('@howells/gauge/dist/cli.js')"],
  { cwd: smokeRoot, encoding: "utf8" },
);
assert.notEqual(deepImport.status, 0);
assert.match(
  `${deepImport.stdout}\n${deepImport.stderr}`,
  /ERR_PACKAGE_PATH_NOT_EXPORTED/,
);

const entries = run("tar", ["-tf", tarball], smokeRoot).stdout;
assert.doesNotMatch(entries, /\.(?:d\.ts|map)$/m);

fs.rmSync(smokeRoot, { force: true, recursive: true });

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
  );
  return result;
}
