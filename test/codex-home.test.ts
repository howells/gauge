import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  codexHomeHasLogin,
  codexHomesRoot,
  createCodexHome,
  managedCodexHome,
  resolveCodexHomeInput,
} from "../src/services/codex-home.js";
import { codexSwitchTargets } from "../src/services/switch-login.js";

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gauge-codex-home-"));
}

test("a home gauge provisions is one a switch can later find", () => {
  const dataDir = scratch();
  const home = managedCodexHome(dataDir, "work");

  assert.equal(home, path.join(codexHomesRoot(dataDir), "work"));
  assert.equal(codexHomeHasLogin(home), false);

  createCodexHome(home);
  // Empty is still not switchable — a directory is not a login.
  assert.equal(codexHomeHasLogin(home), false);
  assert.deepEqual(codexSwitchTargets(dataDir), []);

  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: "t" } }),
  );
  assert.equal(codexHomeHasLogin(home), true);
  assert.deepEqual(
    codexSwitchTargets(dataDir).map((target) => target.name),
    ["work"],
  );
});

test("a provisioned home is readable only by its owner", {
  skip: process.platform === "win32",
}, () => {
  const home = managedCodexHome(scratch(), "work");
  createCodexHome(home);

  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
});

test("createCodexHome accepts a home that already exists", () => {
  const home = managedCodexHome(scratch(), "work");
  createCodexHome(home);
  createCodexHome(home);

  assert.equal(fs.existsSync(home), true);
});

test("a typed path is expanded the way a shell would have expanded it", () => {
  assert.equal(
    resolveCodexHomeInput("~/.codex", "/Users/x"),
    "/Users/x/.codex",
  );
  assert.equal(resolveCodexHomeInput("~", "/Users/x"), "/Users/x");
  assert.equal(resolveCodexHomeInput("/tmp/codex", "/Users/x"), "/tmp/codex");
  // Not a home reference — a directory whose name happens to start with a tilde.
  assert.equal(
    resolveCodexHomeInput("~codex", "/Users/x"),
    path.resolve("~codex"),
  );
});
