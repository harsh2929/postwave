import criticalNoticeCatalog from "./toast-critical-notice-catalog.json";

const STORAGE_KEY = "postwave.desktop.critical-notices.v1";
const STORE_VERSION = 1 as const;
const MAX_PERSISTED_NOTICES = 3;
const MAX_NOTICE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export type CriticalNoticeCode = keyof typeof criticalNoticeCatalog;

export interface CriticalNoticeCopy {
  message: string;
  detail: string;
}

export interface PersistedCriticalNotice {
  code: CriticalNoticeCode;
  raisedAt: number;
}

interface CriticalNoticeEnvelope {
  version: typeof STORE_VERSION;
  notices: PersistedCriticalNotice[];
}

function isCriticalNoticeCode(value: unknown): value is CriticalNoticeCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(criticalNoticeCatalog, value)
  );
}

function sanitizeNotice(
  value: unknown,
  now: number,
): PersistedCriticalNotice | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { code?: unknown; raisedAt?: unknown };
  if (
    !isCriticalNoticeCode(candidate.code) ||
    typeof candidate.raisedAt !== "number" ||
    !Number.isSafeInteger(candidate.raisedAt) ||
    candidate.raisedAt < now - MAX_NOTICE_AGE_MS ||
    candidate.raisedAt > now + MAX_FUTURE_SKEW_MS
  ) {
    return null;
  }
  return { code: candidate.code, raisedAt: candidate.raisedAt };
}

function sanitizeNotices(
  value: unknown,
  now: number,
): PersistedCriticalNotice[] {
  if (!value || typeof value !== "object") return [];
  const envelope = value as { version?: unknown; notices?: unknown };
  if (envelope.version !== STORE_VERSION || !Array.isArray(envelope.notices)) {
    return [];
  }
  const newestByCode = new Map<CriticalNoticeCode, PersistedCriticalNotice>();
  for (const entry of envelope.notices) {
    const notice = sanitizeNotice(entry, now);
    if (!notice) continue;
    const previous = newestByCode.get(notice.code);
    if (!previous || previous.raisedAt < notice.raisedAt) {
      newestByCode.set(notice.code, notice);
    }
  }
  return [...newestByCode.values()]
    .sort((left, right) => left.raisedAt - right.raisedAt)
    .slice(-MAX_PERSISTED_NOTICES);
}

function writeNotices(notices: readonly PersistedCriticalNotice[]): void {
  if (typeof window === "undefined") return;
  try {
    if (notices.length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const envelope: CriticalNoticeEnvelope = {
      version: STORE_VERSION,
      notices: [...notices].slice(-MAX_PERSISTED_NOTICES),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // A denied/full local store must not hide the in-process critical notice.
  }
}

/**
 * Return the fixed, reviewed copy for a critical code. Callers cannot provide
 * arbitrary text to the durable notice path.
 */
export function getCriticalNoticeCopy(
  code: CriticalNoticeCode,
): CriticalNoticeCopy {
  return criticalNoticeCatalog[code];
}

/**
 * Hydrate a bounded, schema-validated code-only journal. Invalid, stale and
 * unknown entries are discarded and the sanitized envelope is rewritten.
 */
export function loadPersistedCriticalNotices(
  now = Date.now(),
): PersistedCriticalNotice[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const notices = sanitizeNotices(JSON.parse(raw) as unknown, now);
    writeNotices(notices);
    return notices;
  } catch {
    writeNotices([]);
    return [];
  }
}

/** Pure presence probe for UI-priority policies; never rewrites storage. */
export function hasPersistedCriticalNotices(now = Date.now()): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeNotices(JSON.parse(raw) as unknown, now).length > 0 : false;
  } catch {
    return false;
  }
}

/** Persist one catalog code. No user/server-provided message is accepted. */
export function persistCriticalNotice(code: CriticalNoticeCode): void {
  const raisedAt = Date.now();
  const notices = loadPersistedCriticalNotices(raisedAt).filter(
    (notice) => notice.code !== code,
  );
  notices.push({ code, raisedAt });
  writeNotices(notices.slice(-MAX_PERSISTED_NOTICES));
}

/** Remove a resolved or explicitly dismissed critical code. */
export function removePersistedCriticalNotice(
  code: CriticalNoticeCode,
): void {
  writeNotices(
    loadPersistedCriticalNotices().filter((notice) => notice.code !== code),
  );
}

/** @internal Test isolation; production code resolves individual codes. */
export function clearPersistedCriticalNoticesForTests(): void {
  writeNotices([]);
}

/** @internal Contract tests inspect the serialized privacy boundary. */
export const criticalNoticeStorageKeyForTests = STORAGE_KEY;
