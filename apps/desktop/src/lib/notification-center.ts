import {
  getNotification,
  type NotificationCategory,
} from "@postwave/notifications";
import { parseDeepLink } from "@postwave/route-map";
import { useSyncExternalStore } from "react";

import { vaultGetJSON, vaultSetJSON } from "./secure-vault";

const STORE_VERSION = 1;
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1_000;
const MAX_TITLE_CHARS = 120;
const MAX_BODY_CHARS = 280;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

export const DESKTOP_NOTIFICATION_TOPICS = [
  "approval.requested",
  "campaign.sent",
  "subscriber.bounced",
  "dashboard.anomaly",
  "dashboard.milestone",
] as const;

export type DesktopNotificationTopic =
  (typeof DESKTOP_NOTIFICATION_TOPICS)[number];
export type DesktopNotificationCategory = NotificationCategory | "analytics";
export type ForegroundNotificationPolicy = "center-only" | "os-and-center";
export type NotificationDeliveryState =
  | "pending"
  | "delivered"
  | "suppressed-disabled"
  | "suppressed-topic"
  | "suppressed-quiet-hours"
  | "suppressed-foreground"
  | "failed";

export interface DesktopNotificationPreferences {
  osEnabled: boolean;
  topics: Record<DesktopNotificationTopic, boolean>;
  foregroundPolicy: ForegroundNotificationPolicy;
  quietHours: {
    enabled: boolean;
    startMinute: number;
    endMinute: number;
  };
}

export interface NotificationCenterEntry {
  id: string;
  topic: DesktopNotificationTopic;
  category: DesktopNotificationCategory;
  title: string;
  body: string;
  createdAt: string;
  deepLink: string | null;
  readAt: string | null;
  archivedAt: string | null;
  delivery: NotificationDeliveryState;
}

export interface NotificationCenterSnapshot {
  identity: "none" | "loading" | "ready";
  entries: readonly NotificationCenterEntry[];
  preferences: DesktopNotificationPreferences;
  unreadCount: number;
  persistError: boolean;
}

export interface NotificationCenterInput {
  topic: DesktopNotificationTopic;
  title: string;
  body: string;
  occurredAt: string;
  eventIdentity: string;
  deepLink?: string | null;
}

export type NotificationDeliveryDecision =
  | { deliver: true }
  | {
      deliver: false;
      reason: Exclude<
        NotificationDeliveryState,
        "pending" | "delivered" | "failed"
      >;
    };

interface PersistedNotificationCenter {
  version: typeof STORE_VERSION;
  entries: NotificationCenterEntry[];
  preferences: DesktopNotificationPreferences;
}

const defaultPreferences: DesktopNotificationPreferences = {
  // Consent-first: never surprise a new user with an OS prompt in response to
  // an unrelated background event. Settings explicitly enables this channel.
  osEnabled: false,
  topics: {
    "approval.requested": true,
    "campaign.sent": true,
    "subscriber.bounced": true,
    "dashboard.anomaly": true,
    "dashboard.milestone": false,
  },
  foregroundPolicy: "center-only",
  quietHours: { enabled: false, startMinute: 22 * 60, endMinute: 8 * 60 },
};

let snapshot: NotificationCenterSnapshot = makeSnapshot(
  "none",
  [],
  defaultPreferences,
  false,
);
let activeVaultKey: string | null = null;
let loadGeneration = 0;
let pendingLoad: Promise<void> = Promise.resolve();
let writeQueue: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

function clonePreferences(
  value: DesktopNotificationPreferences,
): DesktopNotificationPreferences {
  return {
    osEnabled: value.osEnabled,
    topics: { ...value.topics },
    foregroundPolicy: value.foregroundPolicy,
    quietHours: { ...value.quietHours },
  };
}

function makeSnapshot(
  identity: NotificationCenterSnapshot["identity"],
  entries: readonly NotificationCenterEntry[],
  preferences: DesktopNotificationPreferences,
  persistError: boolean,
): NotificationCenterSnapshot {
  return {
    identity,
    entries,
    preferences: clonePreferences(preferences),
    unreadCount: entries.filter(
      (entry) => entry.archivedAt === null && entry.readAt === null,
    ).length,
    persistError,
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function replaceSnapshot(
  entries: readonly NotificationCenterEntry[],
  preferences = snapshot.preferences,
  persistError = snapshot.persistError,
): void {
  snapshot = makeSnapshot("ready", entries, preferences, persistError);
  emit();
}

function identityHash(user: string, tenant: string): string {
  const value = `${user}\u001f${tenant}`;
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function validBoundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !CONTROL_RE.test(value)
  );
}

/** Native activation token and persisted center row-id trust boundary. */
export function isNotificationCenterEntryId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/u.test(value);
}

function isTopic(value: unknown): value is DesktopNotificationTopic {
  return DESKTOP_NOTIFICATION_TOPICS.includes(
    value as DesktopNotificationTopic,
  );
}

function validMinute(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) < 1440;
}

function sanitizePreferences(value: unknown): DesktopNotificationPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return clonePreferences(defaultPreferences);
  }
  const candidate = value as Partial<DesktopNotificationPreferences>;
  const topics = candidate.topics;
  const quiet = candidate.quietHours;
  return {
    osEnabled:
      typeof candidate.osEnabled === "boolean"
        ? candidate.osEnabled
        : defaultPreferences.osEnabled,
    topics: {
      "approval.requested":
        typeof topics?.["approval.requested"] === "boolean"
          ? topics["approval.requested"]
          : defaultPreferences.topics["approval.requested"],
      "campaign.sent":
        typeof topics?.["campaign.sent"] === "boolean"
          ? topics["campaign.sent"]
          : defaultPreferences.topics["campaign.sent"],
      "subscriber.bounced":
        typeof topics?.["subscriber.bounced"] === "boolean"
          ? topics["subscriber.bounced"]
          : defaultPreferences.topics["subscriber.bounced"],
      "dashboard.anomaly":
        typeof topics?.["dashboard.anomaly"] === "boolean"
          ? topics["dashboard.anomaly"]
          : defaultPreferences.topics["dashboard.anomaly"],
      "dashboard.milestone":
        typeof topics?.["dashboard.milestone"] === "boolean"
          ? topics["dashboard.milestone"]
          : defaultPreferences.topics["dashboard.milestone"],
    },
    foregroundPolicy:
      candidate.foregroundPolicy === "os-and-center"
        ? "os-and-center"
        : "center-only",
    quietHours: {
      enabled: quiet?.enabled === true,
      startMinute: validMinute(quiet?.startMinute)
        ? quiet.startMinute
        : defaultPreferences.quietHours.startMinute,
      endMinute: validMinute(quiet?.endMinute)
        ? quiet.endMinute
        : defaultPreferences.quietHours.endMinute,
    },
  };
}

function sanitizeEntry(
  value: unknown,
  now = Date.now(),
): NotificationCenterEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<NotificationCenterEntry>;
  if (
    !isNotificationCenterEntryId(entry.id) ||
    !isTopic(entry.topic) ||
    !validBoundedText(entry.title, MAX_TITLE_CHARS) ||
    !validBoundedText(entry.body, MAX_BODY_CHARS)
  ) {
    return null;
  }
  const category = categoryForTopic(entry.topic);
  const created = Date.parse(entry.createdAt ?? "");
  if (
    !category ||
    !Number.isFinite(created) ||
    created > now + 5 * 60_000 ||
    created < now - MAX_AGE_MS
  ) {
    return null;
  }
  const deepLink = validDeepLink(entry.topic, entry.deepLink)
    ? entry.deepLink
    : null;
  const readAt = validOptionalTimestamp(entry.readAt) ? entry.readAt : null;
  const archivedAt = validOptionalTimestamp(entry.archivedAt)
    ? entry.archivedAt
    : null;
  const deliveries: readonly NotificationDeliveryState[] = [
    "pending",
    "delivered",
    "suppressed-disabled",
    "suppressed-topic",
    "suppressed-quiet-hours",
    "suppressed-foreground",
    "failed",
  ];
  return {
    id: entry.id,
    topic: entry.topic,
    category,
    title: entry.title,
    body: entry.body,
    createdAt: new Date(created).toISOString(),
    deepLink,
    readAt,
    archivedAt,
    delivery: deliveries.includes(entry.delivery as NotificationDeliveryState)
      ? (entry.delivery as NotificationDeliveryState)
      : "pending",
  };
}

function validOptionalTimestamp(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && !Number.isNaN(Date.parse(value)))
  );
}

function validDeepLink(
  topic: DesktopNotificationTopic,
  value: unknown,
): value is string | null {
  if (value === null || value === undefined) return true;
  if (typeof value !== "string" || value.length > 300) return false;
  const parsed = parseDeepLink(value);
  const definition = getNotification(topic);
  return parsed !== null && parsed.entity === definition?.deepLinkEntity;
}

function categoryForTopic(
  topic: DesktopNotificationTopic,
): DesktopNotificationCategory | null {
  if (topic === "dashboard.anomaly" || topic === "dashboard.milestone") {
    return "analytics";
  }
  return getNotification(topic)?.category ?? null;
}

function sanitizeEntries(value: unknown): NotificationCenterEntry[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, NotificationCenterEntry>();
  for (const raw of value.slice(0, MAX_ENTRIES * 2)) {
    const entry = sanitizeEntry(raw);
    if (entry && !byId.has(entry.id)) byId.set(entry.id, entry);
  }
  return [...byId.values()]
    .sort(
      (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
    )
    .slice(0, MAX_ENTRIES);
}

function persistedPayload(): PersistedNotificationCenter {
  return {
    version: STORE_VERSION,
    entries: snapshot.entries.map((entry) => ({ ...entry })),
    preferences: clonePreferences(snapshot.preferences),
  };
}

function queuePersistence(): void {
  const key = activeVaultKey;
  const generation = loadGeneration;
  const payload = persistedPayload();
  if (!key) return;
  writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      if (generation !== loadGeneration || key !== activeVaultKey) return;
      try {
        await vaultSetJSON(key, payload);
        if (generation === loadGeneration && snapshot.persistError) {
          replaceSnapshot(snapshot.entries, snapshot.preferences, false);
        }
      } catch {
        if (generation === loadGeneration && !snapshot.persistError) {
          replaceSnapshot(snapshot.entries, snapshot.preferences, true);
        }
      }
    });
}

/** Select and decrypt the current user's isolated notification center. */
export function configureNotificationCenterIdentity(
  user: string | null,
  tenant: string | null,
): Promise<void> {
  const normalizedUser = user?.trim() ?? "";
  const normalizedTenant = tenant?.trim() ?? "";
  const nextKey =
    normalizedUser && normalizedTenant
      ? `notifications.center.v${STORE_VERSION}.${identityHash(normalizedUser, normalizedTenant)}`
      : null;
  if (nextKey === activeVaultKey && snapshot.identity !== "none") {
    return pendingLoad;
  }
  const generation = ++loadGeneration;
  activeVaultKey = nextKey;
  if (!nextKey) {
    snapshot = makeSnapshot("none", [], defaultPreferences, false);
    emit();
    pendingLoad = Promise.resolve();
    return pendingLoad;
  }
  snapshot = makeSnapshot("loading", [], defaultPreferences, false);
  emit();
  pendingLoad = (async () => {
    const stored = await vaultGetJSON<Partial<PersistedNotificationCenter>>(
      nextKey,
    ).catch(() => null);
    if (generation !== loadGeneration || activeVaultKey !== nextKey) return;
    const entries =
      stored?.version === STORE_VERSION ? sanitizeEntries(stored.entries) : [];
    const preferences =
      stored?.version === STORE_VERSION
        ? sanitizePreferences(stored.preferences)
        : clonePreferences(defaultPreferences);
    snapshot = makeSnapshot("ready", entries, preferences, false);
    emit();
  })();
  return pendingLoad;
}

function stableEntryId(input: NotificationCenterInput): string {
  // Callers supply a domain event identity (server event id/timestamp, anomaly
  // id, or workspace+milestone). Keeping occurrence time out of this hash lets
  // a failed delivery retry without creating a second center row.
  const value = `${input.topic}\u001f${input.eventIdentity}`;
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/** Add a privacy-safe notification to encrypted history before OS delivery. */
export async function ingestNotification(
  input: NotificationCenterInput,
): Promise<{ stored: boolean; id: string | null }> {
  await pendingLoad;
  if (snapshot.identity !== "ready" || !activeVaultKey) {
    return { stored: false, id: null };
  }
  const category = categoryForTopic(input.topic);
  const occurred = Date.parse(input.occurredAt);
  if (
    !category ||
    !validBoundedText(input.eventIdentity, 300) ||
    !validBoundedText(input.title, MAX_TITLE_CHARS) ||
    !validBoundedText(input.body, MAX_BODY_CHARS) ||
    !Number.isFinite(occurred)
  ) {
    return { stored: false, id: null };
  }
  const id = stableEntryId(input);
  if (snapshot.entries.some((entry) => entry.id === id)) {
    return { stored: false, id };
  }
  const entry = sanitizeEntry({
    id,
    topic: input.topic,
    category,
    title: input.title,
    body: input.body,
    createdAt: new Date(occurred).toISOString(),
    deepLink: validDeepLink(input.topic, input.deepLink)
      ? (input.deepLink ?? null)
      : null,
    readAt: null,
    archivedAt: null,
    delivery: "pending",
  });
  if (!entry) return { stored: false, id: null };
  const cutoff = Date.now() - MAX_AGE_MS;
  replaceSnapshot(
    [
      entry,
      ...snapshot.entries.filter(
        (current) => Date.parse(current.createdAt) >= cutoff,
      ),
    ].slice(0, MAX_ENTRIES),
  );
  queuePersistence();
  return { stored: true, id };
}

function updateEntry(
  id: string,
  mutate: (entry: NotificationCenterEntry) => NotificationCenterEntry,
): void {
  let changed = false;
  const entries = snapshot.entries.map((entry) => {
    if (entry.id !== id) return entry;
    changed = true;
    return mutate(entry);
  });
  if (!changed) return;
  replaceSnapshot(entries);
  queuePersistence();
}

export function recordNotificationDelivery(
  id: string | null,
  delivery: NotificationDeliveryState,
): void {
  if (!id) return;
  updateEntry(id, (entry) => ({ ...entry, delivery }));
}

/**
 * Optional sink for read state, so a LOCAL read also reaches the server feed
 * and the user's other devices stop showing it bold.
 *
 * Injected rather than imported: the propagation path needs the API client,
 * which transitively pulls in the router, and wiring that into the vault (or
 * into the panel) would drag the whole graph into every component that renders
 * a notification. The shell installs it once; until then, and in tests, read
 * state stays local — which is the behaviour that existed before.
 */
export interface NotificationReadPropagator {
  one: (entry: NotificationCenterEntry) => void;
  all: () => void;
}

let readPropagator: NotificationReadPropagator | null = null;

export function setNotificationReadPropagator(
  propagator: NotificationReadPropagator | null,
): void {
  readPropagator = propagator;
}

export function markNotificationRead(id: string): void {
  const entry = snapshot.entries.find((candidate) => candidate.id === id);
  updateEntry(id, (current) => ({
    ...current,
    readAt: current.readAt ?? new Date().toISOString(),
  }));
  // Only propagate a transition. Re-reading an already-read entry is a no-op
  // locally and must not cost a request.
  if (entry && entry.readAt === null) readPropagator?.one(entry);
}

export function markAllNotificationsRead(): void {
  const now = new Date().toISOString();
  const entries = snapshot.entries.map((entry) =>
    entry.archivedAt === null && entry.readAt === null
      ? { ...entry, readAt: now }
      : entry,
  );
  replaceSnapshot(entries);
  queuePersistence();
  // …and on every other device. Without this the button cleared only this
  // machine's vault: correlated and server-only rows stayed unread, the count
  // never reached zero, and "Mark all read" visibly did nothing.
  readPropagator?.all();
}

/**
 * Apply read state the SERVER already knows about to local entries.
 *
 * This is the "pull" half of making read/unread one truth across devices (the
 * "push" half is `notification-feed-sync.ts`, which posts local reads up). Read
 * state only ever moves toward READ: an entry the server considers read becomes
 * read here, but a locally-read entry is never un-read by a server row that
 * lacks the marker. Read is a monotonic, user-intent signal — a sync that could
 * un-read something would let one device silently undo another's decision.
 *
 * Entries are matched by a caller-supplied predicate so the correlation rules
 * stay in `notification-feed-reconcile.ts` with their tests, rather than being
 * duplicated inside the vault.
 */
export function applyServerReadState(
  isReadOnServer: (entry: NotificationCenterEntry) => boolean,
): number {
  if (snapshot.identity !== "ready") return 0;
  let changed = 0;
  const now = new Date().toISOString();
  const entries = snapshot.entries.map((entry) => {
    if (entry.readAt !== null || !isReadOnServer(entry)) return entry;
    changed += 1;
    return { ...entry, readAt: now };
  });
  if (changed === 0) return 0;
  replaceSnapshot(entries);
  queuePersistence();
  return changed;
}

export function setNotificationArchived(id: string, archived: boolean): void {
  updateEntry(id, (entry) => ({
    ...entry,
    archivedAt: archived ? new Date().toISOString() : null,
    readAt: archived
      ? (entry.readAt ?? new Date().toISOString())
      : entry.readAt,
  }));
}

export function clearArchivedNotifications(): void {
  replaceSnapshot(
    snapshot.entries.filter((entry) => entry.archivedAt === null),
  );
  queuePersistence();
}

export function updateDesktopNotificationPreferences(
  patch: Partial<DesktopNotificationPreferences>,
): void {
  if (snapshot.identity !== "ready") return;
  const preferences = sanitizePreferences({
    ...snapshot.preferences,
    ...patch,
    topics: patch.topics ?? snapshot.preferences.topics,
    quietHours: patch.quietHours ?? snapshot.preferences.quietHours,
  });
  replaceSnapshot(snapshot.entries, preferences);
  queuePersistence();
}

function inQuietHours(
  quiet: DesktopNotificationPreferences["quietHours"],
  date: Date,
): boolean {
  if (!quiet.enabled) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  if (quiet.startMinute === quiet.endMinute) return true;
  return quiet.startMinute < quiet.endMinute
    ? minute >= quiet.startMinute && minute < quiet.endMinute
    : minute >= quiet.startMinute || minute < quiet.endMinute;
}

export function notificationDeliveryDecision(options: {
  topic: DesktopNotificationTopic;
  now?: Date;
  appVisible: boolean;
  appFocused: boolean;
  preferences?: DesktopNotificationPreferences;
}): NotificationDeliveryDecision {
  const preferences = options.preferences ?? snapshot.preferences;
  if (!preferences.osEnabled) {
    return { deliver: false, reason: "suppressed-disabled" };
  }
  if (!preferences.topics[options.topic]) {
    return { deliver: false, reason: "suppressed-topic" };
  }
  if (inQuietHours(preferences.quietHours, options.now ?? new Date())) {
    return { deliver: false, reason: "suppressed-quiet-hours" };
  }
  if (
    preferences.foregroundPolicy === "center-only" &&
    options.appVisible &&
    options.appFocused
  ) {
    return { deliver: false, reason: "suppressed-foreground" };
  }
  return { deliver: true };
}

export function getNotificationCenterSnapshot(): NotificationCenterSnapshot {
  return snapshot;
}

export function subscribeNotificationCenter(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotificationCenter(): NotificationCenterSnapshot {
  return useSyncExternalStore(
    subscribeNotificationCenter,
    getNotificationCenterSnapshot,
    getNotificationCenterSnapshot,
  );
}

/** Test-only reset: production identity changes use configureIdentity. */
export function resetNotificationCenterForTests(): void {
  loadGeneration += 1;
  activeVaultKey = null;
  pendingLoad = Promise.resolve();
  writeQueue = Promise.resolve();
  snapshot = makeSnapshot("none", [], defaultPreferences, false);
  listeners.clear();
}
