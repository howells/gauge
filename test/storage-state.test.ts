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
        domain: ".example.com",
        expires: 1_800_000_000,
        httpOnly: true,
        name: "session",
        partitionKey: "https://example.com",
        path: "/",
        sameSite: "Lax",
        secure: true,
        value: "secret",
      },
    ],
    origins: [
      {
        indexedDB: [
          {
            name: "cache",
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
            version: 1,
          },
        ],
        localStorage: [{ name: "theme", value: "dark" }],
        origin: "https://example.com",
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
    domain: ".example.com",
    expires: -1,
    httpOnly: true,
    name: "session",
    path: "/",
    sameSite: "Lax",
    secure: true,
    value: "secret",
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
      message: /not valid Playwright state/u,
      name: "CLIError",
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
        _crHasCrossSiteAncestor: true,
        domain: ".example.com",
        expires: 1_800_000_000,
        httpOnly: true,
        name: "session",
        path: "/",
        sameSite: "Lax" as const,
        secure: true,
        value: "secret",
      },
    ],
    origins: [
      {
        futureOriginField: "keep",
        localStorage: [{ futureField: 1, name: "theme", value: "dark" }],
        origin: "https://example.com",
      },
    ],
  };

  assert.deepEqual(parseStorageStateObject(state), state);
});
