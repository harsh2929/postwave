/**
 * lib/quickActionPolicy.ts — what the home-screen long-press menu offers.
 *
 * Desktop puts Approvals, Search and the dashboard one click away in the tray
 * (`src-tauri/src/tray.rs`); mobile's fastest path to a pending approval was
 * launch → hydrate → biometric gate → More → Approvals (NATIVE#5).
 *
 * Two rules make this safe rather than merely fast:
 *
 *  1. ROLE-GATED, from the same manifest the navigation uses. Approvals is
 *     owner/admin-only — `apps/api/internal/approvals/handlers.go:226` calls
 *     `requireAdmin` — so advertising it to a viewer would put a shortcut to a
 *     403 on their home screen. (routeauth/manifest.json lists that route as
 *     viewer; it is one of the auto-generated `fail_closed_default` rows, and
 *     it is wrong. The handler is the evidence.)
 *  2. IDENTITY-SCOPED. The items are published for a signed-in identity and
 *     removed on sign-out, because the shortcut menu persists in the OS
 *     launcher: leaving "Approvals" on the icon after logout tells the next
 *     person holding the phone what the previous user's role was.
 *
 * Import-free apart from the route manifest (which is itself pure), so the
 * gating is unit-tested in the node environment.
 */
import {
  canAccessMinimumRole,
  type MobileAccessRole,
} from "@/lib/mobileRouteManifest";

export interface QuickActionDef {
  /** Stable id; the OS persists it, so it must never be reused for a new destination. */
  id: string;
  title: string;
  subtitle: string;
  /** In-app route, resolved through the same navigator as a deep link. */
  href: string;
  /** Apple built-in shortcut icon. iOS only — see the hook. */
  icon: string;
  /** Null when every signed-in role may use it. */
  minimumRole: MobileAccessRole | null;
}

/**
 * Four, deliberately. iOS shows at most four home-screen shortcuts and drops
 * the overflow silently, so a longer list would mean the last entries simply
 * never appear — a menu whose contents depend on an undocumented truncation.
 *
 * Chosen for "I opened my phone BECAUSE of this", not for frequency: the
 * dashboard is what a plain launch already lands on, so a shortcut to it would
 * spend one of four slots on nothing.
 */
export const MOBILE_QUICK_ACTIONS: readonly QuickActionDef[] = [
  {
    id: "approvals",
    title: "Approvals",
    subtitle: "Decide what is waiting",
    href: "/(tabs)/approvals",
    icon: "taskCompleted",
    minimumRole: "admin",
  },
  {
    id: "search",
    title: "Search",
    subtitle: "Find a campaign or subscriber",
    href: "/(tabs)/search",
    icon: "search",
    minimumRole: null,
  },
  {
    id: "scan",
    title: "Scan a code",
    subtitle: "Sign-up QR or device approval",
    href: "/(tabs)/scan",
    icon: "capturePhoto",
    minimumRole: null,
  },
  {
    id: "notifications",
    title: "Notifications",
    subtitle: "Everything you were told",
    href: "/(tabs)/notifications",
    icon: "message",
    minimumRole: null,
  },
];

export interface QuickActionAudience {
  signedIn: boolean;
  role: string | null | undefined;
  mode: "api_key" | "session" | null | undefined;
}

/**
 * The actions this identity may actually reach.
 *
 * Signed out → an EMPTY list, not the role-free subset: every destination sits
 * behind the auth gate, so a shortcut would only ever bounce to sign-in.
 */
export function quickActionsForAudience(
  audience: QuickActionAudience,
): QuickActionDef[] {
  if (!audience.signedIn) return [];
  return MOBILE_QUICK_ACTIONS.filter(
    (action) =>
      action.minimumRole === null ||
      canAccessMinimumRole(action.minimumRole, audience.role, audience.mode),
  );
}

/**
 * Resolve an id the OS handed back into a route.
 *
 * Matched against the CATALOGUE rather than trusting the `href` parameter the
 * OS round-trips: shortcut items survive an app update, so a build could be
 * handed a payload minted by an older one. An id we no longer publish resolves
 * to null and the launch proceeds normally.
 */
export function routeForQuickActionId(
  id: string | null | undefined,
): string | null {
  if (typeof id !== "string" || !id) return null;
  return MOBILE_QUICK_ACTIONS.find((action) => action.id === id)?.href ?? null;
}
