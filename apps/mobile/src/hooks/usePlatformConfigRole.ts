/**
 * hooks/usePlatformConfigRole.ts — who may ACT on the platform-configuration
 * card.
 *
 * Every write behind the card (PUT /firewall/settings, PATCH
 * /settings/identifier-transforms, POST/DELETE /feature-flags) is admin in
 * routeauth/manifest.json. The server enforces that with a 403; this hook
 * exists so the phone does not OFFER a control it knows will be refused —
 * a viewer sees the state and a disabled explanation, never a button that
 * fails. Same shape as WorkspaceSetupSection / DisplayPreferencesSection.
 */
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { useAuthStore } from "@/store/auth";

export function useCanAdminPlatformConfig(): boolean {
  const effectiveRole = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const mode = useAuthStore((s) => s.mode);
  return canAccessMinimumRole("admin", effectiveRole, mode);
}

/** The sentence a non-admin sees where the controls would be. */
export const ADMIN_ONLY_NOTE =
  "Only workspace owners and admins can change this. You can still see it.";
