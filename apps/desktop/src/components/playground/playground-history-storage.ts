/** Encrypted, identity-owned persistence for API Playground request history. */

import {
  loadSensitiveLocalData,
  saveSensitiveLocalData,
  sensitiveLocalVaultKey,
  type SanitizedLocalData,
} from "../../lib/sensitive-local-data";

export interface HistoryEntry {
  id: string;
  ts: number;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathTemplate: string;
  status: number;
  durationMs: number;
  /** Sanitized transport classification; response bodies and diagnostics stay omitted. */
  outcome: "http" | "aborted" | "timeout" | "network" | "contract" | "unknown";
  /** True when an effect may have committed without a conclusive response. */
  ambiguous: boolean;
  /** Parameter names are useful replay prompts; values are never retained. */
  parameterNamesOmitted?: {
    path?: string[];
    query?: string[];
    header?: string[];
  };
  /** Header names are retained as a reminder; their values are never saved. */
  customHeaderNamesOmitted?: string[];
  /** Bodies are deliberately represented only by their omission flag. */
  body?: "";
  bodyOmitted?: boolean;
}

export type HistoryEntryDraft = Omit<HistoryEntry, "id" | "ts">;

export interface PlaygroundHistoryLoad {
  entries: HistoryEntry[];
  state: "ready" | "unavailable";
  warning: string | null;
  retryable: boolean;
}

interface HistoryEvent {
  error: string | null;
}

const VAULT_NAMESPACE = "api-playground-history-v2";
const RETIRED_VAULT_MARKER = "sensitive-local.v1.api-playground-history.";
const LEGACY_PREFIX = "pw_playground_history__";
const HISTORY_LIMIT = 50;
const HISTORY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_FUTURE_SKEW_MS = 5 * 60 * 1000;
const HISTORY_MAX_BYTES = 128 * 1024;
const METHODS = new Set<HistoryEntry["method"]>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const OUTCOMES = new Set<HistoryEntry["outcome"]>([
  "http",
  "aborted",
  "timeout",
  "network",
  "contract",
  "unknown",
]);
const ID_RE = /^[a-zA-Z0-9-]{1,80}$/u;
const IDENTITY_SCOPE_RE = /^[a-f0-9]{16}$/u;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const listeners = new Map<string, Set<(event: HistoryEvent) => void>>();
const writeQueues = new Map<string, Promise<unknown>>();

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function sanitizedNames(candidate: unknown): string[] | null {
  if (candidate === undefined) return [];
  if (!Array.isArray(candidate) || candidate.length > 48) return null;
  const values = [
    ...new Set(
      candidate.filter(
        (value): value is string =>
          boundedString(value, 160) && value.length > 0,
      ),
    ),
  ];
  return values.length === candidate.length ? values : null;
}

function sanitizeParameterNames(
  candidate: unknown,
): HistoryEntry["parameterNamesOmitted"] | null {
  if (candidate === undefined) return {};
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const raw = candidate as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => !["path", "query", "header"].includes(key))
  ) {
    return null;
  }
  const path = sanitizedNames(raw.path);
  const query = sanitizedNames(raw.query);
  const header = sanitizedNames(raw.header);
  if (!path || !query || !header) return null;
  return {
    ...(path.length > 0 ? { path } : {}),
    ...(query.length > 0 ? { query } : {}),
    ...(header.length > 0 ? { header } : {}),
  };
}

function sanitizeHistoryEntry(
  candidate: unknown,
  now: number,
): HistoryEntry | null {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const raw = candidate as Partial<HistoryEntry>;
  const parameterNamesOmitted = sanitizeParameterNames(
    raw.parameterNamesOmitted,
  );
  const inferredOutcome: HistoryEntry["outcome"] =
    raw.status === 0 ? "unknown" : "http";
  const outcome =
    typeof raw.outcome === "string" &&
    OUTCOMES.has(raw.outcome as HistoryEntry["outcome"])
      ? (raw.outcome as HistoryEntry["outcome"])
      : raw.outcome === undefined
        ? inferredOutcome
        : null;
  const inferredAmbiguous =
    raw.method !== "GET" &&
    (raw.status === 0 ||
      raw.status === 408 ||
      raw.status === 429 ||
      (typeof raw.status === "number" && raw.status >= 500));
  const ambiguous =
    typeof raw.ambiguous === "boolean"
      ? raw.ambiguous
      : raw.ambiguous === undefined
        ? inferredAmbiguous
        : null;
  if (
    typeof raw.id !== "string" ||
    !ID_RE.test(raw.id) ||
    typeof raw.ts !== "number" ||
    !Number.isSafeInteger(raw.ts) ||
    raw.ts < now - HISTORY_TTL_MS ||
    raw.ts > now + HISTORY_FUTURE_SKEW_MS ||
    typeof raw.method !== "string" ||
    !METHODS.has(raw.method as HistoryEntry["method"]) ||
    !boundedString(raw.pathTemplate, 2_048) ||
    !raw.pathTemplate.startsWith("/") ||
    typeof raw.status !== "number" ||
    !Number.isInteger(raw.status) ||
    (raw.status !== 0 && (raw.status < 100 || raw.status > 599)) ||
    typeof raw.durationMs !== "number" ||
    !Number.isInteger(raw.durationMs) ||
    raw.durationMs < 0 ||
    raw.durationMs > 86_400_000 ||
    !outcome ||
    ambiguous === null ||
    (raw.body !== undefined && raw.body !== "") ||
    !parameterNamesOmitted
  ) {
    return null;
  }
  const customHeaderNamesOmitted = Array.isArray(raw.customHeaderNamesOmitted)
    ? [...new Set(raw.customHeaderNamesOmitted)].filter(
        (name): name is string =>
          typeof name === "string" && HEADER_NAME_RE.test(name),
      )
    : [];
  if (customHeaderNamesOmitted.length > 32) return null;
  return {
    id: raw.id,
    ts: raw.ts,
    method: raw.method as HistoryEntry["method"],
    pathTemplate: raw.pathTemplate,
    status: raw.status,
    durationMs: raw.durationMs,
    outcome,
    ambiguous,
    ...(Object.keys(parameterNamesOmitted).length > 0
      ? { parameterNamesOmitted }
      : {}),
    ...(customHeaderNamesOmitted.length > 0
      ? { customHeaderNamesOmitted }
      : {}),
    ...(raw.body === "" ? { body: "" as const } : {}),
    ...(raw.bodyOmitted === true ? { bodyOmitted: true } : {}),
  };
}

export function sanitizePlaygroundHistory(
  candidate: unknown,
  now = Date.now(),
): SanitizedLocalData<HistoryEntry[]> | null {
  if (!Array.isArray(candidate)) return null;
  const entries: HistoryEntry[] = [];
  const ids = new Set<string>();
  let altered = false;
  for (const raw of candidate.slice(0, HISTORY_LIMIT * 2)) {
    const entry = sanitizeHistoryEntry(raw, now);
    if (!entry || ids.has(entry.id)) {
      altered = true;
      continue;
    }
    ids.add(entry.id);
    entries.push(entry);
    try {
      altered ||= JSON.stringify(raw) !== JSON.stringify(entry);
    } catch {
      altered = true;
    }
  }
  const bounded = entries.slice(0, HISTORY_LIMIT);
  altered ||= bounded.length !== candidate.length;
  while (
    bounded.length > 0 &&
    new TextEncoder().encode(JSON.stringify(bounded)).byteLength >
      HISTORY_MAX_BYTES
  ) {
    bounded.pop();
    altered = true;
  }
  return { value: bounded, altered };
}

function purgeLegacyHistory(): { warning: string | null; retryable: boolean } {
  const keys: string[] = [];
  let failed = false;
  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key?.startsWith(LEGACY_PREFIX) ||
        key?.includes(RETIRED_VAULT_MARKER)
      ) {
        keys.push(key);
      }
    }
  } catch {
    failed = true;
  }
  for (const key of keys) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      failed = true;
    }
  }
  return {
    warning: failed
      ? "A retired value-bearing history copy could not be removed from device storage."
      : keys.length > 0
        ? "A retired value-bearing history format was removed without reading or importing it."
        : null,
    retryable: failed,
  };
}

function combineWarnings(...warnings: Array<string | null>): string | null {
  return warnings.filter(Boolean).join(" ") || null;
}

export async function loadPlaygroundHistory(
  identityScope: string | null,
): Promise<PlaygroundHistoryLoad> {
  const legacy = purgeLegacyHistory();
  if (identityScope && !IDENTITY_SCOPE_RE.test(identityScope)) {
    return {
      entries: [],
      state: "unavailable",
      warning: combineWarnings(
        "Encrypted request history is unavailable because the signed-in workspace scope is invalid.",
        legacy.warning,
      ),
      retryable: legacy.retryable,
    };
  }
  const loaded = await loadSensitiveLocalData({
    identityScope,
    namespace: VAULT_NAMESPACE,
    fallback: [] as HistoryEntry[],
    validate: sanitizePlaygroundHistory,
  });
  return {
    entries: loaded.value,
    state: loaded.state,
    warning: combineWarnings(loaded.warning, legacy.warning),
    retryable: loaded.retryable || legacy.retryable,
  };
}

function broadcast(identityScope: string, event: HistoryEvent): void {
  for (const listener of listeners.get(identityScope) ?? []) {
    try {
      listener(event);
    } catch {
      /* A broken view must not starve other same-scope subscribers. */
    }
  }
}

function enqueue<T>(identityScope: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(identityScope) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(identityScope, next);
  void next.then(
    () => {
      if (writeQueues.get(identityScope) === next)
        writeQueues.delete(identityScope);
    },
    () => {
      if (writeQueues.get(identityScope) === next)
        writeQueues.delete(identityScope);
    },
  );
  return next;
}

async function replaceHistory(
  identityScope: string | null,
  update: (entries: HistoryEntry[]) => HistoryEntry[],
): Promise<HistoryEntry[]> {
  if (!identityScope || !IDENTITY_SCOPE_RE.test(identityScope)) {
    throw new Error("Signed-in workspace identity is unavailable.");
  }
  return enqueue(identityScope, async () => {
    const loaded = await loadPlaygroundHistory(identityScope);
    if (loaded.state === "unavailable") {
      throw new Error("Encrypted request history is temporarily unavailable.");
    }
    const sanitized = sanitizePlaygroundHistory(update(loaded.entries));
    if (!sanitized) throw new Error("Request history is invalid.");
    const saved = await saveSensitiveLocalData({
      identityScope,
      namespace: VAULT_NAMESPACE,
      validate: sanitizePlaygroundHistory,
      value: sanitized.value,
    });
    broadcast(identityScope, { error: null });
    return saved;
  }).catch((error: unknown) => {
    broadcast(identityScope, {
      error:
        "The history update could not be encrypted on this device. Existing encrypted history was left unchanged; restore keychain or storage access and retry.",
    });
    throw error;
  });
}

function createHistoryId(now: number): string {
  const random =
    globalThis.crypto?.randomUUID?.().replaceAll("-", "") ??
    Math.random().toString(36).slice(2, 14);
  return `${now.toString(36)}-${random.slice(0, 32)}`;
}

export async function recordHistoryEntry(
  identityScope: string | null,
  draft: HistoryEntryDraft,
): Promise<void> {
  const now = Date.now();
  const entry = sanitizeHistoryEntry(
    { ...draft, id: createHistoryId(now), ts: now },
    now,
  );
  if (!entry) throw new Error("Request history entry is invalid.");
  await replaceHistory(identityScope, (entries) => [entry, ...entries]);
}

export async function clearHistory(
  identityScope: string | null,
): Promise<void> {
  await replaceHistory(identityScope, () => []);
}

export async function removeHistoryEntry(
  identityScope: string | null,
  id: string,
): Promise<void> {
  if (!ID_RE.test(id)) throw new Error("History entry identifier is invalid.");
  await replaceHistory(identityScope, (entries) =>
    entries.filter((entry) => entry.id !== id),
  );
}

export function subscribeToPlaygroundHistory(
  identityScope: string,
  listener: (event: HistoryEvent) => void,
): () => void {
  const scoped = listeners.get(identityScope) ?? new Set();
  scoped.add(listener);
  listeners.set(identityScope, scoped);
  return () => {
    scoped.delete(listener);
    if (scoped.size === 0) listeners.delete(identityScope);
  };
}

export function isPlaygroundHistoryStorageEvent(
  key: string | null,
  identityScope: string,
): boolean {
  return (
    !!key &&
    IDENTITY_SCOPE_RE.test(identityScope) &&
    key.endsWith(sensitiveLocalVaultKey(VAULT_NAMESPACE, identityScope))
  );
}
