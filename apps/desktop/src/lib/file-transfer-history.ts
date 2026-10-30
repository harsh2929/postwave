import {
  type LifecycleIntentKind,
  registerLifecycleGuard,
} from "./lifecycle-coordinator";
import { desktopRouteIdentityScope } from "./desktop-router";
import { registerPrivateSessionReset } from "./private-session-state";
import type {
  TransferDirection,
  TransferPrivacy,
  TransferRecord,
  TransferStatus,
} from "./file-transfer-types";

const LEGACY_STORAGE_KEY = "postwave.desktop.transfer-history.v1";
const STORAGE_PREFIX = "postwave.desktop.transfer-history.v2:";
const MAX_HISTORY = 40;
const MAX_PERSISTED_CHARACTERS = 128 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ACTIVE_STATUSES = new Set<TransferStatus>([
  "picking",
  "reading",
  "downloading",
  "saving",
  "uploading",
]);
const PROCESS_EXIT_INTENTS: readonly LifecycleIntentKind[] = [
  "close-window",
  "quit-app",
  "sign-out",
  "workspace-switch",
  "update-restart",
  "os-shutdown",
];

type TransferAction = "cancel" | "retry" | "reveal";
type ActionHandlers = Partial<
  Record<TransferAction, () => void | Promise<void>>
>;

const subscribers = new Set<() => void>();
const actions = new Map<string, ActionHandlers>();
let records: TransferRecord[] = [];
let sequence = 0;
let lifecycleRegistered = false;
let identityScope: string | null = null;

// The journal deliberately redacts personal/confidential filenames, but even
// structural operation history belongs to the signed-in identity. Clear it at
// sign-out and workspace-switch boundaries so the next client cannot infer the
// previous client's activity from this device.
registerPrivateSessionReset("file-transfer-history", purgeTransferHistory);
purgeLegacyTransferHistory();

/** Bind the journal before an authenticated shell can render it. */
export function configureTransferHistoryIdentity(
  user: string | null | undefined,
  tenant: string | null | undefined,
): void {
  const nextScope = desktopRouteIdentityScope(user, tenant);
  purgeLegacyTransferHistory();
  if (nextScope === identityScope) return;
  identityScope = nextScope;
  records = [];
  actions.clear();
  sequence = 0;
  if (nextScope) {
    purgeForeignTransferHistories(nextScope);
    records = readPersistedHistory(storageKey(nextScope));
  }
  notifySubscribers();
}

function notify(): void {
  persistHistory();
  notifySubscribers();
}

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    try {
      subscriber();
    } catch {
      // A detached or faulty optional view must not interrupt a completed
      // transfer or prevent other subscribers from receiving the update.
    }
  }
}

export function subscribeTransferHistory(callback: () => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function getTransferHistory(): readonly TransferRecord[] {
  return records;
}

export function startTransfer(input: {
  direction: TransferDirection;
  label: string;
  fileName: string;
  privacy: TransferPrivacy;
  status: TransferStatus;
  totalBytes?: number | null;
}): string {
  ensureLifecycleGuard();
  const now = Date.now();
  const id = `transfer-${now.toString(36)}-${(++sequence).toString(36)}`;
  records = [
    {
      id,
      direction: input.direction,
      label: historyLabel(input.label, input.privacy, input.direction),
      fileName: historyName(input.fileName, input.privacy, input.direction),
      privacy: input.privacy,
      status: input.status,
      bytesTransferred: 0,
      totalBytes: finiteBytes(input.totalBytes),
      startedAt: now,
      updatedAt: now,
    },
    ...records,
  ].slice(0, MAX_HISTORY);
  notify();
  return id;
}

export function updateTransfer(
  id: string,
  patch: Partial<
    Pick<
      TransferRecord,
      | "status"
      | "bytesTransferred"
      | "totalBytes"
      | "errorCode"
      | "fileName"
      | "collision"
    >
  >,
): void {
  let changed = false;
  records = records.map((record) => {
    if (record.id !== id) return record;
    changed = true;
    return {
      ...record,
      ...patch,
      bytesTransferred:
        patch.bytesTransferred === undefined
          ? record.bytesTransferred
          : Math.max(0, Math.floor(patch.bytesTransferred)),
      totalBytes:
        patch.totalBytes === undefined
          ? record.totalBytes
          : finiteBytes(patch.totalBytes),
      fileName:
        patch.fileName === undefined
          ? record.fileName
          : historyName(patch.fileName, record.privacy, record.direction),
      errorCode: safeErrorCode(patch.errorCode),
      updatedAt: Date.now(),
    };
  });
  if (changed) notify();
}

export function registerTransferActions(
  id: string,
  handlers: ActionHandlers,
): void {
  const available = Object.fromEntries(
    Object.entries(handlers).filter(
      (entry): entry is [TransferAction, () => void | Promise<void>] =>
        typeof entry[1] === "function",
    ),
  ) as ActionHandlers;
  if (Object.keys(available).length === 0) actions.delete(id);
  else actions.set(id, available);
  for (const staleId of actions.keys()) {
    if (!records.some((record) => record.id === staleId))
      actions.delete(staleId);
  }
  // Actions are transient, but they are part of the Transfer Center's
  // rendered snapshot. Change the array identity so useSyncExternalStore
  // cannot suppress an action-only update as an unchanged snapshot.
  records = [...records];
  notifySubscribers();
}

export function transferActionsFor(id: string): readonly TransferAction[] {
  return Object.keys(actions.get(id) ?? {}) as TransferAction[];
}

export async function runTransferAction(
  id: string,
  action: TransferAction,
): Promise<boolean> {
  const handler = actions.get(id)?.[action];
  if (!handler) return false;
  await handler();
  return true;
}

export function clearFinishedTransferHistory(): void {
  const activeIds = new Set(
    records
      .filter((record) => ACTIVE_STATUSES.has(record.status))
      .map((record) => record.id),
  );
  records = records.filter((record) => activeIds.has(record.id));
  for (const id of actions.keys()) {
    if (!activeIds.has(id)) actions.delete(id);
  }
  notify();
}

function purgeTransferHistory(): void {
  records = [];
  actions.clear();
  sequence = 0;
  identityScope = null;
  purgeForeignTransferHistories(null);
  purgeLegacyTransferHistory();
  for (const subscriber of subscribers) {
    try {
      subscriber();
    } catch {
      // One optional view must not block identity-boundary cleanup.
    }
  }
}

function ensureLifecycleGuard(): void {
  if (lifecycleRegistered) return;
  registerLifecycleGuard({
    id: "file-transfers",
    label: "File transfers",
    // Transfers are process-owned and remain visible in Transfer Center after
    // navigating. They need review only when the process or identity changes.
    kinds: PROCESS_EXIT_INTENTS,
    inspect: (intent) => {
      if (intent.disposition === "hide") return null;
      const active = records.filter((record) =>
        ACTIVE_STATUSES.has(record.status),
      );
      if (active.length === 0) return null;
      return {
        level: "blocking",
        detail: `${active.length} file transfer${active.length === 1 ? " is" : "s are"} still active. Wait for completion or explicitly cancel unfinished work.`,
        canDiscard: true,
      };
    },
    discard: async () => {
      const active = records.filter((record) =>
        ACTIVE_STATUSES.has(record.status),
      );
      await Promise.allSettled(
        active.map(async (record) => {
          await actions.get(record.id)?.cancel?.();
        }),
      );
    },
  });
  lifecycleRegistered = true;
}

function readPersistedHistory(key: string): TransferRecord[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    if (raw.length > MAX_PERSISTED_CHARACTERS) {
      localStorage.removeItem(key);
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      localStorage.removeItem(key);
      return [];
    }
    const cutoff = Date.now() - RETENTION_MS;
    const restored = parsed
      .filter(isTransferRecord)
      .filter((record) => record.updatedAt >= cutoff)
      .map((record) =>
        ACTIVE_STATUSES.has(record.status)
          ? {
              ...record,
              status: "failed" as const,
              errorCode: "interrupted",
              updatedAt: Date.now(),
            }
          : record,
      )
      .slice(0, MAX_HISTORY);
    // Persist only the bounded, retained projection. This removes invalid or
    // expired rows and records interrupted active work exactly once.
    localStorage.setItem(key, JSON.stringify(restored));
    return restored;
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage denial still falls back to an isolated in-memory journal.
    }
    return [];
  }
}

function persistHistory(): void {
  if (typeof localStorage === "undefined" || !identityScope) return;
  try {
    localStorage.setItem(
      storageKey(identityScope),
      JSON.stringify(records.slice(0, MAX_HISTORY)),
    );
  } catch {
    // Storage denial must never turn a completed file operation into failure.
  }
}

function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}${scope}`;
}

function purgeLegacyTransferHistory(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ownership-ambiguous legacy activity is never adopted.
  }
}

function purgeForeignTransferHistories(currentScope: string | null): void {
  if (typeof localStorage === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (
        key?.startsWith(STORAGE_PREFIX) &&
        key !== (currentScope ? storageKey(currentScope) : null)
      ) {
        keys.push(key);
      }
    }
    for (const key of keys) localStorage.removeItem(key);
  } catch {
    // In-memory isolation still succeeds when hardened storage denies access.
  }
}

function isTransferRecord(value: unknown): value is TransferRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<TransferRecord>;
  return (
    boundedText(record.id, 80) &&
    boundedText(record.label, 100) &&
    boundedText(record.fileName, 180) &&
    finiteTimestamp(record.startedAt) &&
    finiteTimestamp(record.updatedAt) &&
    record.updatedAt >= record.startedAt &&
    finiteStoredBytes(record.bytesTransferred) &&
    (record.totalBytes === null || finiteStoredBytes(record.totalBytes)) &&
    (record.errorCode === undefined ||
      (boundedText(record.errorCode, 48) &&
        /^[a-z0-9_-]+$/.test(record.errorCode))) &&
    (record.collision === undefined || typeof record.collision === "boolean") &&
    ["public", "personal", "confidential"].includes(record.privacy ?? "") &&
    ["import", "upload", "download", "export"].includes(
      record.direction ?? "",
    ) &&
    [
      "picking",
      "reading",
      "downloading",
      "saving",
      "uploading",
      "completed",
      "delegated",
      "failed",
      "cancelled",
    ].includes(record.status ?? "")
  );
}

function historyName(
  raw: string,
  privacy: TransferPrivacy,
  direction: TransferDirection,
): string {
  const name = basename(raw);
  if (privacy === "public") return name || "File";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot).toLowerCase().slice(0, 12) : "";
  const label =
    privacy === "confidential" ? "Confidential file" : "Personal data file";
  return `${label}${extension ? ` (${extension})` : ""} · ${direction}`;
}

function historyLabel(
  raw: string,
  privacy: TransferPrivacy,
  direction: TransferDirection,
): string {
  if (privacy === "public") return safeLabel(raw);
  const operation: Record<TransferDirection, string> = {
    import: "import",
    upload: "upload",
    download: "download",
    export: "export",
  };
  return `${privacy === "confidential" ? "Confidential" : "Personal data"} ${operation[direction]}`;
}

function basename(raw: string): string {
  return (raw.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
}

function safeLabel(raw: string): string {
  return (
    raw
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 100) || "File transfer"
  );
}

function finiteBytes(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function safeErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/[^a-z0-9_-]/gi, "_")
    .slice(0, 48)
    .toLowerCase();
}

function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function finiteTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= Date.now() + 24 * 60 * 60 * 1000
  );
}

function finiteStoredBytes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2 * 1024 * 1024 * 1024
  );
}

/** @internal */
export function resetTransferHistoryForTests(): void {
  records = [];
  actions.clear();
  sequence = 0;
  identityScope = null;
  lifecycleRegistered = false;
  purgeForeignTransferHistories(null);
  purgeLegacyTransferHistory();
  notifySubscribers();
}
