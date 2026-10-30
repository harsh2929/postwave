/**
 * PresenceIndicator — small avatar stack showing who else is online in
 * the same tenant. Subscribes to `presence.update` events on the shared
 * realtime bus and mirrors the latest snapshot into the in-memory store
 * (so other surfaces can read without an extra bus subscription).
 *
 * Visual model: render up to N circles with initials, then a "+M more"
 * badge if there are extras. The labels are opaque server-supplied
 * strings — in production these are now real display names; the
 * synthetic "user-NNNN" placeholder only appears in no-auth dev mode
 * and is filtered into a neutral viewer count below.
 */

import { type ReactElement, useEffect, useMemo } from "react";

import type { PresencePayload } from "@postwave/notifications";

import {
  type EventBusMessage,
  useEventBus,
} from "../lib/event-bus";
import { setPresence, usePresence } from "../lib/store";

const MAX_AVATARS = 4;

// PresencePayload / PresenceUserV2 (the `presence.update` wire shape) now live
// in @postwave/notifications so desktop stops re-declaring them locally — the
// same Go↔TS drift hazard the notification manifest already de-duplicated.

/**
 * Server-side placeholder identity ("user-1234"). Production presence
 * now sends real display names; these synthetic labels are only
 * emitted in no-auth dev mode, where rendering them as teammate
 * avatars would fabricate identities ("U1") that don't exist. The
 * filter stays as a guard — placeholders fold into a neutral count.
 */
function isPlaceholderLabel(label: string): boolean {
  return /^user-\d+$/.test(label.trim());
}

function initials(label: string): string {
  if (!label) return "?";
  // "user-1234" -> "U1", "alice@x.com" -> "AL", "Alice Wong" -> "AW".
  const cleaned = label.split("@")[0]?.replace(/[-_]/g, " ").trim() ?? label;
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return label.slice(0, 2).toUpperCase();
  if (parts.length === 1) {
    const p = parts[0];
    return (p.slice(0, 2) || "??").toUpperCase();
  }
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/**
 * Standalone hook that wires a presence subscription into the store.
 * Mounting <PresenceIndicator /> is enough; this is exposed separately
 * for callers (toolbar overlays, status bars) that want the data
 * without rendering the avatar stack.
 */
export function usePresenceSubscription(): void {
  const { subscribe } = useEventBus();
  useEffect(() => {
    return subscribe("presence.update", (evt: EventBusMessage<PresencePayload>) => {
      const p = evt.payload ?? {};
      // Prefer the new structured shape (users_v2) when present; fall
      // back to the legacy bare-string list for backwards-compat.
      let users: string[];
      if (Array.isArray(p.users_v2) && p.users_v2.length > 0) {
        users = p.users_v2.map((u) => {
          const label = u && typeof u.label === "string" ? u.label : "";
          if (label) return label;
          return u && typeof u.id === "string" ? u.id : "";
        });
      } else {
        users = Array.isArray(p.users) ? p.users.slice() : [];
      }
      const count = typeof p.count === "number" ? p.count : users.length;
      setPresence({ count, users });
    });
  }, [subscribe]);
}

/**
 * Compact avatar-stack presence indicator. Renders nothing while the
 * count is 0 (or 1 — yourself doesn't count). The component is safe to
 * mount multiple times; presence state lives in the shared store and
 * the bus subscription is idempotent.
 */
export function PresenceIndicator(): ReactElement | null {
  usePresenceSubscription();
  const { count, users } = usePresence();

  // Placeholder identities ("user-1234") never get an avatar — only
  // real labels render initials. Visible window + overflow count are
  // computed separately so the layout stays stable when users
  // join/leave at the boundary.
  const realLabels = useMemo(
    () => users.filter((u) => !isPlaceholderLabel(u)),
    [users],
  );
  const visible = useMemo(
    () => realLabels.slice(0, MAX_AVATARS),
    [realLabels],
  );
  const overflow = Math.max(0, count - visible.length);

  if (count <= 1) return null;

  // All-placeholder snapshot: hide the avatar stack entirely and show
  // a neutral viewer count instead of fake initials.
  if (visible.length === 0) {
    return (
      <div
        className="presence-indicator"
        role="status"
        aria-live="polite"
        aria-label={`${count} collaborators online`}
        style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      >
        <span
          className="presence-overflow"
          style={{
            fontSize: 11,
            color: "var(--pw-fg-muted)",
            fontWeight: 500,
          }}
        >
          {count} viewing
        </span>
      </div>
    );
  }

  return (
    <div
      className="presence-indicator"
      role="status"
      aria-live="polite"
      aria-label={`${count} collaborators online`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
    >
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
        }}
      >
        {visible.map((label, i) => (
          <span
            key={`${label}-${i}`}
            title={label}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: "var(--pw-accent)",
              color: "var(--pw-accent-fg)",
              fontSize: 10,
              fontWeight: 600,
              border: "1.5px solid var(--pw-bg)",
              marginLeft: i === 0 ? 0 : -6,
              userSelect: "none",
            }}
          >
            {initials(label)}
          </span>
        ))}
      </div>
      {overflow > 0 ? (
        <span
          className="presence-overflow"
          style={{
            fontSize: 11,
            color: "var(--pw-fg-muted)",
            fontWeight: 500,
          }}
        >
          +{overflow} more
        </span>
      ) : null}
    </div>
  );
}
