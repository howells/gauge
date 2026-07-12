import { z } from "zod";

// The cookie, origin, and indexedDB shapes below mirror Playwright/Chromium's
// own serialized `storageState()` output — an external format that gains fields
// across browser versions (e.g. Chromium's `_crHasCrossSiteAncestor` cookie
// flag). They use `looseObject` so unknown keys are tolerated *and preserved*:
// gauge stores this blob and hands it straight back to Playwright, so any field
// we don't model must round-trip untouched. We still validate the fields we
// depend on. Only the top-level wrapper — the contract gauge itself owns — stays
// strict.
const NameValueSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
});

const IndexedDBRecordSchema = z.looseObject({
  key: z.json().optional(),
  keyEncoded: z.json().optional(),
  value: z.json().optional(),
  valueEncoded: z.json().optional(),
});

const IndexedDBIndexSchema = z.looseObject({
  name: z.string(),
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
  multiEntry: z.boolean(),
  unique: z.boolean(),
});

const IndexedDBObjectStoreSchema = z.looseObject({
  name: z.string(),
  autoIncrement: z.boolean(),
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
  records: z.array(IndexedDBRecordSchema),
  indexes: z.array(IndexedDBIndexSchema),
});

const IndexedDBDatabaseSchema = z.looseObject({
  name: z.string(),
  version: z.int(),
  stores: z.array(IndexedDBObjectStoreSchema),
});

const StorageStateCookieSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  partitionKey: z.string().optional(),
});

const StorageStateOriginSchema = z.looseObject({
  origin: z.string().url(),
  localStorage: z.array(NameValueSchema),
  indexedDB: z.array(IndexedDBDatabaseSchema).optional(),
});

/** The strict serializable shape accepted by Playwright's storageState option. */
export const PlaywrightStorageStateSchema = z.strictObject({
  cookies: z.array(StorageStateCookieSchema),
  origins: z.array(StorageStateOriginSchema),
});

export type PlaywrightStorageState = z.infer<
  typeof PlaywrightStorageStateSchema
>;
