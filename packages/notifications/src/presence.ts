/**
 * Wire types for the realtime `presence.update` event
 * (apps/api/internal/events/presence.go). Shared here — alongside the
 * notification manifest, the other realtime user-facing signal — so desktop
 * (and any future web/mobile presence indicator) stop re-declaring them
 * locally, which is how a Go↔TS field drift creeps in.
 */

/** One present user's structured identity (the `users_v2` entries). */
export interface PresenceUserV2 {
  id?: string;
  label?: string;
}

/** The `presence.update` payload the server broadcasts on the event bus. */
export interface PresencePayload {
  /** Number of users currently present (may include un-labelled placeholders). */
  count?: number;
  /** Legacy: flat list of display labels. Prefer `users_v2`. */
  users?: string[];
  /** Structured identities: `{ id, label }`. */
  users_v2?: PresenceUserV2[];
}
