import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseStorageStateJsonValue,
  parseStorageStateObject,
} from "../src/storage-state.js";

test("accepts a complete documented Playwright storage state", () => {
  const state = {
    cookies: [
      {
        name: "session",
        value: "secret",
        domain: ".example.com",
        path: "/",
        expires: 1_800_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
        partitionKey: "https://example.com",
      },
    ],
    origins: [
      {
        origin: "https://example.com",
        localStorage: [{ name: "theme", value: "dark" }],
        indexedDB: [
          {
            name: "cache",
            version: 1,
            stores: [
              {
                name: "entries",
                autoIncrement: false,
                keyPath: "id",
                records: [{ key: "one", value: { enabled: true } }],
                indexes: [
                  {
                    name: "by-id",
                    keyPath: "id",
                    multiEntry: false,
                    unique: true,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  } as const;

  assert.deepEqual(parseStorageStateObject(state), state);
});

test("parses JSON strings through a distinct typed entry point", () => {
  const state = { cookies: [], origins: [] };

  assert.deepEqual(parseStorageStateJsonValue(JSON.stringify(state)), state);
});

test("rejects malformed documented fields and top-level junk", () => {
  const cookie = {
    name: "session",
    value: "secret",
    domain: ".example.com",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };
  const invalidStates = [
    // The top-level wrapper is gauge's own contract and stays strict.
    { cookies: [], origins: [], unexpected: true },
    // Documented fields must still hold their declared types.
    { cookies: [{ ...cookie, sameSite: "Sometimes" }], origins: [] },
    { cookies: [{ ...cookie, secure: "yes" }], origins: [] },
  ];

  for (const state of invalidStates) {
    assert.throws(() => parseStorageStateObject(state), {
      name: "CLIError",
      message: /not valid Playwright state/,
    });
  }
});

test("tolerates and preserves Playwright-owned unknown keys", () => {
  // Chromium emits `_crHasCrossSiteAncestor` on cross-site cookies; other
  // browser versions add further fields. gauge hands this blob straight back
  // to Playwright, so unknown keys must survive the round trip untouched.
  const state = {
    cookies: [
      {
        name: "session",
        value: "secret",
        domain: ".example.com",
        path: "/",
        expires: 1_800_000_000,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
        _crHasCrossSiteAncestor: true,
      },
    ],
    origins: [
      {
        origin: "https://example.com",
        localStorage: [{ name: "theme", value: "dark", futureField: 1 }],
        futureOriginField: "keep",
      },
    ],
  };

  assert.deepEqual(parseStorageStateObject(state), state);
});
