/**
 * lib/settingsCapabilities.ts — who may operate which settings control.
 *
 * The PURE half of `app/(tabs)/settings.tsx`, split the way `src/api/eventBus
 * .ts` grew `eventBusStream.ts`/`eventBusConnection.ts`. Seven independent
 * capability questions, asked one after another at the top of a 750-line
 * component, are the part of that screen with no React in them and the part
 * most worth asserting: each one decides whether a section RENDERS AT ALL, and
 * a wrong answer either hides a control an admin needs or offers one the
 * server will refuse.
 *
 * ONE OBJECT, NOT SEVEN CALLS. `hasRestrictedWorkspaceControls` is derived
 * from six of the others and drives the "some controls are hidden" notice; when
 * it was computed beside them in the screen, adding a seventh capability meant
 * remembering to widen the disjunction too. Answering all of them in one place
 * makes that a single edit.
 *
 * WHY `canManageApprovalGovernance` ASKS A DIFFERENT QUESTION. The approvals
 * governance handlers call `requireAdmin` server-side. That floor is mirrored
 * with the shared role helper rather than by inventing a capability key in the
 * orchestrator-owned route manifest.
 *
 * This module must stay free of react-native/expo imports so it keeps running
 * under `vitest --environment node`.
 */
import {
  canAccessMinimumRole,
  canAccessMobileCapability,
} from "./mobileRouteManifest";

/** The auth mode the session was established under. */
export type SettingsAccessMode = "api_key" | "session" | null;

export interface SettingsCapabilities {
  canManageWorkspace: boolean;
  canManageNotifications: boolean;
  canManageRetention: boolean;
  canManageWebhooks: boolean;
  canManageVoiceLabels: boolean;
  canManagePrivacy: boolean;
  /** Admin floor, mirroring the handlers' own `requireAdmin`. */
  canManageApprovalGovernance: boolean;
  /** True when ANY workspace-scoped control above is withheld. */
  hasRestrictedWorkspaceControls: boolean;
}

/**
 * Every settings capability for one viewer, answered together.
 *
 * `role` is the EFFECTIVE role (a viewer-mode admin is a viewer here), which
 * is what the caller resolves from the session before asking.
 */
export function settingsCapabilities(
  role: string | null | undefined,
  mode?: SettingsAccessMode,
): SettingsCapabilities {
  const can = (capability: Parameters<typeof canAccessMobileCapability>[0]) =>
    canAccessMobileCapability(capability, role, mode);
  const workspace = {
    canManageWorkspace: can("workspace_settings"),
    canManageNotifications: can("notification_settings"),
    canManageRetention: can("retention_settings"),
    canManageWebhooks: can("outbound_webhooks"),
    canManageVoiceLabels: can("voice_labels"),
    canManagePrivacy: can("privacy_requests"),
  };
  return {
    ...workspace,
    canManageApprovalGovernance: canAccessMinimumRole("admin", role, mode),
    hasRestrictedWorkspaceControls: Object.values(workspace).some(
      (allowed) => !allowed,
    ),
  };
}
