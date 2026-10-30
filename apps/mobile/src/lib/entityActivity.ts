/**
 * lib/entityActivity.ts — what an opened entity may disclose to iOS.
 *
 * SHELL#31. Every campaign, sequence and subscriber the user opens is a
 * candidate NSUserActivity: donate it and the entity becomes findable from
 * Spotlight and handed off to a Mac mid-task. Neither client did this, even
 * though the URL half was already built (`buildUniversalLink`, plus
 * `ios.associatedDomains` in app.json).
 *
 * The reason this is a POLICY module rather than three lines in a screen is
 * that a donation leaves the app's authentication gate. Two facts follow:
 *
 *   1. AN APP LOCK REVOKES IT. The widget bridge already treats enabling the
 *      app lock as withdrawal of out-of-app disclosure (lib/widgetData.ts);
 *      donating a workspace's campaign titles to the device search index while
 *      the app itself demands Face ID would be incoherent. Callers that have
 *      not yet READ the lock state must pass `appLockEnabled: true` — unknown
 *      is treated as locked, never as permission.
 *
 *   2. NOT EVERY ENTITY MAY BE INDEXED. Handoff is ephemeral and travels only
 *      between the user's own signed-in devices. Spotlight indexing is
 *      persistent, on-device and survives sign-out until something deletes it,
 *      so it is limited to entities whose title is workspace content the user
 *      authored. A subscriber's title is a person's identity and an approval's
 *      is a pending decision; those are handed off but never indexed, and they
 *      contribute no keywords.
 *
 * Pure and import-free apart from the shared route registry, so every rule
 * above is node-tested. The native side lives in lib/entityActivityBridge.ts.
 */
import { buildDeepLink, buildUniversalLink, getEntity } from "@postwave/route-map";

/** Bounded so a pathological name cannot bloat the donated activity. */
export const MAX_ACTIVITY_TITLE_CHARS = 120;
export const MAX_ACTIVITY_DESCRIPTION_CHARS = 200;

export interface EntityActivityDisclosure {
  /** Continue on another of the user's own devices. Ephemeral. */
  handoff: boolean;
  /** Persist in the on-device search index. Survives sign-out. */
  spotlight: boolean;
}

/**
 * Per-entity disclosure. Keyed by the canonical entity key from
 * @postwave/route-map, so a new entity is opt-IN by omission: anything not
 * listed here is not donated at all.
 */
export const ENTITY_ACTIVITY_DISCLOSURE: Readonly<
  Record<string, EntityActivityDisclosure>
> = Object.freeze({
  campaign: { handoff: true, spotlight: true },
  sequence: { handoff: true, spotlight: true },
  // A person's identity. Resumable on the user's own Mac; never written to a
  // search index that outlives the session.
  subscriber: { handoff: true, spotlight: false },
  // A pending decision, and one the viewer may lose the right to see.
  approval: { handoff: true, spotlight: false },
});

/** Human label used when an entity has no readable name yet. */
const ENTITY_FALLBACK_TITLE: Readonly<Record<string, string>> = Object.freeze({
  campaign: "Campaign",
  sequence: "Sequence",
  subscriber: "Subscriber",
  approval: "Approval",
});

export interface EntityActivityInput {
  /** Canonical entity key, e.g. "campaign". */
  entity: string;
  id: string;
  /** The entity's display name. Absent while it is still loading. */
  title?: string | null | undefined;
  /** One supporting line — a subject, a status, a step count. */
  subtitle?: string | null | undefined;
  /**
   * Whether the app lock is armed. MUST be true whenever the answer is not yet
   * known: this is a disclosure gate, and "we have not checked" is not consent.
   */
  appLockEnabled: boolean;
}

export interface EntityActivityDescriptor {
  /** Stable identifier — also the handle used to revoke the donation. */
  id: string;
  title: string;
  /** Null, never "", when there is nothing to say. */
  description: string | null;
  /** What ANOTHER device continues to (the web dashboard route). */
  webpageURL: string;
  /** What THIS app resumes to, through the existing deep-link parser. */
  href: string;
  keywords: string[];
  isEligibleForHandoff: boolean;
  isEligibleForSearch: boolean;
}

/** Collapse whitespace, drop control characters, and bound the length. */
function cleanText(value: string | null | undefined, max: number): string {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > max ? normalized.slice(0, max).trim() : normalized;
}

/**
 * The donation handle for an entity. Deliberately derived from entity+id
 * rather than a route path, so the same entity opened from a deep link, a
 * search result and a list row is ONE activity rather than three.
 */
export function entityActivityId(entity: string, id: string): string {
  return `postwave.entity.${entity}.${id}`;
}

/**
 * Anything that could be a personal identifier, and therefore must not be
 * written into a persistent device-wide search index as a keyword.
 */
function looksPersonal(value: string): boolean {
  return value.includes("@") || /\+?\d[\d\s().-]{6,}/.test(value);
}

/** Keywords for the search index — only for entities eligible for it. */
function activityKeywords(
  disclosure: EntityActivityDisclosure,
  title: string,
): string[] {
  if (!disclosure.spotlight) return [];
  const words = [title, "Moosewave"].filter(
    (word) => word.length > 0 && !looksPersonal(word),
  );
  return [...new Set(words)];
}

/**
 * Build the activity to donate, or null when nothing may be donated.
 *
 * Null (rather than a partial descriptor) for: an armed app lock, an entity
 * with no disclosure entry, and an id the shared route registry rejects —
 * `buildUniversalLink` applies the same `isSafeResourceId` allow-list the
 * desktop deep-link grammar does, so a smuggled path segment cannot become a
 * donated URL.
 */
export function entityActivityDescriptor(
  input: EntityActivityInput,
): EntityActivityDescriptor | null {
  if (input.appLockEnabled) return null;

  const def = getEntity(input.entity);
  if (!def) return null;
  const disclosure = ENTITY_ACTIVITY_DISCLOSURE[def.key];
  if (!disclosure || (!disclosure.handoff && !disclosure.spotlight)) return null;

  // `id` is TYPED `string`, and at runtime it frequently is not: every caller
  // reads it from `useLocalSearchParams`, which answers `undefined` for a
  // malformed deep link — the exact case the detail screens have a
  // "campaign not found" state for. `isSafeResourceId` does `id.length`, so
  // without this the donation path throws inside a passive effect and takes
  // the whole screen to the route error boundary: a bad link would render as
  // a crash instead of as the way-out the screen already has.
  if (typeof input.id !== "string" || input.id === "") return null;

  const webpageURL = buildUniversalLink(def.key, input.id);
  const href = buildDeepLink(def.key, input.id);
  if (!webpageURL || !href) return null;

  // Never the raw id: an opaque identifier in the Dock or in Spotlight tells
  // the user nothing and tells anyone else that the record exists.
  const title =
    cleanText(input.title, MAX_ACTIVITY_TITLE_CHARS) ||
    ENTITY_FALLBACK_TITLE[def.key] ||
    "Moosewave";
  const description = cleanText(
    input.subtitle,
    MAX_ACTIVITY_DESCRIPTION_CHARS,
  );

  return {
    id: entityActivityId(def.key, input.id),
    title,
    description: description || null,
    webpageURL,
    href,
    keywords: activityKeywords(disclosure, title),
    isEligibleForHandoff: disclosure.handoff,
    isEligibleForSearch: disclosure.spotlight,
  };
}
