import type { OfflineMutationAuthScope } from "./offlineMutationContract";
import {
  vaultDelete,
  vaultGetJSON,
  vaultScopeForClient,
  vaultSetJSON,
} from "./secureVault";

const FAILURE_RECORD_ID = "records";
const MAX_FAILURES = 20;
const FAILURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type OfflineMutationFailureKind =
  | "campaign_update"
  | "sequence_create"
  | "sequence_save"
  | "entity_write";

export interface OfflineMutationFailure {
  id: string;
  operationId: string;
  tenantId: string;
  baseUrl: string;
  principalId: string;
  role: string;
  kind: OfflineMutationFailureKind;
  label: string;
  message: string;
  failedAt: string;
}

type Listener = () => void;
const listeners = new Set<Listener>();
let writeChain: Promise<void> = Promise.resolve();

function serializeWrite(operation: () => Promise<void>): Promise<void> {
  const task = writeChain.then(operation, operation);
  writeChain = task.catch(() => undefined);
  return task;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * The code `SequenceSaveAuthorityError` carries (lib/offlineMutations.ts).
 *
 * DUPLICATED AS A LITERAL ON PURPOSE. `offlineMutations` imports THIS module,
 * so importing `isSequenceSaveAuthorityError` back would close a cycle. The
 * two literals are pinned against each other in
 * lib/offlineMutationFailures.test.ts.
 */
const SEQUENCE_RELOAD_CODE = "sequence_save_requires_reload";

// Error text from providers/server responses can contain customer content.
// Persist only an allowlisted operational category suitable for a shared UI.
function safeMessage(error: unknown): string {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (status === 401 || status === 403) {
    return "Authorization changed. Sign in again before retrying.";
  }
  // A VERSION CONFLICT REACHED THE QUEUE AS A GENERIC FAILURE. `executeSequenceSave`
  // catches the 412 itself, locks the version key, and rethrows a
  // `SequenceSaveAuthorityError` — which is a plain Error with no `status`, so
  // it fell past both branches below and was filed as "The server could not
  // sync this queued change." That is the one failure in this list whose cause
  // the app knows exactly and whose remedy is a specific action, and the
  // reader was told the opposite: that something unspecified went wrong.
  //
  // The remedy is named rather than offered as a "keep mine" button on
  // purpose. The queued edit is a whole step list authored against an older
  // revision; re-applying it over a newer one without showing the reader what
  // changed is precisely the silent overwrite the version check exists to
  // prevent. Opening the sequence re-seeds authority
  // (`acceptFetchedSequenceVersion`) and unlocks saving.
  if (code === SEQUENCE_RELOAD_CODE) {
    return "This sequence changed elsewhere. Open the sequence to load the latest version, then re-apply this change.";
  }
  if (status === 409 || status === 412) {
    return "A newer server version conflicts with this queued change. Open the record to load the latest version before retrying.";
  }
  if (status === 429) {
    return "Sync was rate limited. Review the change before retrying.";
  }
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  if (name.includes("network") || name.includes("timeout")) {
    return "The connection ended before this change could sync.";
  }
  return "The server could not sync this queued change.";
}

function safeLabel(kind: OfflineMutationFailureKind): string {
  switch (kind) {
    case "campaign_update":
      return "Campaign edit";
    case "sequence_create":
      return "New sequence";
    case "sequence_save":
      return "Sequence changes";
    // The generic queue carries no entity-specific label of its own; the
    // caller's bounded label is applied by recordOfflineMutationFailure.
    case "entity_write":
      return "Queued edit";
  }
}

function failureScope(auth: OfflineMutationAuthScope): string {
  return vaultScopeForClient({
    baseUrl: auth.baseUrl,
    tenantId: auth.tenantId,
    userId: auth.principalId,
    role: auth.role,
  });
}

function parseFailures(value: unknown): OfflineMutationFailure[] {
  if (!Array.isArray(value)) return [];
  const cutoff = Date.now() - FAILURE_TTL_MS;
  return value
    .filter((item): item is OfflineMutationFailure => {
      if (!item || typeof item !== "object") return false;
      const row = item as Partial<OfflineMutationFailure>;
      const failedAt =
        typeof row.failedAt === "string" ? Date.parse(row.failedAt) : NaN;
      return Boolean(
        typeof row.id === "string" &&
        typeof row.operationId === "string" &&
        typeof row.tenantId === "string" &&
        typeof row.baseUrl === "string" &&
        typeof row.principalId === "string" &&
        typeof row.role === "string" &&
        typeof row.kind === "string" &&
        typeof row.label === "string" &&
        typeof row.message === "string" &&
        Number.isFinite(failedAt) &&
        failedAt >= cutoff,
      );
    })
    .slice(0, MAX_FAILURES);
}

export async function listOfflineMutationFailures(
  auth: OfflineMutationAuthScope,
): Promise<OfflineMutationFailure[]> {
  await writeChain;
  const all = parseFailures(
    await vaultGetJSON<unknown>("offline-failure", FAILURE_RECORD_ID, {
      scope: failureScope(auth),
    }),
  );
  return all.filter(
    (row) =>
      row.tenantId === auth.tenantId &&
      row.baseUrl === auth.baseUrl &&
      row.principalId === auth.principalId &&
      row.role === auth.role,
  );
}

export function recordOfflineMutationFailure(input: {
  auth: OfflineMutationAuthScope;
  kind: OfflineMutationFailureKind;
  label: string;
  operationId: string;
  error: unknown;
}): Promise<void> {
  const record: OfflineMutationFailure = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    operationId: input.operationId,
    tenantId: input.auth.tenantId,
    baseUrl: input.auth.baseUrl,
    principalId: input.auth.principalId,
    role: input.auth.role,
    kind: input.kind,
    label: safeLabel(input.kind),
    message: safeMessage(input.error),
    failedAt: new Date().toISOString(),
  };
  const scope = failureScope(input.auth);
  return serializeWrite(async () => {
    const current = parseFailures(
      await vaultGetJSON<unknown>("offline-failure", FAILURE_RECORD_ID, {
        scope,
      }),
    );
    await vaultSetJSON(
      "offline-failure",
      FAILURE_RECORD_ID,
      [record, ...current].slice(0, MAX_FAILURES),
      { scope, ttlMs: FAILURE_TTL_MS },
    );
    notify();
  });
}

export function clearOfflineMutationFailures(
  auth: OfflineMutationAuthScope,
): Promise<void> {
  return serializeWrite(async () => {
    await vaultDelete("offline-failure", FAILURE_RECORD_ID, {
      scope: failureScope(auth),
    });
    notify();
  });
}

export function subscribeOfflineMutationFailures(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const offlineMutationFailurePolicy = {
  maxRecords: MAX_FAILURES,
  ttlMs: FAILURE_TTL_MS,
  storesRawErrors: false,
} as const;

/**
 * Content equality for the failure journal.
 *
 * Same reason as `sameQueue` in offlineMutationQueue.ts: the journal read
 * returns a fresh array, and setting it unconditionally re-rendered the banner
 * on every refresh. Failures are immutable once written, so `id` alone would
 * very nearly do -- but comparing the fields the banner actually READS means a
 * future in-place edit cannot leave stale copy on an alert the user is looking
 * at.
 */
export function sameFailures(
  a: readonly OfflineMutationFailure[],
  b: readonly OfflineMutationFailure[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (!x || !y) return false;
    if (
      x.id !== y.id ||
      x.operationId !== y.operationId ||
      x.kind !== y.kind ||
      x.label !== y.label ||
      x.message !== y.message ||
      x.failedAt !== y.failedAt
    ) {
      return false;
    }
  }
  return true;
}
