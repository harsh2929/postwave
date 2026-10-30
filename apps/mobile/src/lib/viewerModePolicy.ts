/**
 * lib/viewerModePolicy.ts — the PURE rules for the "preview as viewer"
 * affordance.
 *
 * The app has always parsed `viewer_mode` and `can_use_viewer_mode` off
 * GET /api/v1/auth/me and persisted both on the session profile — and then read
 * neither. An admin who left the preview on from the desktop app opened mobile
 * to a silently read-only workspace with no badge, no toggle and no explanation
 * for why every write control had vanished.
 *
 * Two rules are worth stating in isolation (and testing without a renderer):
 *
 *  1. PATCH /api/v1/auth/me/viewer-mode is `x-required-auth-method: session`.
 *     An api-key install therefore cannot toggle it and must not be shown a
 *     switch that would 401.
 *  2. The exit path must never be gated on `can_use_viewer_mode`. That flag
 *     describes the caller's DURABLE role; if a deployment ever computes it
 *     from the effective role instead, an admin already inside the preview
 *     would lose the only control that gets them out. Being stuck read-only
 *     with no exit is a far worse failure than showing one extra row.
 */

export type ViewerModeMode = "session" | "api_key" | null;

export interface ViewerModeSessionFacts {
  mode: ViewerModeMode;
  /** `session.viewerMode` — the preview is currently active. */
  viewerMode: boolean;
  /** `session.canUseViewerMode` — the durable role may enter the preview. */
  canUseViewerMode: boolean;
}

export type ViewerModeGate =
  /** Render no control at all. */
  | { kind: "hidden" }
  /** Render the switch; `active` is its value. */
  | { kind: "available"; active: boolean; exitOnly: boolean };

export function viewerModeGate(facts: ViewerModeSessionFacts): ViewerModeGate {
  if (facts.mode !== "session") return { kind: "hidden" };
  if (facts.viewerMode) {
    // Always offer the exit, even if the capability flag says no.
    return { kind: "available", active: true, exitOnly: !facts.canUseViewerMode };
  }
  if (!facts.canUseViewerMode) return { kind: "hidden" };
  return { kind: "available", active: false, exitOnly: false };
}

/**
 * Should the app shell show a persistent "you are in a preview" badge?
 *
 * Takes only what it needs — the badge is about the state you are IN, never
 * about the capability to enter it, so a shell component does not have to read
 * `canUseViewerMode` just to render chrome.
 */
export function shouldShowViewerBadge(
  facts: Pick<ViewerModeSessionFacts, "mode" | "viewerMode">,
): boolean {
  return facts.mode === "session" && facts.viewerMode;
}

export const VIEWER_BADGE_LABEL = "Viewer preview";
export const VIEWER_BADGE_SPOKEN =
  "Viewer preview is on. This workspace is read-only until you exit it in Settings.";

/**
 * Copy for the outcome of a toggle. Kept here so the switch, the toast and any
 * future surface cannot drift into three different explanations of the same
 * server state.
 */
export function viewerModeToggleMessage(next: boolean): string {
  return next
    ? "Viewer preview is on — this workspace is read-only until you turn it off."
    : "Viewer preview is off. Your usual permissions are back.";
}

export function viewerModeFailureMessage(status: number | undefined): string {
  if (status === 403) {
    return "Your role can't use viewer preview on this workspace.";
  }
  if (status === 401) {
    return "Your session expired. Sign in again to change viewer preview.";
  }
  return "Couldn't change viewer preview. Check your connection.";
}
