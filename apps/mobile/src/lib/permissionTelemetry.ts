/**
 * lib/permissionTelemetry.ts — one line per OS permission decision.
 *
 * NATIVE#56: the native cluster's health was invisible. Push registration did
 * emit `mobile.push_registration_completed`, but it collapses a DENIED prompt,
 * a simulator and a token-mint failure into the single outcome `unavailable`,
 * so "what share of people refuse notifications?" — the question that decides
 * whether actionable push is worth building on — had no answer at all. Camera
 * permission for the QR scanner had no event of any kind.
 *
 * Its own module rather than a helper inside lib/push.ts for two reasons: the
 * scanner needs it too (and must not import the push stack to get it), and
 * push.ts is close to its source budget.
 *
 * Structural only. `kind` names the permission, `outcome` is a closed enum.
 * Nothing about the user, the workspace, or the scanned payload rides along —
 * both keys are already on lib/telemetry's SAFE_PROPERTY_KEYS allowlist, and
 * anything else would be dropped there anyway.
 */
import { EVENTS } from "@postwave/telemetry";

import { track } from "./telemetry";

/** The OS permissions this app asks for. */
export type PermissionKind = "notifications" | "camera";

/**
 * `already_granted` is separated from `granted` deliberately: only the latter
 * is a PROMPT result, and mixing them makes the refusal rate meaningless after
 * the first launch. `unsupported` is a simulator or a device without the
 * capability — never a user decision.
 */
export type PermissionOutcome =
  | "already_granted"
  | "granted"
  | "denied"
  | "unsupported";

export function trackPermissionOutcome(
  kind: PermissionKind,
  outcome: PermissionOutcome,
): void {
  track(EVENTS.MOBILE_PERMISSION_OUTCOME, { kind, outcome });
}
