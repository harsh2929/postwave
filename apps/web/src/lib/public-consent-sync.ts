// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Durable browser-to-ledger delivery for cookie-consent decisions.
 *
 * A consent click is persisted before the network boundary and every retry
 * keeps the same Idempotency-Key. A valid pending decision is removed only
 * after the API returns the exact reviewed 202 response contract. Conflicts
 * and permanent failures remain as bounded terminal records so neither a
 * reload nor an eager fallback can silently mint a second identity.
 */

export type PublicConsentChoice = "accept" | "reject" | "custom" | "gpc";

export interface PublicConsentPrefs {
  essential: true;
  analytics: boolean;
  marketing: boolean;
}

export interface PublicConsentSyncConfig {
  siteKey: string;
  endpoint: string;
}

type PendingStatus =
  | "pending"
  | "conflict"
  | "failed"
  | "configuration_mismatch";

export interface PendingPublicConsentDecision {
  schemaVersion: 2;
  idempotencyKey: string;
  siteKey: string;
  endpoint: string;
  visitorId: string;
  choice: PublicConsentChoice;
  prefs: PublicConsentPrefs;
  policyVersion: string;
  queuedAt: number;
  attempts: number;
  retryAt: number;
  status: PendingStatus;
}

interface PendingStore {
  schema_version: 2;
  items: PendingPublicConsentDecision[];
  blocked: boolean;
  serializedBytes: number;
}

export type PublicConsentSyncState =
  | "queued"
  | "synced"
  | "retrying"
  | "conflict"
  | "failed"
  | "queue_full"
  | "storage_unavailable"
  | "storage_corrupt"
  | "configuration_mismatch"
  | "gpc_enforced";

export const PUBLIC_CONSENT_PENDING_STORAGE_KEY =
  "postwave.public-consent.pending.v2";
const LEGACY_PUBLIC_CONSENT_PENDING_STORAGE_KEY =
  "postwave.public-consent.pending.v1";
const PUBLIC_CONSENT_PENDING_ITEM_PREFIX = `${PUBLIC_CONSENT_PENDING_STORAGE_KEY}.item.`;
export const PUBLIC_CONSENT_SYNC_STATE_EVENT =
  "postwave:public-consent-sync-state";
export const PUBLIC_CONSENT_GPC_ENFORCED_EVENT =
  "postwave:public-consent-gpc-enforced";
export const MAX_PENDING_PUBLIC_CONSENT_DECISIONS = 8;
export const MAX_PENDING_PUBLIC_CONSENT_BYTES = 16 * 1024;
export const MAX_TERMINAL_PUBLIC_CONSENT_DECISIONS = 8;
export const PUBLIC_CONSENT_DELIVERY_TIMEOUT_MS = 15_000;

const MAX_RESPONSE_BYTES = 16 * 1024;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 5 * 60_000;
const MAX_SERVER_RETRY_AFTER_MS = 60 * 60_000;
const MAX_ATTEMPTS_VALUE = 1_000_000;
const VISITOR_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SITE_KEY_RE = /^[\x21-\x7E]{1,255}$/u;

let activeDrain: Promise<void> | null = null;
let drainRequested = false;
let latestConfig: PublicConsentSyncConfig | null = null;
let retryTimer: number | null = null;
let retryTimerAt = 0;

function emitSyncState(state: PublicConsentSyncState): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(PUBLIC_CONSENT_SYNC_STATE_EVENT, {
      // Deliberately exclude the idempotency key, visitor id, decision id,
      // event ids, and preference values from observable diagnostics.
      detail: { state },
    }),
  );
}

function emitGPCEnforced(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(PUBLIC_CONSENT_GPC_ENFORCED_EVENT));
  emitSyncState("gpc_enforced");
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function isChoice(value: unknown): value is PublicConsentChoice {
  return (
    value === "accept" ||
    value === "reject" ||
    value === "custom" ||
    value === "gpc"
  );
}

function isPrefs(value: unknown): value is PublicConsentPrefs {
  if (!isPlainObject(value)) return false;
  return (
    hasExactKeys(value, ["essential", "analytics", "marketing"]) &&
    value.essential === true &&
    typeof value.analytics === "boolean" &&
    typeof value.marketing === "boolean"
  );
}

function isBoundedPolicyVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    return false;
  }
  return !Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
}

function isBoundedSiteKey(value: unknown): value is string {
  return typeof value === "string" && SITE_KEY_RE.test(value);
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}

function hasSafeEndpointTransport(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" && isLoopbackHost(url.hostname))
  );
}

function normalizeConfig(
  config: PublicConsentSyncConfig | null | undefined,
): PublicConsentSyncConfig | null {
  if (
    typeof window === "undefined" ||
    !config ||
    !isBoundedSiteKey(config.siteKey) ||
    typeof config.endpoint !== "string"
  ) {
    return null;
  }
  if (config.siteKey !== config.siteKey.trim()) return null;
  try {
    const rawEndpoint = config.endpoint.trim();
    const parsed = new URL(
      rawEndpoint || window.location.origin,
      window.location.origin,
    );
    if (
      !hasSafeEndpointTransport(parsed) ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      return null;
    }
    const path = parsed.pathname.replace(/\/+$/u, "");
    return {
      siteKey: config.siteKey,
      endpoint: `${parsed.origin}${path === "/" ? "" : path}`,
    };
  } catch {
    return null;
  }
}

function isStoredEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 8 || value.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      hasSafeEndpointTransport(parsed) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.search === "" &&
      parsed.hash === "" &&
      `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}` === value
    );
  } catch {
    return false;
  }
}

function isPendingDecision(
  value: unknown,
): value is PendingPublicConsentDecision {
  if (!isPlainObject(value)) return false;
  if (
    !hasExactKeys(value, [
      "schemaVersion",
      "idempotencyKey",
      "siteKey",
      "endpoint",
      "visitorId",
      "choice",
      "prefs",
      "policyVersion",
      "queuedAt",
      "attempts",
      "retryAt",
      "status",
    ])
  ) {
    return false;
  }
  return (
    value.schemaVersion === 2 &&
    typeof value.idempotencyKey === "string" &&
    UUID_V4_RE.test(value.idempotencyKey) &&
    isBoundedSiteKey(value.siteKey) &&
    isStoredEndpoint(value.endpoint) &&
    typeof value.visitorId === "string" &&
    VISITOR_ID_RE.test(value.visitorId) &&
    isChoice(value.choice) &&
    isPrefs(value.prefs) &&
    isBoundedPolicyVersion(value.policyVersion) &&
    typeof value.queuedAt === "number" &&
    Number.isSafeInteger(value.queuedAt) &&
    value.queuedAt >= 0 &&
    typeof value.attempts === "number" &&
    Number.isSafeInteger(value.attempts) &&
    value.attempts >= 0 &&
    value.attempts <= MAX_ATTEMPTS_VALUE &&
    typeof value.retryAt === "number" &&
    Number.isSafeInteger(value.retryAt) &&
    value.retryAt >= 0 &&
    (value.status === "pending" ||
      value.status === "conflict" ||
      value.status === "failed" ||
      value.status === "configuration_mismatch")
  );
}

function cloneDecision(
  item: PendingPublicConsentDecision,
): PendingPublicConsentDecision {
  return { ...item, prefs: { ...item.prefs } };
}

function decisionStorageKey(idempotencyKey: string): string {
  return `${PUBLIC_CONSENT_PENDING_ITEM_PREFIX}${idempotencyKey}`;
}

function readStore(): PendingStore {
  const empty: PendingStore = {
    schema_version: 2,
    items: [],
    blocked: false,
    serializedBytes: 0,
  };
  if (typeof window === "undefined") return empty;
  try {
    let blocked = false;
    if (
      window.localStorage.getItem(LEGACY_PUBLIC_CONSENT_PENDING_STORAGE_KEY) !==
      null
    ) {
      // A v1 envelope predates site/endpoint binding. Preserve it in place but
      // never guess which tenant a later build should send it to.
      emitSyncState("configuration_mismatch");
    }
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PUBLIC_CONSENT_PENDING_ITEM_PREFIX)) keys.push(key);
    }
    keys.sort();
    if (
      keys.length >
      MAX_PENDING_PUBLIC_CONSENT_DECISIONS +
        MAX_TERMINAL_PUBLIC_CONSENT_DECISIONS
    ) {
      blocked = true;
      emitSyncState("storage_corrupt");
    }

    const items: PendingPublicConsentDecision[] = [];
    let serializedBytes = 0;
    for (const key of keys) {
      const raw = window.localStorage.getItem(key);
      if (raw === null) continue;
      serializedBytes += byteLength(raw);
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          !isPendingDecision(parsed) ||
          key !== decisionStorageKey(parsed.idempotencyKey)
        ) {
          throw new Error("invalid pending decision");
        }
        items.push(cloneDecision(parsed));
      } catch {
        // Corrupt local evidence is quarantined in place for explicit recovery;
        // never silently delete a decision because an untrusted parser failed.
        blocked = true;
        emitSyncState("storage_corrupt");
      }
    }
    const pending = items.filter((item) => item.status === "pending");
    const terminal = items.filter((item) => item.status !== "pending");
    const pendingBytes = pending.reduce(
      (total, item) => total + byteLength(JSON.stringify(item)),
      0,
    );
    const terminalBytes = terminal.reduce(
      (total, item) => total + byteLength(JSON.stringify(item)),
      0,
    );
    if (
      pending.length > MAX_PENDING_PUBLIC_CONSENT_DECISIONS ||
      terminal.length > MAX_TERMINAL_PUBLIC_CONSENT_DECISIONS ||
      pendingBytes > MAX_PENDING_PUBLIC_CONSENT_BYTES ||
      terminalBytes > MAX_PENDING_PUBLIC_CONSENT_BYTES
    ) {
      blocked = true;
      emitSyncState("storage_corrupt");
    }
    return { schema_version: 2, items, blocked, serializedBytes };
  } catch {
    emitSyncState("storage_unavailable");
    return { ...empty, blocked: true };
  }
}

function writeNewDecision(item: PendingPublicConsentDecision): boolean {
  if (typeof window === "undefined") return false;
  const key = decisionStorageKey(item.idempotencyKey);
  const serialized = JSON.stringify(item);
  try {
    if (window.localStorage.getItem(key) !== null) return false;
    window.localStorage.setItem(key, serialized);
    if (window.localStorage.getItem(key) !== serialized) return false;
    const stored = readStore();
    if (stored.blocked) {
      if (window.localStorage.getItem(key) === serialized) {
        window.localStorage.removeItem(key);
      }
      return false;
    }
    return true;
  } catch {
    emitSyncState("storage_unavailable");
    return false;
  }
}

export function readPendingPublicConsentDecisions(): PendingPublicConsentDecision[] {
  return readStore().items.map(cloneDecision);
}

/** Generate an RFC 4122 UUIDv4 for one new user decision. */
export function createConsentDecisionId(): string {
  if (typeof window === "undefined") return "";
  try {
    if (typeof window.crypto?.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
  } catch {
    // Fall through to getRandomValues, which remains cryptographically strong.
  }

  const bytes = new Uint8Array(16);
  try {
    if (!window.crypto?.getRandomValues) return "";
    window.crypto.getRandomValues(bytes);
  } catch {
    // A weak fallback can collide and turn one person's consent evidence into
    // another decision's 409/replay. Fail closed until Web Crypto is usable.
    return "";
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function enqueuePublicConsentDecision(input: {
  visitorId: string;
  choice: PublicConsentChoice;
  prefs: PublicConsentPrefs;
  policyVersion: string;
  config: PublicConsentSyncConfig;
}): boolean {
  const config = normalizeConfig(input.config);
  if (
    config === null ||
    !VISITOR_ID_RE.test(input.visitorId) ||
    !isChoice(input.choice) ||
    !isPrefs(input.prefs) ||
    !isBoundedPolicyVersion(input.policyVersion)
  ) {
    emitSyncState("failed");
    return false;
  }
  const store = readStore();
  if (
    store.blocked ||
    store.items.filter((item) => item.status === "pending").length >=
      MAX_PENDING_PUBLIC_CONSENT_DECISIONS
  ) {
    emitSyncState("queue_full");
    return false;
  }

  let idempotencyKey = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = createConsentDecisionId();
    if (
      UUID_V4_RE.test(candidate) &&
      !store.items.some((item) => item.idempotencyKey === candidate)
    ) {
      idempotencyKey = candidate;
      break;
    }
  }
  if (idempotencyKey === "") {
    emitSyncState("storage_unavailable");
    return false;
  }

  const item: PendingPublicConsentDecision = {
    schemaVersion: 2,
    idempotencyKey,
    siteKey: config.siteKey,
    endpoint: config.endpoint,
    visitorId: input.visitorId,
    choice: input.choice,
    prefs: { ...input.prefs },
    policyVersion: input.policyVersion,
    queuedAt: Date.now(),
    attempts: 0,
    retryAt: 0,
    status: "pending",
  };
  if (!writeNewDecision(item)) {
    emitSyncState("storage_unavailable");
    return false;
  }
  emitSyncState("queued");
  return true;
}

function requestBody(item: PendingPublicConsentDecision): string {
  return JSON.stringify({
    visitor_id: item.visitorId,
    choice: item.choice,
    prefs: {
      essential: true,
      analytics: item.prefs.analytics,
      marketing: item.prefs.marketing,
    },
    policy_version: item.policyVersion,
  });
}

function sameDecision(
  left: PendingPublicConsentDecision,
  right: PendingPublicConsentDecision,
): boolean {
  return (
    left.idempotencyKey === right.idempotencyKey &&
    left.siteKey === right.siteKey &&
    left.endpoint === right.endpoint &&
    requestBody(left) === requestBody(right)
  );
}

function updateExactDecision(
  expected: PendingPublicConsentDecision,
  update: (
    item: PendingPublicConsentDecision,
  ) => PendingPublicConsentDecision | null,
): boolean {
  if (typeof window === "undefined") return false;
  const key = decisionStorageKey(expected.idempotencyKey);
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return false;
    const parsed: unknown = JSON.parse(raw);
    if (!isPendingDecision(parsed) || !sameDecision(parsed, expected)) {
      emitSyncState("storage_corrupt");
      return false;
    }
    const replacement = update(cloneDecision(parsed));
    if (replacement === null) {
      window.localStorage.removeItem(key);
      return window.localStorage.getItem(key) === null;
    }
    const serialized = JSON.stringify(replacement);
    window.localStorage.setItem(key, serialized);
    return window.localStorage.getItem(key) === serialized;
  } catch {
    emitSyncState("storage_unavailable");
    return false;
  }
}

/** Explicit recovery only: callers must present the exact terminal identity. */
export function discardTerminalPublicConsentDecision(
  idempotencyKey: string,
): boolean {
  if (typeof window === "undefined" || !UUID_V4_RE.test(idempotencyKey)) {
    return false;
  }
  const item = readStore().items.find(
    (candidate) => candidate.idempotencyKey === idempotencyKey,
  );
  if (!item || item.status === "pending") return false;
  return updateExactDecision(item, () => null);
}

/**
 * Explicit user-directed recovery for terminal, legacy-unbound, or corrupt
 * local envelopes. Pending config-bound decisions are never removed here.
 */
export function discardUnrecoverablePublicConsentDecisions(): number {
  if (typeof window === "undefined") return 0;
  let removed = 0;
  try {
    if (
      window.localStorage.getItem(LEGACY_PUBLIC_CONSENT_PENDING_STORAGE_KEY) !==
      null
    ) {
      window.localStorage.removeItem(LEGACY_PUBLIC_CONSENT_PENDING_STORAGE_KEY);
      removed += 1;
    }
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(PUBLIC_CONSENT_PENDING_ITEM_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const raw = window.localStorage.getItem(key);
      let removable = raw === null;
      if (raw !== null) {
        try {
          const parsed: unknown = JSON.parse(raw);
          removable = !isPendingDecision(parsed) || parsed.status !== "pending";
        } catch {
          removable = true;
        }
      }
      if (removable && raw !== null) {
        window.localStorage.removeItem(key);
        removed += 1;
      }
    }
    return removed;
  } catch {
    emitSyncState("storage_unavailable");
    return 0;
  }
}

function acceptedResponseMatches(
  body: unknown,
  item: PendingPublicConsentDecision,
): boolean {
  if (!isPlainObject(body)) return false;
  if (
    !hasExactKeys(body, [
      "schema_version",
      "ok",
      "idempotency_key",
      "decision_id",
      "event_ids",
      "written",
      "last_id",
      "gpc",
      "source",
      "idempotent",
    ]) ||
    body.schema_version !== 1 ||
    body.ok !== true ||
    typeof body.idempotency_key !== "string" ||
    body.idempotency_key !== item.idempotencyKey ||
    typeof body.decision_id !== "string" ||
    !UUID_RE.test(body.decision_id) ||
    body.written !== 3 ||
    typeof body.last_id !== "string" ||
    typeof body.gpc !== "boolean" ||
    (body.source !== "cookie_banner" && body.source !== "gpc") ||
    body.idempotent !== true ||
    !isPlainObject(body.event_ids) ||
    !hasExactKeys(body.event_ids, ["essential", "analytics", "marketing"])
  ) {
    return false;
  }
  const ids = [
    body.event_ids.essential,
    body.event_ids.analytics,
    body.event_ids.marketing,
  ];
  if (
    !ids.every((value): value is string =>
      typeof value === "string" ? UUID_RE.test(value) : false,
    ) ||
    new Set(ids).size !== 3 ||
    body.last_id !== body.event_ids.marketing ||
    (body.gpc ? body.source !== "gpc" : body.source !== "cookie_banner") ||
    (item.choice === "gpc" && body.gpc !== true)
  ) {
    return false;
  }
  return true;
}

async function boundedJSON(
  response: Response,
  signal: AbortSignal,
): Promise<unknown | null> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return null;
  const advertised = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(advertised) && advertised > MAX_RESPONSE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The response is already rejected; cancellation is best-effort.
    }
    return null;
  }
  const body = response.body;
  // Never fall back to response.text()/arrayBuffer(): both allocate the entire
  // attacker-controlled body before a limit can be checked.
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let rejectOnAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () =>
      reject(new Error("public consent response timed out"));
    signal.addEventListener("abort", rejectOnAbort, { once: true });
  });
  try {
    if (signal.aborted) throw new Error("public consent response timed out");
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original fail-closed parse/read outcome.
    }
    return null;
  } finally {
    if (rejectOnAbort !== null) {
      signal.removeEventListener("abort", rejectOnAbort);
    }
    reader.releaseLock();
  }
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get("Retry-After");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(MAX_SERVER_RETRY_AFTER_MS, Math.ceil(seconds * 1_000));
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(MAX_SERVER_RETRY_AFTER_MS, Math.max(0, at - Date.now()));
}

type DeliveryOutcome =
  | { kind: "accepted"; gpc: boolean }
  | { kind: "retry"; retryAfterMs?: number }
  | { kind: "conflict" }
  | { kind: "failed" };

async function deliver(
  item: PendingPublicConsentDecision,
  config: PublicConsentSyncConfig,
): Promise<DeliveryOutcome> {
  const controller = new AbortController();
  const deadline = window.setTimeout(
    () => controller.abort(),
    PUBLIC_CONSENT_DELIVERY_TIMEOUT_MS,
  );
  try {
    const response = await fetch(
      `${config.endpoint.replace(/\/$/, "")}/api/public/consent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": item.idempotencyKey,
          "X-Postwave-Site-Key": config.siteKey,
        },
        body: requestBody(item),
        keepalive: true,
        credentials: "omit",
        signal: controller.signal,
      },
    );

    if (response.status === 202) {
      const body = await boundedJSON(response, controller.signal);
      return acceptedResponseMatches(body, item) && isPlainObject(body)
        ? { kind: "accepted", gpc: body.gpc === true }
        : { kind: "retry" };
    }
    if (response.status === 409) return { kind: "conflict" };
    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      return {
        kind: "retry",
        retryAfterMs:
          response.status === 429
            ? (parseRetryAfter(response) ?? undefined)
            : undefined,
      };
    }
    return { kind: "failed" };
  } catch {
    return { kind: "retry" };
  } finally {
    window.clearTimeout(deadline);
  }
}

function retryDelay(attempts: number, serverDelay?: number): number {
  const exponential = Math.min(
    MAX_RETRY_MS,
    BASE_RETRY_MS * 2 ** Math.min(16, Math.max(0, attempts - 1)),
  );
  return Math.max(exponential, serverDelay ?? 0);
}

function clearRetryTimer(): void {
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  retryTimerAt = 0;
}

function scheduleRetry(config: PublicConsentSyncConfig, at: number): void {
  if (typeof window === "undefined") return;
  if (retryTimer !== null && retryTimerAt <= at) return;
  clearRetryTimer();
  retryTimerAt = at;
  retryTimer = window.setTimeout(
    () => {
      retryTimer = null;
      retryTimerAt = 0;
      void flushPendingPublicConsentDecisions(config);
    },
    Math.min(MAX_RETRY_MS, Math.max(0, at - Date.now())),
  );
}

async function drain(config: PublicConsentSyncConfig): Promise<void> {
  if (typeof window === "undefined" || config.siteKey.trim() === "") return;
  while (true) {
    const pending = readStore().items.filter(
      (item) => item.status === "pending",
    );
    if (pending.length === 0) {
      clearRetryTimer();
      return;
    }
    pending.sort(
      (left, right) =>
        left.queuedAt - right.queuedAt ||
        left.idempotencyKey.localeCompare(right.idempotencyKey),
    );
    const item = pending[0];
    if (item.siteKey !== config.siteKey || item.endpoint !== config.endpoint) {
      if (
        updateExactDecision(item, (current) => ({
          ...current,
          retryAt: 0,
          status: "configuration_mismatch",
        }))
      ) {
        emitSyncState("configuration_mismatch");
        continue;
      }
      return;
    }
    if (item.retryAt > Date.now()) {
      scheduleRetry(config, item.retryAt);
      return;
    }

    const outcome = await deliver(item, config);
    if (outcome.kind === "accepted") {
      // A server-observed GPC override is authoritative independently of local
      // queue cleanup. Storage can fail after the verified 202; telemetry must
      // still be disabled immediately even while the envelope remains.
      if (outcome.gpc) emitGPCEnforced();
      if (updateExactDecision(item, () => null)) {
        emitSyncState("synced");
        continue;
      }
      // Another tab may already have cleared the item, or storage may have
      // become unavailable. Either way, do not spin an accepted request.
      return;
    }
    if (outcome.kind === "conflict") {
      if (
        updateExactDecision(item, (current) => ({
          ...current,
          attempts: Math.min(MAX_ATTEMPTS_VALUE, current.attempts + 1),
          retryAt: 0,
          status: "conflict",
        }))
      ) {
        emitSyncState("conflict");
        continue;
      }
      return;
    }
    if (outcome.kind === "failed") {
      if (
        updateExactDecision(item, (current) => ({
          ...current,
          attempts: Math.min(MAX_ATTEMPTS_VALUE, current.attempts + 1),
          retryAt: 0,
          status: "failed",
        }))
      ) {
        emitSyncState("failed");
        continue;
      }
      return;
    }

    const attempts = Math.min(MAX_ATTEMPTS_VALUE, item.attempts + 1);
    const retryAt = Date.now() + retryDelay(attempts, outcome.retryAfterMs);
    if (
      updateExactDecision(item, (current) => ({
        ...current,
        attempts,
        retryAt,
        status: "pending",
      }))
    ) {
      emitSyncState("retrying");
      scheduleRetry(config, retryAt);
    }
    // Preserve decision order: do not write a later choice while an earlier
    // one is transiently uncertain.
    return;
  }
}

/**
 * Drain every deliverable item. Concurrent calls coalesce, while a call that
 * arrives in the narrow finalization window requests one more pass.
 */
export function flushPendingPublicConsentDecisions(
  config: PublicConsentSyncConfig,
): Promise<void> {
  const normalized = normalizeConfig(config);
  if (normalized === null) {
    emitSyncState("configuration_mismatch");
    return Promise.resolve();
  }
  latestConfig = normalized;
  drainRequested = true;
  if (activeDrain !== null) return activeDrain;

  activeDrain = (async () => {
    while (drainRequested) {
      drainRequested = false;
      const selected = latestConfig;
      if (selected !== null) await drain(selected);
    }
  })()
    .catch(() => {
      // Keep the durable envelope for a later reload. Never include its key or
      // decision data in console/error diagnostics.
      emitSyncState("retrying");
    })
    .finally(() => {
      activeDrain = null;
      if (drainRequested && latestConfig !== null) {
        void flushPendingPublicConsentDecisions(latestConfig);
      }
    });
  return activeDrain;
}

/** Cancel only the in-page timer; durable pending decisions remain intact. */
export function cancelPendingPublicConsentTimer(): void {
  clearRetryTimer();
}
