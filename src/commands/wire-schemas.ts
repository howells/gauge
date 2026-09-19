import { z } from "zod";

import { PlaywrightStorageStateSchema } from "../domain/storage-state-schema.js";

const CommandNameSchema = z.enum([
  "status",
  "list",
  "describe",
  "add",
  "refresh",
  "remove",
  "doctor",
  "migrate",
  "serve",
]);
export type CommandName = z.infer<typeof CommandNameSchema>;

const WireProviderSchema = z.enum(["claude", "codex", "cursor"]);

const AccountNameSchema = z.string().min(1);
const StorageStateInputSchema = z.union([
  z.string().min(1),
  PlaywrightStorageStateSchema,
]);

const StatusWireSchema = z.strictObject({});
const ListWireSchema = z.strictObject({});
const DescribeWireSchema = z.strictObject({
  command: CommandNameSchema.optional(),
});
const ServeWireSchema = z.strictObject({});

const AccountSessionFields = {
  codex_home: z.string().min(1).optional(),
  name: AccountNameSchema,
  provider: WireProviderSchema.optional(),
  renews_at: z.union([z.string().min(1), z.null()]).optional(),
  storage_state_file: z.string().min(1).optional(),
  storage_state_json: StorageStateInputSchema.optional(),
};

export const AddWireSchema = z.strictObject(AccountSessionFields);
export const RefreshWireSchema = z.strictObject(AccountSessionFields);
export const RemoveWireSchema = z.strictObject({
  name: AccountNameSchema,
  provider: WireProviderSchema.optional(),
});
const DoctorWireSchema = z.strictObject({});
const MigrateWireSchema = z.strictObject({});

export const COMMAND_WIRE_SCHEMAS = {
  add: AddWireSchema,
  describe: DescribeWireSchema,
  doctor: DoctorWireSchema,
  list: ListWireSchema,
  migrate: MigrateWireSchema,
  refresh: RefreshWireSchema,
  remove: RemoveWireSchema,
  serve: ServeWireSchema,
  status: StatusWireSchema,
} satisfies Record<CommandName, z.ZodType>;

export const COMMAND_WIRE_JSON_SCHEMAS = {
  add: z.toJSONSchema(AddWireSchema),
  describe: z.toJSONSchema(DescribeWireSchema),
  doctor: z.toJSONSchema(DoctorWireSchema),
  list: z.toJSONSchema(ListWireSchema),
  migrate: z.toJSONSchema(MigrateWireSchema),
  refresh: z.toJSONSchema(RefreshWireSchema),
  remove: z.toJSONSchema(RemoveWireSchema),
  serve: z.toJSONSchema(ServeWireSchema),
  status: z.toJSONSchema(StatusWireSchema),
} satisfies Record<CommandName, object>;
