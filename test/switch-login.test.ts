import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  codexSwitchTargets,
  switchCodexLogin,
} from "../src/services/switch-login.js";

function scratch(): { dataDir: string; home: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-switch-"));
  return { dataDir: path.join(root, "data"), home: path.join(root, "home") };
}

function seed(dataDir: string, name: string, token: string): void {
  const home = path.join(dataDir, "codex-homes", name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "auth.json"),
    JSON.stringify({ tokens: { access_token: token } }),
  );
}

test("codexSwitchTargets lists only accounts that actually carry credentials", () => {
  const { dataDir } = scratch();
  seed(dataDir, "gmail", "g");
  seed(dataDir, "work", "w");
  // A home with no auth.json is not somewhere anyone can be switched to.
  fs.mkdirSync(path.join(dataDir, "codex-homes", "empty"), { recursive: true });

  assert.deepEqual(
    codexSwitchTargets(dataDir).map((target) => target.name),
    ["gmail", "work"],
  );
});

test("switchCodexLogin writes the account's credentials into the active home", () => {
  const { dataDir, home } = scratch();
  seed(dataDir, "gmail", "gmail-token");

  const result = switchCodexLogin("gmail", dataDir, home);

  const written = JSON.parse(
    fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"),
  );
  assert.equal(written.tokens.access_token, "gmail-token");
  assert.equal(result.name, "gmail");
  assert.equal(result.backedUp, null);
});

test("switchCodexLogin keeps the credentials it replaces", () => {
  const { dataDir, home } = scratch();
  seed(dataDir, "gmail", "gmail-token");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "previous" } }),
  );

  const result = switchCodexLogin("gmail", dataDir, home);

  assert.ok(result.backedUp);
  const kept = JSON.parse(fs.readFileSync(result.backedUp, "utf8"));
  // A switch must be reversible even when the account left behind was the only
  // one signed in anywhere.
  assert.equal(kept.tokens.access_token, "previous");
});

test("switchCodexLogin refuses unparseable credentials without touching the live session", () => {
  const { dataDir, home } = scratch();
  const stored = path.join(dataDir, "codex-homes", "broken");
  fs.mkdirSync(stored, { recursive: true });
  fs.writeFileSync(path.join(stored, "auth.json"), "{ truncated");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "working" } }),
  );

  assert.throws(() => switchCodexLogin("broken", dataDir, home));

  const live = JSON.parse(
    fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"),
  );
  // Trading a wrong account for no account is the one outcome worth refusing.
  assert.equal(live.tokens.access_token, "working");
});

test("switchCodexLogin refuses an account it holds nothing for", () => {
  const { dataDir, home } = scratch();
  assert.throws(
    () => switchCodexLogin("absent", dataDir, home),
    /No stored Codex home/u,
  );
});
