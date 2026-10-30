import {
  vaultDelete,
  vaultReadJSON,
  vaultSetJSON,
  type VaultReadResult,
} from "../../lib/secure-vault";
import {
  createSMSReplyIntentKey,
  isCanonicalSMSUSCA,
  type SMSReplyRequest,
} from "./sms-reply-intent";

const STORAGE_VERSION = 1;
const MAX_INTENTS_PER_IDENTITY = 32;
export const SMS_REPLY_RECOVERY_CHANGE_EVENT =
  "postwave:sms-reply-recovery-change";

interface StoredSMSReplyIntent {
  signature: string;
  phone: string;
  idempotencyKey: string;
  runtimeId: string;
  state:
    | "prepared"
    | "unknown"
    | "request-identity-conflict"
    | "another-intent-pending";
  createdAt: string;
  updatedAt: string;
}

interface StoredSMSReplyIntentEnvelope {
  version: typeof STORAGE_VERSION;
  intents: StoredSMSReplyIntent[];
}

interface StoredSMSReplyQuarantineEnvelope {
  version: typeof STORAGE_VERSION;
  quarantined: "corrupt-reply-intent-vault";
}

export interface SMSReplyIntentInput {
  phone: string;
  request: SMSReplyRequest;
}

export interface SMSReplyRecoverySummary {
  signature: string;
  phone: string;
  idempotencyKey: string;
  state: StoredSMSReplyIntent["state"];
  createdAt: string;
}

export type SMSReplyPrepareResult =
  | {
      status: "ready";
      signature: string;
      idempotencyKey: string;
      recovered: boolean;
    }
  | {
      status: "held";
      signature?: string;
      idempotencyKey?: string;
      reason:
        | "identity-unresolved"
        | "vault-unavailable"
        | "vault-corrupt"
        | "recovered-after-restart"
        | "outcome-unknown"
        | "intent-capacity-reached"
        | "checkpoint-update-failed"
        | "checkpoint-clear-failed"
        | "request-identity-conflict"
        | "another-intent-pending";
    };

interface SMSReplyRecoveryVault {
  read<T>(key: string): Promise<VaultReadResult<T>>;
  write(key: string, value: unknown): Promise<void>;
  remove(key: string): void;
  quarantineStatus(key: string): "clear" | "marked" | "unavailable";
  markQuarantined(key: string): boolean;
}

interface SMSReplyRecoveryOptions {
  runtimeId: string;
  now?: () => number;
  createKey?: () => string;
  vault: SMSReplyRecoveryVault;
}

function storageKey(identityScope: string): string {
  return `sms-reply-intents.${identityScope}`;
}

const QUARANTINE_STORAGE_PREFIX =
  "postwave.desktop.vault.v1:quarantine:sms-reply-intents:";
const QUARANTINE_STORAGE_VALUE = "corrupt-reply-intent-vault";

function validIntent(value: unknown): value is StoredSMSReplyIntent {
  if (!value || typeof value !== "object") return false;
  const intent = value as Partial<StoredSMSReplyIntent>;
  return (
    typeof intent.signature === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(intent.signature) &&
    typeof intent.phone === "string" &&
    isCanonicalSMSUSCA(intent.phone) &&
    typeof intent.idempotencyKey === "string" &&
    intent.idempotencyKey.length > 0 &&
    new TextEncoder().encode(intent.idempotencyKey).byteLength <= 255 &&
    typeof intent.runtimeId === "string" &&
    intent.runtimeId.length > 0 &&
    (intent.state === "prepared" ||
      intent.state === "unknown" ||
      intent.state === "request-identity-conflict" ||
      intent.state === "another-intent-pending") &&
    typeof intent.createdAt === "string" &&
    Number.isFinite(Date.parse(intent.createdAt)) &&
    typeof intent.updatedAt === "string" &&
    Number.isFinite(Date.parse(intent.updatedAt))
  );
}

function parseEnvelope(
  result: VaultReadResult<unknown>,
):
  | { status: "ready"; value: StoredSMSReplyIntentEnvelope }
  | { status: "missing" }
  | { status: "unavailable" }
  | { status: "corrupt"; quarantined: boolean } {
  if (result.status === "corrupt") {
    return { status: "corrupt", quarantined: false };
  }
  if (result.status !== "ready") return result;
  const value = result.value as Partial<StoredSMSReplyIntentEnvelope> & {
    quarantined?: unknown;
  };
  if (
    value.version === STORAGE_VERSION &&
    value.quarantined === "corrupt-reply-intent-vault" &&
    Object.keys(value).length === 2
  ) {
    return { status: "corrupt", quarantined: true };
  }
  if (
    Object.keys(value).some((key) => key !== "version" && key !== "intents") ||
    value.version !== STORAGE_VERSION ||
    !Array.isArray(value.intents) ||
    !value.intents.every(validIntent)
  ) {
    return { status: "corrupt", quarantined: false };
  }
  return {
    status: "ready",
    value: { version: STORAGE_VERSION, intents: value.intents },
  };
}

async function intentSignature(input: SMSReplyIntentInput): Promise<string> {
  const canonical = JSON.stringify({
    phone: input.phone,
    senderProfileId: input.request.sender_profile_id,
    body: input.request.body,
    mediaUrl: input.request.media_url ?? "",
    listId: input.request.list_id ?? "",
  });
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest))
    binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function createSMSReplyRecoveryStore({
  runtimeId,
  now = Date.now,
  createKey = createSMSReplyIntentKey,
  vault,
}: SMSReplyRecoveryOptions) {
  const notifyChanged = (): void => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event(SMS_REPLY_RECOVERY_CHANGE_EVENT));
    }
  };
  const read = async (
    identityScope: string,
  ): Promise<ReturnType<typeof parseEnvelope>> => {
    const key = storageKey(identityScope);
    const quarantineStatus = vault.quarantineStatus(key);
    if (quarantineStatus === "marked") {
      return { status: "corrupt", quarantined: true };
    }
    if (quarantineStatus === "unavailable") return { status: "unavailable" };
    const parsed = parseEnvelope(await vault.read<unknown>(key));
    if (parsed.status !== "corrupt" || parsed.quarantined) return parsed;
    // `vaultReadJSON` removes ciphertext it can prove is corrupt. Record a
    // separate, non-secret quarantine bit before relying on another encrypted
    // write, so a transient keychain/sealing failure cannot turn the next
    // reload into a clean-looking empty vault and mint a replacement key.
    const markerWritten = vault.markQuarantined(key);
    try {
      await vault.write(key, {
        version: STORAGE_VERSION,
        quarantined: "corrupt-reply-intent-vault",
      } satisfies StoredSMSReplyQuarantineEnvelope);
      notifyChanged();
      return { status: "corrupt", quarantined: true };
    } catch {
      return markerWritten
        ? { status: "corrupt", quarantined: true }
        : { status: "unavailable" };
    }
  };

  const write = async (
    identityScope: string,
    intents: StoredSMSReplyIntent[],
  ): Promise<void> => {
    if (intents.length === 0) {
      vault.remove(storageKey(identityScope));
      notifyChanged();
      return;
    }
    await vault.write(storageKey(identityScope), {
      version: STORAGE_VERSION,
      intents,
    } satisfies StoredSMSReplyIntentEnvelope);
    notifyChanged();
  };

  const prepare = async (
    identityScope: string | null,
    input: SMSReplyIntentInput,
  ): Promise<SMSReplyPrepareResult> => {
    if (!identityScope)
      return { status: "held", reason: "identity-unresolved" };
    const signature = await intentSignature(input);
    const envelope = await read(identityScope);
    if (envelope.status === "unavailable") {
      return { status: "held", signature, reason: "vault-unavailable" };
    }
    if (envelope.status === "corrupt") {
      return { status: "held", signature, reason: "vault-corrupt" };
    }
    const intents = envelope.status === "ready" ? envelope.value.intents : [];
    const existing = intents.find((intent) => intent.signature === signature);
    if (existing) {
      if (existing.state === "unknown") {
        return {
          status: "held",
          signature,
          idempotencyKey: existing.idempotencyKey,
          reason: "outcome-unknown",
        };
      }
      if (existing.state === "request-identity-conflict") {
        return {
          status: "held",
          signature,
          idempotencyKey: existing.idempotencyKey,
          reason: "request-identity-conflict",
        };
      }
      if (existing.state === "another-intent-pending") {
        return {
          status: "held",
          signature,
          idempotencyKey: existing.idempotencyKey,
          reason: "another-intent-pending",
        };
      }
      return {
        status: "held",
        signature,
        idempotencyKey: existing.idempotencyKey,
        reason:
          existing.runtimeId === runtimeId
            ? "outcome-unknown"
            : "recovered-after-restart",
      };
    }
    const unresolvedForPhone = intents.find(
      (intent) => intent.phone === input.phone,
    );
    if (unresolvedForPhone) {
      return {
        status: "held",
        signature: unresolvedForPhone.signature,
        idempotencyKey: unresolvedForPhone.idempotencyKey,
        reason: "another-intent-pending",
      };
    }
    if (intents.length >= MAX_INTENTS_PER_IDENTITY) {
      return { status: "held", signature, reason: "intent-capacity-reached" };
    }
    const timestamp = new Date(now()).toISOString();
    const created: StoredSMSReplyIntent = {
      signature,
      phone: input.phone,
      idempotencyKey: createKey(),
      runtimeId,
      state: "prepared",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await write(identityScope, [...intents, created]);
    } catch {
      return { status: "held", signature, reason: "vault-unavailable" };
    }
    return {
      status: "ready",
      signature,
      idempotencyKey: created.idempotencyKey,
      recovered: false,
    };
  };

  const mutate = async (
    identityScope: string | null,
    transform: (intents: StoredSMSReplyIntent[]) => StoredSMSReplyIntent[],
  ): Promise<boolean> => {
    if (!identityScope) return false;
    const envelope = await read(identityScope);
    if (envelope.status !== "ready") return envelope.status === "missing";
    const before = envelope.value.intents;
    const after = transform(before);
    if (
      after.length === before.length &&
      after.every((intent, index) => intent === before[index])
    ) {
      return false;
    }
    try {
      await write(identityScope, after);
      return true;
    } catch {
      return false;
    }
  };

  return {
    prepare,
    markUnknown: (
      identityScope: string | null,
      signature: string,
    ): Promise<boolean> =>
      mutate(identityScope, (intents) =>
        intents.map((intent) =>
          intent.signature === signature
            ? {
                ...intent,
                state: "unknown",
                updatedAt: new Date(now()).toISOString(),
              }
            : intent,
        ),
      ),
    markRequestIdentityConflict: (
      identityScope: string | null,
      signature: string,
    ): Promise<boolean> =>
      mutate(identityScope, (intents) =>
        intents.map((intent) =>
          intent.signature === signature
            ? {
                ...intent,
                state: "request-identity-conflict",
                updatedAt: new Date(now()).toISOString(),
              }
            : intent,
        ),
      ),
    markAnotherIntentPending: (
      identityScope: string | null,
      signature: string,
    ): Promise<boolean> =>
      mutate(identityScope, (intents) =>
        intents.map((intent) =>
          intent.signature === signature
            ? {
                ...intent,
                state: "another-intent-pending",
                updatedAt: new Date(now()).toISOString(),
              }
            : intent,
        ),
      ),
    settle: (
      identityScope: string | null,
      signature: string,
    ): Promise<boolean> =>
      mutate(identityScope, (intents) =>
        intents.filter((intent) => intent.signature !== signature),
      ),
    list: async (
      identityScope: string | null,
    ): Promise<
      | { status: "ready"; intents: SMSReplyRecoverySummary[] }
      | {
          status: "identity-unresolved" | "vault-unavailable" | "vault-corrupt";
        }
    > => {
      if (!identityScope) return { status: "identity-unresolved" };
      const envelope = await read(identityScope);
      if (envelope.status === "unavailable")
        return { status: "vault-unavailable" };
      if (envelope.status === "corrupt") return { status: "vault-corrupt" };
      const intents = envelope.status === "ready" ? envelope.value.intents : [];
      return {
        status: "ready",
        intents: intents.map((intent) => ({
          signature: intent.signature,
          phone: intent.phone,
          idempotencyKey: intent.idempotencyKey,
          state: intent.state,
          createdAt: intent.createdAt,
        })),
      };
    },
  };
}

const runtimeId = createSMSReplyIntentKey();

export const smsReplyRecovery = createSMSReplyRecoveryStore({
  runtimeId,
  vault: {
    read: vaultReadJSON,
    write: vaultSetJSON,
    remove: vaultDelete,
    quarantineStatus: (key) => {
      if (typeof window === "undefined") return "unavailable";
      try {
        return window.localStorage.getItem(
          `${QUARANTINE_STORAGE_PREFIX}${key}`,
        ) === QUARANTINE_STORAGE_VALUE
          ? "marked"
          : "clear";
      } catch {
        return "unavailable";
      }
    },
    markQuarantined: (key) => {
      if (typeof window === "undefined") return false;
      try {
        window.localStorage.setItem(
          `${QUARANTINE_STORAGE_PREFIX}${key}`,
          QUARANTINE_STORAGE_VALUE,
        );
        return true;
      } catch {
        return false;
      }
    },
  },
});
