/**
 * lib/presence.ts — "who else is here", decoded.
 *
 * The server has tracked presence since the desktop avatar stack landed
 * (apps/api/internal/events/presence.go): every open /api/v1/events
 * subscription increments a per-tenant counter and broadcasts a
 * `presence.update` event, and a subscription that passes `?entity=` is ALSO
 * registered against that record and broadcast on `presence.entity`.
 *
 * Mobile held one of those connections open the whole time (lib/eventCacheSync
 * opens it at launch) and read none of it: the phone incremented a counter
 * every other client rendered and could not see its own. Desktop
 * (components/PresenceIndicator.tsx) and web (lib/realtime/use-presence.ts)
 * both consume it; this is the third reader.
 *
 * Everything here is pure and import-free of react-native, so the wire rules —
 * which are the part that drifts against Go — are unit tested under node. The
 * wire TYPES are the shared `@postwave/notifications` ones rather than a
 * fourth local re-declaration, which is the drift the package exists to stop.
 */
import type { PresencePayload, PresenceUserV2 } from "@postwave/notifications";

/** Workspace-wide presence. Every open subscription contributes. */
export const PRESENCE_TOPIC = "presence.update";
/** Per-record presence; only `?entity=`-scoped subscriptions contribute. */
export const PRESENCE_ENTITY_TOPIC = "presence.entity";

/**
 * How many viewers we are willing to hold and render. The payload fans out to
 * every session in the tenant and is bounded only by the number of open
 * sockets, so a large workspace (or a runaway client) can produce a list no
 * phone should be laying out. The COUNT is still reported honestly — only the
 * rendered identities are capped.
 */
export const MAX_PRESENCE_VIEWERS = 8;

export interface PresenceViewer {
  /** Server user id, or null for an un-authenticated/dev placeholder row. */
  id: string | null;
  /** Privacy-safe display label (email local-part). Never a full address. */
  label: string;
}

export interface PresenceSnapshot {
  /** Connections present, as the server counts them. Never negative. */
  count: number;
  /** Bounded identities, in server order. May be shorter than `count`. */
  viewers: PresenceViewer[];
  /** True when `viewers` was truncated — the UI must not imply completeness. */
  truncated: boolean;
}

export const EMPTY_PRESENCE: PresenceSnapshot = {
  count: 0,
  viewers: [],
  truncated: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Defence in depth. The server deliberately emits only the email local-part
  // (presenceDisplayLabel), because presence fans out to every session in the
  // tenant; if a full address ever reaches us anyway, we are not the surface
  // that turns it into a harvesting list.
  const at = trimmed.indexOf("@");
  return at > 0 ? trimmed.slice(0, at) : trimmed;
}

/**
 * Normalise the wire payload into something a component can render.
 *
 * Wire shape notes, all load-bearing:
 *  - `users_v2` (structured) is preferred; `users` (flat labels) is the legacy
 *    field the same event still carries. Reading only `users` would lose the
 *    id, which is what makes self-exclusion possible.
 *  - `count` counts CONNECTIONS, not humans: one person with the phone and the
 *    desktop open is 2. We do not "fix" that by deduping — the server's number
 *    is the number every other client shows, and disagreeing with it is worse
 *    than the imprecision.
 *  - a payload that is not an object, or that carries no usable field at all,
 *    returns null so a caller can leave the previous snapshot alone rather
 *    than blanking a good one on a malformed frame.
 */
export function parsePresencePayload(
  payload: unknown,
): PresenceSnapshot | null {
  if (!isRecord(payload)) return null;
  const wire = payload as PresencePayload;

  const rawV2 = Array.isArray(wire.users_v2)
    ? (wire.users_v2 as PresenceUserV2[])
    : null;
  const rawLegacy = Array.isArray(wire.users) ? wire.users : null;
  const hasCount = typeof wire.count === "number" && Number.isFinite(wire.count);
  if (!rawV2 && !rawLegacy && !hasCount) return null;

  const all: PresenceViewer[] = rawV2
    ? rawV2.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const label = cleanLabel(entry.label);
        const id = typeof entry.id === "string" && entry.id ? entry.id : null;
        if (!label && !id) return [];
        return [{ id, label: label ?? "Someone" }];
      })
    : (rawLegacy ?? []).flatMap((entry) => {
        const label = cleanLabel(entry);
        return label ? [{ id: null, label }] : [];
      });

  const count = hasCount
    ? Math.max(0, Math.floor(wire.count as number))
    : all.length;

  return {
    count,
    viewers: all.slice(0, MAX_PRESENCE_VIEWERS),
    truncated: all.length > MAX_PRESENCE_VIEWERS,
  };
}

/** The `entity_ref` an entity-scoped payload was published for, if any. */
export function presenceEntityRef(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const ref = payload.entity_ref;
  return typeof ref === "string" && ref.trim() ? ref.trim() : null;
}

/**
 * Build the `?entity=` ref for a record. The grammar is `kind:id`, matching
 * what web sends (`"campaign:abc"`); the server treats it as an opaque key, so
 * the ONLY thing that matters is that every client building a ref for the same
 * record builds the same string.
 */
export function presenceEntityRefFor(
  kind: string,
  id: string | null | undefined,
): string | null {
  const k = kind.trim();
  const i = (id ?? "").trim();
  if (!k || !i) return null;
  return `${k}:${i}`;
}

/**
 * Drop the viewer that is us. Presence is only interesting as "someone ELSE is
 * here", and the server counts connections, so our own row is always in the
 * list. The COUNT is reduced by exactly one when a matching row is found —
 * never below zero, and never at all when we cannot identify ourselves (an
 * unknown self must not silently make the number wrong).
 */
export function excludeSelf(
  snapshot: PresenceSnapshot,
  selfUserId: string | null | undefined,
): PresenceSnapshot {
  const self = (selfUserId ?? "").trim();
  if (!self) return snapshot;
  const viewers = snapshot.viewers.filter((v) => v.id !== self);
  const removed = snapshot.viewers.length - viewers.length;
  return {
    count: Math.max(0, snapshot.count - (removed > 0 ? 1 : 0)),
    viewers,
    truncated: snapshot.truncated,
  };
}

/** Up to two initials for an avatar bubble; "?" when there is nothing to use. */
export function presenceInitials(label: string): string {
  const parts = label
    .split(/[\s._-]+/u)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return "?";
  const first = [...(parts[0] ?? "")][0] ?? "";
  const second = parts.length > 1 ? ([...(parts[1] ?? "")][0] ?? "") : "";
  const initials = `${first}${second}`.toUpperCase();
  return initials || "?";
}

export interface PresenceSummary {
  /** Short on-screen label, e.g. "2 others here". */
  label: string;
  /** The spoken sentence — a stack of bubbles is never the only signal. */
  accessibilityLabel: string;
}

/**
 * The sentence for a presence chip, or null when there is nobody else to
 * mention. Null (rather than "0 others") is deliberate: presence is advisory,
 * and a permanent "you are alone" badge is noise on every screen it sits on.
 */
export function presenceSummary(
  snapshot: PresenceSnapshot,
  scope: "workspace" | "record" = "workspace",
): PresenceSummary | null {
  if (snapshot.count <= 0) return null;
  const named = snapshot.viewers.map((v) => v.label).filter(Boolean);
  const where = scope === "record" ? "viewing this" : "in this workspace";
  const label =
    snapshot.count === 1 ? "1 other here" : `${snapshot.count} others here`;

  if (named.length === 0) {
    return {
      label,
      accessibilityLabel:
        snapshot.count === 1
          ? `1 other person ${where}`
          : `${snapshot.count} other people ${where}`,
    };
  }
  // Name who we know; say plainly that the rest are unnamed rather than
  // implying the list is everyone.
  const extra = snapshot.count - named.length;
  const people =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  const tail = extra > 0 ? ` and ${extra} more` : "";
  return {
    label,
    accessibilityLabel: `${people}${tail} ${where}`,
  };
}
