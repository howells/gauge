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

const AccountSessionFields = {
  name: AccountNameSchema,
  provider: WireProviderSchema.optional(),
  codex_home: z.string().min(1).optional(),
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
  status: StatusWireSchema,
  list: ListWireSchema,
  describe: DescribeWireSchema,
  add: AddWireSchema,
  refresh: RefreshWireSchema,
  remove: RemoveWireSchema,
  doctor: DoctorWireSchema,
  migrate: MigrateWireSchema,
} satisfies Record<CommandName, z.ZodType>;

export const COMMAND_WIRE_JSON_SCHEMAS = {
  status: z.toJSONSchema(StatusWireSchema),
  list: z.toJSONSchema(ListWireSchema),
  describe: z.toJSONSchema(DescribeWireSchema),
  add: z.toJSONSchema(AddWireSchema),
  refresh: z.toJSONSchema(RefreshWireSchema),
  remove: z.toJSONSchema(RemoveWireSchema),
  doctor: z.toJSONSchema(DoctorWireSchema),
  migrate: z.toJSONSchema(MigrateWireSchema),
} satisfies Record<CommandName, object>;
