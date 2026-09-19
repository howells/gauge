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
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
  multiEntry: z.boolean(),
  name: z.string(),
  unique: z.boolean(),
});

const IndexedDBObjectStoreSchema = z.looseObject({
  autoIncrement: z.boolean(),
  indexes: z.array(IndexedDBIndexSchema),
  keyPath: z.string().optional(),
  keyPathArray: z.array(z.string()).optional(),
  name: z.string(),
  records: z.array(IndexedDBRecordSchema),
});

const IndexedDBDatabaseSchema = z.looseObject({
  name: z.string(),
  stores: z.array(IndexedDBObjectStoreSchema),
  version: z.int(),
});

const StorageStateCookieSchema = z.looseObject({
  domain: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  name: z.string(),
  partitionKey: z.string().optional(),
  path: z.string(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
  secure: z.boolean(),
  value: z.string(),
});

const StorageStateOriginSchema = z.looseObject({
  indexedDB: z.array(IndexedDBDatabaseSchema).optional(),
  localStorage: z.array(NameValueSchema),
  origin: z.string().url(),
});

/** The strict serializable shape accepted by Playwright's storageState option. */
export const PlaywrightStorageStateSchema = z.strictObject({
  cookies: z.array(StorageStateCookieSchema),
  origins: z.array(StorageStateOriginSchema),
});

export type PlaywrightStorageState = z.infer<
  typeof PlaywrightStorageStateSchema
>;
