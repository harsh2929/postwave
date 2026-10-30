import {
  getNotification,
  notificationTopicDestination,
} from "@postwave/notifications";
import { parseDeepLink, parseUniversalLink } from "@postwave/route-map";

import {
  getNotificationCenterSnapshot,
  isNotificationCenterEntryId,
  markNotificationRead,
  type DesktopNotificationCategory,
  type NotificationCenterEntry,
} from "./notification-center";
import {
  navigateDesktopSection,
  navigateDesktopSectionResource,
} from "./desktop-router";
import type { Section } from "./store";

export interface NotificationDestination {
  section: Section;
  resourceId?: string;
}

/**
 * Category → the section a notification of that category falls back to when it
 * carries no resolvable entity deep link.
 *
 * TOTAL BY CONSTRUCTION, and it has to be: `DesktopNotificationCategory` is
 * derived from the SHARED @postwave/notifications manifest, so every category
 * added there for any client lands here as a missing key. That is the intended
 * pressure — but it went unnoticed once already (COMMERCE#3/#4 added
 * `integrations` and `billing` and left this file failing `tsc` with TS2739),
 * so the entries below exist to keep the seam honest rather than because
 * desktop routes those categories today: `DESKTOP_NOTIFICATION_TOPICS` admits
 * five topics, and `categoryForTopic` can only ever produce approvals,
 * campaigns, subscribers or analytics from them. Each fallback still names the
 * screen a person would actually need if the topic set ever widens.
 */
const CATEGORY_SECTIONS: Record<DesktopNotificationCategory, Section> = {
  approvals: "approvals",
  campaigns: "campaigns",
  subscribers: "subscribers",
  automations: "sequences",
  migrations: "migrations",
  forms: "forms",
  analytics: "analytics",
  // Plan state and the payment method live under settings; desktop ships no
  // dedicated billing section.
  billing: "settings",
  // Both events in the category are outbound delivery destinations that stopped
  // accepting data; the outbound-webhooks screen is the one that shows endpoint
  // health. (Audit sinks have their own `auditSinks` section, but a category
  // resolves to exactly one fallback.)
  integrations: "outboundWebhooks",
  // DELIVERABILITY#15 — the hub is where the score, the breach list and the
  // auto-throttle state are rendered.
  deliverability: "deliverabilityHub",
  // Account sign-ins and session revocations are managed in Settings. The
  // settings navigator keeps Security as the canonical subsection there.
  security: "settings",
};

const CATEGORY_ENTITIES: Partial<Record<DesktopNotificationCategory, string>> =
  {
    approvals: "approval",
    campaigns: "campaign",
    subscribers: "subscriber",
    automations: "sequence",
  };

/** Resolve only shared, allowlisted deep links; malformed targets fall back. */
export function destinationForNotification(input: {
  category: DesktopNotificationCategory;
  deepLink: string | null;
  eventType?: string;
}): NotificationDestination {
  // Content-light topics have a fixed client-owned destination. In
  // particular, never interpret the SMS adapter's web path (or any PII a
  // malformed producer appended to it) as desktop navigation state.
  const topicSection = notificationTopicDestination(input.eventType, "desktop");
  if (topicSection) return { section: topicSection };

  // Both grammars resolve here. The vault stores `moosewave://entity/id`; the
  // SERVER feed stores a web path (`/app/campaigns/<id>`), and rows raised on
  // another device arrive with the latter. Parsing only the custom scheme sent
  // every cross-device notification to its category fallback instead of the
  // record it names.
  const parsed = input.deepLink
    ? input.deepLink.startsWith("moosewave://")
      ? parseDeepLink(input.deepLink)
      : parseUniversalLink(input.deepLink)
    : null;
  if (!parsed || parsed.entity !== CATEGORY_ENTITIES[input.category]) {
    return { section: CATEGORY_SECTIONS[input.category] };
  }
  const sectionByEntity: Record<string, Section> = {
    approval: "approvals",
    campaign: "campaigns",
    subscriber: "subscribers",
    sequence: "sequences",
  };
  const section = sectionByEntity[parsed.entity];
  return section
    ? { section, resourceId: parsed.id }
    : { section: CATEGORY_SECTIONS[input.category] };
}

/** Mark and route one already-decrypted center entry through the typed router. */
export function openNotificationCenterEntry(
  entry: NotificationCenterEntry,
): void {
  markNotificationRead(entry.id);
  const destination = destinationForNotification({
    ...entry,
    eventType: entry.topic,
  });
  if (destination.resourceId) {
    navigateDesktopSectionResource(
      destination.section,
      destination.resourceId,
      { source: "deep-link" },
    );
    return;
  }
  navigateDesktopSection(destination.section);
}

/**
 * Open one row of the unified inbox.
 *
 * A row may be backed by a local vault entry, a server feed row, or both. Read
 * state is recorded through whichever side exists: `markNotificationRead` for a
 * local entry (which also propagates to the server through the installed
 * propagator), and the row's category fallback for a server-only row this
 * machine never received.
 */
let serverReadSink: ((serverId: string) => void) | null = null;

/**
 * Install the sink that marks a SERVER row read.
 *
 * Injected, not imported: the read path needs the API client and would drag the
 * router into every component that renders a notification. The shell installs
 * it; until then a server-only row opens but is not marked, which is the
 * behaviour that existed before the unified inbox.
 */
export function setServerNotificationReadSink(
  sink: ((serverId: string) => void) | null,
): void {
  serverReadSink = sink;
}

export function openUnifiedNotificationRow(row: {
  localId: string | null;
  serverId: string | null;
  eventType: string;
  deepLink: string | null;
}): void {
  if (row.localId) {
    const center = getNotificationCenterSnapshot();
    const entry = center.entries.find(
      (candidate) => candidate.id === row.localId,
    );
    if (entry) {
      openNotificationCenterEntry(entry);
      return;
    }
  }
  // Server-only: there is no vault entry, so the READ has to go straight to the
  // feed. Without this the dominant row type — most server notifications carry
  // a section link, so they correlate weakly and stay server-only — could never
  // be cleared from desktop at all.
  if (row.serverId) serverReadSink?.(row.serverId);
  // Route on the link alone. The category comes from the canonical event type
  // rather than the vault's topic vocabulary, because this row never had one.
  const destination = destinationForNotification({
    category: categoryForEventType(row.eventType),
    deepLink: row.deepLink,
    eventType: row.eventType,
  });
  if (destination.resourceId) {
    navigateDesktopSectionResource(
      destination.section,
      destination.resourceId,
      {
        source: "deep-link",
      },
    );
    return;
  }
  navigateDesktopSection(destination.section);
}

/**
 * Canonical server `event_type` → notification category, for rows with no local
 * entry to read a category from.
 *
 * Reads the SHARED @postwave/notifications manifest rather than a hand-written
 * switch. The switch this replaced mis-routed the majority of real event types:
 * `deliverability.*` and `auth.new_device_sign_in` both landed on the dashboard
 * instead of the deliverability hub and Settings→Security, and
 * `sequence.participants.stuck` — one of the only server notifications that
 * carries an entity-bearing URL — had its resource id thrown away because the
 * category did not match `CATEGORY_ENTITIES`. Three of its arms named event
 * types no producer emits at all.
 *
 * The manifest already owns this mapping for every registered event and stays
 * correct as it grows. `analytics` remains the default, and only the default.
 */
function categoryForEventType(eventType: string): DesktopNotificationCategory {
  const category = getNotification(eventType)?.category;
  return (category as DesktopNotificationCategory | undefined) ?? "analytics";
}

/**
 * Resolve an opaque native activation only inside the active identity's
 * decrypted center. A stale notification from another signed-in account has
 * no route or resource information in native memory and therefore safely
 * becomes a no-op after the window is focused.
 */
export function openNotificationCenterEntryById(id: unknown): boolean {
  if (!isNotificationCenterEntryId(id)) return false;
  const center = getNotificationCenterSnapshot();
  if (center.identity !== "ready") return false;
  const entry = center.entries.find((candidate) => candidate.id === id);
  if (!entry) return false;
  openNotificationCenterEntry(entry);
  return true;
}
