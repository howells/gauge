import { z } from "zod";
import { AccountIdSchema } from "../domain/account.js";
import type { PendingCredentialUpdate } from "../domain/snapshot.js";
import { AccountRepository } from "../persistence/account-repository.js";
import {
  type CredentialRefreshPolicy,
  ExternalCredentialWriter,
} from "../persistence/external-credential-writer.js";
import { CLIError } from "../security.js";
import { parseStorageStateObject } from "../storage-state.js";

const CodexCredentialUpdateSchema = z.strictObject({
  accessToken: z.string().min(1),
  homePath: z.string().min(1),
  idToken: z.string().min(1).optional(),
  lastRefresh: z.iso.datetime(),
  refreshToken: z.string().min(1).optional(),
});

/** Validate and atomically apply provider-returned external credential updates. */
export function applyPendingCredentialUpdates(
  updates: PendingCredentialUpdate[],
  options: {
    allowedCodexHomes: string[];
    dataRoot: string;
    policy: CredentialRefreshPolicy;
  },
): void {
  const external = updates.filter(
    (update) => update.kind === "external-credential",
  );
  if (external.length > 0) {
    const writer = new ExternalCredentialWriter({
      allowedCodexHomes: options.allowedCodexHomes,
    });
    for (const pending of external) {
      const parsed = CodexCredentialUpdateSchema.safeParse(pending.value);
      if (!parsed.success) {
        throw new CLIError("Provider returned an invalid credential update.", {
          code: "INVALID_CREDENTIAL_UPDATE",
        });
      }
      writer.apply(parsed.data, options.policy);
    }
  }
  const storageUpdates = updates.filter(
    (update) => update.kind === "storage-state",
  );
  if (storageUpdates.length === 0 || options.policy === "never") return;
  const repository = new AccountRepository({ dataRoot: options.dataRoot });
  for (const pending of storageUpdates) {
    const id = AccountIdSchema.safeParse(pending.sourceId);
    if (!id.success) {
      throw new CLIError("Provider returned an invalid storage-state target.", {
        code: "INVALID_CREDENTIAL_UPDATE",
      });
    }
    repository.replaceStorageState(
      id.data,
      parseStorageStateObject(pending.value),
    );
  }
}
