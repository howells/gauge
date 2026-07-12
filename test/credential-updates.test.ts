import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AccountRepository } from "../src/persistence/account-repository.js";
import { applyPendingCredentialUpdates } from "../src/services/credential-updates.js";

test("pending Claude storage state is atomically applied through the account repository", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-updates-"));
  const repository = new AccountRepository({ dataRoot });
  const id = { provider: "claude", name: "work" } as const;
  repository.add(id, { storageState: { cookies: [], origins: [] } });

  applyPendingCredentialUpdates(
    [
      {
        kind: "storage-state",
        provider: "claude",
        sourceId: id,
        value: {
          cookies: [
            {
              name: "session",
              value: "new",
              domain: ".claude.ai",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: true,
              sameSite: "Lax",
            },
          ],
          origins: [],
        },
      },
    ],
    {
      allowedCodexHomes: [],
      dataRoot,
      policy: "refresh-if-stale",
    },
  );

  const stored = JSON.parse(
    fs.readFileSync(repository.pathsFor(id).storageState, "utf8"),
  ) as { cookies: Array<{ value: string }> };
  assert.equal(stored.cookies[0]?.value, "new");
});

test("never policy discards pending storage-state writes", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gauge-updates-"));
  const repository = new AccountRepository({ dataRoot });
  const id = { provider: "claude", name: "work" } as const;
  repository.add(id, { storageState: { cookies: [], origins: [] } });
  const storagePath = repository.pathsFor(id).storageState;
  const before = fs.readFileSync(storagePath, "utf8");

  applyPendingCredentialUpdates(
    [
      {
        kind: "storage-state",
        provider: "claude",
        sourceId: id,
        value: { cookies: [], origins: [] },
      },
    ],
    { allowedCodexHomes: [], dataRoot, policy: "never" },
  );

  assert.equal(fs.readFileSync(storagePath, "utf8"), before);
});
