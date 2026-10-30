/**
 * lib/pushApprovalDecision.ts — acting on a notification without a React tree.
 *
 * The two functions here run in the one situation the rest of the app cannot
 * assume: the process may have been woken by a notification tap or an action
 * button with no navigator, no query client and no rendered screen. Both
 * therefore reach the SDK factory directly rather than through a hook.
 *
 * Split out of lib/push.ts (NATIVE#54) so the registration lifecycle and the
 * cold-start response path stop sharing one module — they have entirely
 * different callers and entirely different failure modes.
 */
import * as Notifications from "expo-notifications";

import { getClient } from "@/api/sdkClient";
import { useAuthStore } from "@/store/auth";

/**
 * lastNotificationResponse — the response (tap or action button) that opened
 * the app from a cold start. app/_layout.tsx reads this once after hydration
 * so a notification tapped while the app was killed still routes (and an
 * Approve/Reject taken from the lock screen while the app was killed still
 * runs its decision). Foreground/background responses arrive via
 * addNotificationResponseReceivedListener instead.
 */
export async function lastNotificationResponse(): Promise<Notifications.NotificationResponse | null> {
  return Notifications.getLastNotificationResponseAsync();
}

/**
 * decideApprovalFromNotification — POST the approve/reject decision for an
 * approval push action straight to the API. Uses the SDK client directly
 * (NOT a hook) because the app may be backgrounded / killed when the user
 * taps the action, so there's no React tree to host useApprovalDecision.
 * Mirrors the wire contract in src/hooks/useApprovals.ts:
 *   POST /api/v1/approvals/{id}/decision   body: { decision, notes? }
 * Resolves true on success; false on any failure (already-decided, expired,
 * offline) so the caller can decide whether to surface a confirmation.
 *
 * `notes` is the mandatory reject reason (GOVERNANCE#37). It is passed through
 * verbatim — the handler stores it and the requester reads it — and the CALLER
 * is responsible for never reaching here with a reasonless reject; see
 * `pushRejectPlan`. Sending the field only when it has content keeps this path
 * byte-identical to the in-app one, which also omits an empty `notes` rather
 * than writing an empty string over a previous value.
 */
export async function decideApprovalFromNotification(
  id: string,
  decision: "approve" | "reject",
  notes?: string,
): Promise<boolean> {
  if (!id) return false;
  if (!useAuthStore.getState().isAuthenticated()) return false;
  try {
    const { client } = getClient();
    const trimmed = (notes ?? "").trim();
    await client.approvals.decide(
      id,
      trimmed ? { decision, notes: trimmed } : { decision },
    );
    return true;
  } catch {
    return false;
  }
}
