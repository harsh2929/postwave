/**
 * lib/pushTopics.ts — per-event push preferences.
 *
 * Push was a single all-or-nothing switch. `lib/push.ts` sent
 * `enabled_events: [...PUSH_DEVICE_EVENTS]` where that constant was computed
 * ONCE at module load from `defaultEnabledEvents()` — nothing in the UI could
 * change it. The endpoint has always accepted a per-event array (16-value enum,
 * maxItems 16), and desktop exposes per-topic switches. So a user who wanted
 * approval pings but not bounce pings had exactly one option: turn push off
 * entirely, permanently.
 *
 * The event catalogue comes from the shared @postwave/notifications manifest —
 * never a mobile-local hardcoded list — so the topics a phone can subscribe to
 * stay in lockstep with the canonical notification catalog.
 *
 * Storage is AsyncStorage under a DEVICE-level key, deliberately not scoped to
 * an identity: "don't buzz this phone for bounces" is a property of the phone
 * and its owner's attention, not of a workspace, and re-deriving it per tenant
 * would silently restore unwanted alerts on every workspace switch.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  NOTIFICATIONS,
  channelEligible,
  defaultEnabledEvents,
  type NotificationCategory,
} from "@postwave/notifications";

import { NEW_DEVICE_SIGN_IN_EVENT } from "@/lib/pushSecuritySession";

const STORAGE_KEY = "postwave.push_topics.v1";

/**
 * Account-security delivery is not an ordinary preference. A compatible
 * client always registers this event; an old installed client still omits it
 * because that older binary does not know this constant or channel id.
 */
export const REQUIRED_PUSH_EVENTS = [NEW_DEVICE_SIGN_IN_EVENT] as const;

export function isRequiredPushEvent(event: string): boolean {
  return REQUIRED_PUSH_EVENTS.some((required) => required === event);
}

function withRequiredPushEvents(selection: readonly string[]): string[] {
  const eligible = new Set(pushEligibleEvents());
  const out = selection.filter((event) => eligible.has(event));
  for (const required of REQUIRED_PUSH_EVENTS) {
    if (eligible.has(required) && !out.includes(required)) out.unshift(required);
  }
  return out.slice(0, MAX_PUSH_TOPICS);
}

/** Every manifest event that the push channel can actually deliver. */
export function pushEligibleEvents(): string[] {
  return Object.keys(NOTIFICATIONS)
    .filter((event) => channelEligible(event, "push"))
    .sort();
}

/**
 * The most topics a selection can hold — which is simply "all of them".
 *
 * This was the literal `16`, described as a server limit. It is not one:
 * `normalizeDeviceEvents` (apps/api/internal/mobilepush/devices.go) validates
 * each entry against `allowedDeviceEvents` and de-duplicates, but imposes no
 * count cap, and the only size bound anywhere on that path is the 16 KiB
 * request body. `16` was the number of manifest events on the day it was
 * written, and it silently became a TRUNCATION the moment the manifest grew:
 * COMMERCE#3 and COMMERCE#4 took the set to 18, so a user with everything
 * switched on would have had two topics quietly dropped from the registration —
 * including, depending on sort order, the billing alert.
 *
 * Deriving it removes the failure mode entirely: a cap equal to the number of
 * things that can be selected can never cut a valid selection short, and it
 * still bounds anything read back out of storage.
 */
export const MAX_PUSH_TOPICS = pushEligibleEvents().length;

/** The out-of-the-box selection: push-eligible AND on by default. */
export function defaultPushSelection(): string[] {
  const eligible = new Set(pushEligibleEvents());
  return defaultEnabledEvents()
    .filter((event) => eligible.has(event))
    .slice(0, MAX_PUSH_TOPICS);
}

export interface PushTopicGroup {
  category: NotificationCategory;
  events: { event: string; title: string; body: string }[];
}

/**
 * Push-eligible events grouped by manifest category, so the settings UI reads
 * as "Approvals / Campaigns / Subscribers…" rather than 16 undifferentiated
 * switches. @postwave/notifications has no categoryForEvent helper — the
 * category is a field on the def.
 */
export function groupedPushTopics(): PushTopicGroup[] {
  const groups = new Map<NotificationCategory, PushTopicGroup>();
  for (const event of pushEligibleEvents()) {
    const def = NOTIFICATIONS[event];
    if (!def) continue;
    const existing = groups.get(def.category);
    const entry = {
      event,
      title: def.titleTemplate,
      body: def.bodyTemplate,
    };
    if (existing) existing.events.push(entry);
    else groups.set(def.category, { category: def.category, events: [entry] });
  }
  return [...groups.values()];
}

/**
 * Validate a stored selection.
 *
 * Returns null when there is no usable stored preference, which the caller must
 * treat as "use the defaults". An explicitly-empty raw selection remains
 * distinguishable here, but the storage/registration boundary adds mandatory
 * security events before it can reach the server.
 */
export function sanitizePushSelection(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const eligible = new Set(pushEligibleEvents());
  const out: string[] = [];
  for (const entry of raw) {
    // Drop events an older build stored that the manifest no longer has —
    // the server allowlist rejects the whole registration on one bad value.
    if (typeof entry !== "string" || !eligible.has(entry)) continue;
    if (!out.includes(entry)) out.push(entry);
    if (out.length >= MAX_PUSH_TOPICS) break;
  }
  return out;
}

/**
 * A one-line human description for a topic row.
 *
 * `bodyTemplate` is a TEMPLATE: three of the push-eligible entries contain a
 * `{campaignName}` placeholder that is filled from event context at send time.
 * Rendering it verbatim under a settings switch showed the user a raw
 * mustache token ("A recipient opened {campaignName}."), so placeholders are
 * resolved to a generic noun phrase here.
 */
export function topicDescription(template: string): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (_match, token: string) => {
    const words = token
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .replace(/[_-]+/gu, " ")
      .toLowerCase()
      .split(" ")
      .filter((word) => word && word !== "name" && word !== "id");
    return words.length ? `the ${words.join(" ")}` : "it";
  });
}

/**
 * The array that may be sent as `enabled_events`.
 *
 * THE EMPTY ARRAY IS NOT SENDABLE. `normalizeDeviceEvents` in
 * apps/api/internal/mobilepush/devices.go treats `len(input) == 0` as "the
 * client expressed no preference" and enables the server's own default set —
 * so registering with an empty allowlist subscribes the device to approvals,
 * sends, bounces, complaints, automation failures, sequence generation and
 * migrations: the exact opposite of every switch being off.
 *
 * "Send me nothing" therefore has to be expressed by turning the master push
 * switch off (which revokes the device registration). Any registration that
 * does happen carries at least the mandatory account-security event.
 */
export function ensureSendablePushSelection(
  selection: readonly string[],
): string[] {
  return selection.length > 0 ? [...selection] : defaultPushSelection();
}

/** Toggle one event within a selection, preserving the cap. */
export function togglePushTopic(
  selection: readonly string[],
  event: string,
  enabled: boolean,
): string[] {
  if (!enabled) {
    return withRequiredPushEvents(
      isRequiredPushEvent(event)
        ? selection
        : selection.filter((entry) => entry !== event),
    );
  }
  if (selection.includes(event)) return withRequiredPushEvents(selection);
  return withRequiredPushEvents([...selection, event]);
}

export async function readPushTopicSelection(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPushSelection();
    const parsed = sanitizePushSelection(JSON.parse(raw) as unknown);
    return parsed
      ? withRequiredPushEvents(parsed)
      : defaultPushSelection();
  } catch {
    return defaultPushSelection();
  }
}

/** Persist a selection. Returns false when the write failed so the caller can
 *  roll the switch back rather than showing a preference that won't survive. */
export async function writePushTopicSelection(
  selection: readonly string[],
): Promise<boolean> {
  const clean = withRequiredPushEvents(
    sanitizePushSelection([...selection]) ?? [],
  );
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/**
 * The array to send with a device registration. Called by lib/push.ts so a
 * re-registration always carries the user's current choice.
 *
 * Never returns `[]` — see `ensureSendablePushSelection` for why an empty
 * allowlist means "enable everything" on the wire.
 */
export async function resolveEnabledPushEvents(): Promise<string[]> {
  return withRequiredPushEvents(
    ensureSendablePushSelection(await readPushTopicSelection()),
  );
}
