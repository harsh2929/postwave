/**
 * Privacy-bounded iOS share-extension inbox.
 *
 * The extension stores only an actionable Moosewave entity link or one bare
 * email address. Arbitrary text, compose notes, generic URLs, query strings,
 * and fragments are never retained. Both native and JS enforce the same
 * item/queue byte caps, queue length, and short TTL; every read rewrites the
 * canonical queue so expired, legacy, and malformed data is deterministically
 * removed.
 */
import { Platform } from "react-native";
import type { Href } from "expo-router";
import { ExtensionStorage } from "@bacons/apple-targets";

import { interpretClipboardOrQr } from "./qr";
import { utf8ByteLength } from "./utf8";

import { BUILD_PROFILE } from "@/lib/config";
import { demoModeEnabled } from "@/lib/demoMode";

const DEMO_MODE = demoModeEnabled(
  { EXPO_PUBLIC_DEV_DEMO: process.env.EXPO_PUBLIC_DEV_DEMO },
  BUILD_PROFILE,
);

const APP_GROUP = "group.com.moosewave.app";
const SHARED_KEY = "pw_shared_items_v2";
const LEGACY_SHARED_KEY = "pw_shared_items";

export const SHARED_INBOX_POLICY = Object.freeze({
  maxAgeSeconds: 15 * 60,
  maxFutureSkewSeconds: 0,
  maxItemBytes: 2 * 1024,
  maxQueueBytes: 12 * 1024,
  maxQueueItems: 8,
});

export type SharedItem = {
  kind: "entity" | "email";
  value: string;
  createdAt: number; // unix seconds
};

function canonicalEntityValue(value: string): string | null {
  const trimmed = value.trim();
  if (/^https:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.username || parsed.password) return null;
    } catch {
      return null;
    }
  }
  const canonical = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (
    !canonical ||
    utf8ByteLength(canonical) > SHARED_INBOX_POLICY.maxItemBytes
  ) {
    return null;
  }
  return interpretClipboardOrQr(canonical).kind === "entity" ? canonical : null;
}

function normalizeSharedItem(
  entry: unknown,
  nowSeconds: number,
): SharedItem | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  try {
    if (
      utf8ByteLength(JSON.stringify(entry)) > SHARED_INBOX_POLICY.maxItemBytes
    ) {
      return null;
    }
  } catch {
    return null;
  }
  const candidate = entry as Record<string, unknown>;
  if (candidate.kind !== "entity" && candidate.kind !== "email") return null;
  if (typeof candidate.value !== "string") return null;
  if (
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return null;
  }

  const createdAt = Math.floor(candidate.createdAt);
  const age = nowSeconds - createdAt;
  if (
    createdAt <= 0 ||
    age < -SHARED_INBOX_POLICY.maxFutureSkewSeconds ||
    age > SHARED_INBOX_POLICY.maxAgeSeconds
  ) {
    return null;
  }

  const trimmed = candidate.value.trim();
  let item: SharedItem | null = null;
  const interpretation = interpretClipboardOrQr(trimmed);
  if (candidate.kind === "email" && interpretation.kind === "email") {
    item = { kind: "email", value: interpretation.email, createdAt };
  } else if (candidate.kind === "entity") {
    const value = canonicalEntityValue(trimmed);
    if (value) item = { kind: "entity", value, createdAt };
  }
  if (!item) return null;
  return utf8ByteLength(JSON.stringify(item)) <=
    SHARED_INBOX_POLICY.maxItemBytes
    ? item
    : null;
}

/**
 * Parse and canonicalize an App-Group queue. Legacy shapes, arbitrary text,
 * stale/future items, oversized payloads, and malformed data are discarded.
 */
export function parseSharedItems(
  raw: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): SharedItem[] {
  if (
    !raw ||
    typeof raw !== "string" ||
    utf8ByteLength(raw) > SHARED_INBOX_POLICY.maxQueueBytes
  ) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const result: SharedItem[] = [];
  for (const entry of parsed.slice(-SHARED_INBOX_POLICY.maxQueueItems)) {
    const normalized = normalizeSharedItem(entry, nowSeconds);
    if (normalized) result.push(normalized);
  }
  return fitQueueToByteLimit(result);
}

function fitQueueToByteLimit(items: SharedItem[]): SharedItem[] {
  const queue = items.slice(-SHARED_INBOX_POLICY.maxQueueItems);
  while (
    queue.length > 0 &&
    utf8ByteLength(JSON.stringify(queue)) > SHARED_INBOX_POLICY.maxQueueBytes
  ) {
    queue.shift();
  }
  return queue;
}

export type SharedAction = { type: "navigate"; href: Href };

/** Map an already-bounded shared item to its in-app action. */
export function actionForSharedItem(item: SharedItem): SharedAction | null {
  const normalized = normalizeSharedItem(item, Math.floor(Date.now() / 1000));
  if (!normalized) return null;
  const result = interpretClipboardOrQr(normalized.value);
  if (normalized.kind === "entity" && result.kind === "entity") {
    return { type: "navigate", href: result.href as Href };
  }
  if (normalized.kind === "email" && result.kind === "email") {
    return {
      type: "navigate",
      href: {
        pathname: "/(tabs)/subscribers",
        params: { q: result.email },
      } as unknown as Href,
    };
  }
  // Generic URLs are deliberately unsupported: reopening an arbitrary URL
  // is not a Moosewave action and does not justify retaining it in App Group.
  return null;
}

let storage: ExtensionStorage | null = null;

function getStorage(): ExtensionStorage | null {
  if (Platform.OS !== "ios") return null;
  if (storage) return storage;
  try {
    storage = new ExtensionStorage(APP_GROUP);
    return storage;
  } catch {
    storage = null;
    return null;
  }
}

function resetStorageAfterFailure(): void {
  storage = null;
}

function persistQueue(st: ExtensionStorage, items: SharedItem[]): void {
  if (items.length === 0) {
    st.remove(SHARED_KEY);
    if (st.get(SHARED_KEY) !== null) {
      throw new Error("Shared inbox deletion did not persist");
    }
    return;
  }
  const raw = JSON.stringify(fitQueueToByteLimit(items));
  if (utf8ByteLength(raw) > SHARED_INBOX_POLICY.maxQueueBytes) {
    throw new Error("Shared inbox exceeded its byte budget");
  }
  st.set(SHARED_KEY, raw);
  if (st.get(SHARED_KEY) !== raw) {
    throw new Error("Shared inbox write did not persist");
  }
}

/**
 * Atomically take the newest live item. Canonical cleanup is committed before
 * returning it, so a storage failure cannot process a duplicate while leaving
 * the original in App Group.
 */
export function takeSharedInboxItem(): SharedItem | null {
  const st = getStorage();
  if (!st) return null;
  try {
    // The v1 queue may contain arbitrary plaintext. Delete it on every read;
    // it is intentionally not migrated into the stricter schema.
    st.remove(LEGACY_SHARED_KEY);
    const items = parseSharedItems(st.get(SHARED_KEY));
    const item = items.pop() ?? null;
    persistQueue(st, items);
    return item;
  } catch {
    resetStorageAfterFailure();
    return null;
  }
}

/**
 * How many LIVE items remain queued, or null when the queue could not be read.
 *
 * NATIVE#47: the app drains one item per foreground, so sharing three links in
 * a row strands two of them with nothing on screen to say so. The consumer
 * needs a bounded count to offer "2 more shared items are waiting · Open next".
 *
 * Deliberately returns `null` rather than 0 on an unavailable App Group or a
 * storage fault: "we could not look" and "there is nothing there" are different
 * facts, and only the second one may be stated to the user. Reads through the
 * same parser as takeSharedInboxItem, so expired, oversized and malformed
 * entries are never counted — but does NOT rewrite the queue, because counting
 * is not a consumption event.
 */
export function pendingSharedInboxCount(): number | null {
  const st = getStorage();
  if (!st) return null;
  try {
    return parseSharedItems(st.get(SHARED_KEY)).length;
  } catch {
    resetStorageAfterFailure();
    return null;
  }
}

/** Put a still-live failed item back at the newest end without extending TTL. */
export function restoreSharedInboxItem(item: SharedItem): boolean {
  const st = getStorage();
  if (!st) return false;
  try {
    st.remove(LEGACY_SHARED_KEY);
    const now = Math.floor(Date.now() / 1000);
    const normalized = normalizeSharedItem(item, now);
    const items = parseSharedItems(st.get(SHARED_KEY), now);
    if (normalized) items.push(normalized);
    persistQueue(st, fitQueueToByteLimit(items));
    return Boolean(normalized);
  } catch {
    resetStorageAfterFailure();
    return false;
  }
}

/**
 * Verify physical removal of both queue generations during account teardown.
 */
export function clearSharedInbox(): boolean {
  if (Platform.OS !== "ios") return true;
  const st = getStorage();
  if (!st) return false;
  let success = true;
  for (const key of [SHARED_KEY, LEGACY_SHARED_KEY]) {
    try {
      st.remove(key);
      if (st.get(key) !== null) success = false;
    } catch {
      success = false;
    }
  }
  if (!success) resetStorageAfterFailure();
  return success;
}

/** Reject account-cleanup completion unless both queues are absent. */
export async function clearSharedInboxStrict(): Promise<void> {
  // DEMO MODE: an App Group that was never provisioned holds nothing to wipe.
  //
  // A simulator build signed with no development team gets an EMPTY
  // entitlements dict (verified with `codesign -d --entitlements`), so
  // `group.com.moosewave.app` does not exist and this clear can only fail. That
  // failure is reported as an incomplete sign-out, which sets the DURABLE
  // `SECURE_KEY_CLEANUP_PENDING` marker, which refuses every later sign-in --
  // so one unprovisioned container permanently locks the app out of itself.
  //
  // Production is unaffected: demoModeEnabled() is false there, and a real
  // failure to wipe a REAL container must still fail loudly. See lib/demoMode.
  if (DEMO_MODE) return;
  if (!clearSharedInbox()) {
    throw new Error("Share inbox App Group cleanup is incomplete");
  }
}
