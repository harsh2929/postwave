/**
 * useHomeScreenQuickActions — publish + handle the home-screen long-press
 * shortcuts (NATIVE#5).
 *
 * Mounted once in `ShellLifecycle`, alongside the deep-link and
 * notification-response routing it deliberately mirrors:
 *
 *   - the LAUNCH action is one-shot. `QuickActions.initial` keeps returning
 *     the launching item for the whole process, so without a guard, every
 *     re-run of the effect (auth flipping after sign-in) would navigate again.
 *   - a shortcut tapped while the session is still being CONFIRMED is
 *     remembered, not navigated. `deepLinkReady` (authed AND not "checking")
 *     is the same gate `useDeepLinkRouting` uses, for the same reason: a
 *     cached session may still 401 and bounce to sign-in, discarding the
 *     target.
 *
 * Items are re-published whenever the identity changes and CLEARED on sign-out
 * — the OS keeps the menu on the icon, so leaving "Approvals" there after
 * logout would disclose the previous user's role to whoever picks the phone up.
 */
import * as QuickActions from "expo-quick-actions";
import { router } from "expo-router";
import type { Href } from "expo-router";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import {
  quickActionsForAudience,
  routeForQuickActionId,
} from "@/lib/quickActionPolicy";
import { useAuthStore } from "@/store/auth";

export function useHomeScreenQuickActions(): void {
  const hydrated = useAuthStore((s) => s.hydrated);
  const canEnterApp = useAuthStore((s) => s.canEnterApp());
  const sessionValidation = useAuthStore((s) => s.sessionValidation);
  const mode = useAuthStore((s) => s.mode);
  const role = useAuthStore((s) => s.session?.effectiveRole ?? null);
  const ready = canEnterApp && sessionValidation !== "checking";

  const pending = useRef<Href | null>(null);
  const launchConsumed = useRef(false);

  // --- publish -------------------------------------------------------------
  useEffect(() => {
    if (!hydrated) return;
    const actions = quickActionsForAudience({
      signedIn: canEnterApp,
      role,
      mode,
    });
    void QuickActions.setItems(
      actions.map((action) => ({
        id: action.id,
        title: action.title,
        subtitle: action.subtitle,
        // Apple's built-in shortcut icons only exist on iOS; on Android the
        // field expects a drawable resource name, and an unresolvable one
        // renders as a broken glyph rather than falling back.
        ...(Platform.OS === "ios" ? { icon: action.icon } : {}),
        params: { href: action.href },
      })),
    ).catch(() => {
      // Unsupported launcher (many Android OEM launchers) — the app is
      // otherwise unaffected, so there is nothing to tell the user.
    });
  }, [hydrated, canEnterApp, role, mode]);

  // --- handle --------------------------------------------------------------
  useEffect(() => {
    function handle(action: { id?: string } | null | undefined): void {
      const href = routeForQuickActionId(action?.id);
      if (!href) return;
      const target = href as unknown as Href;
      if (ready) {
        router.push(target);
      } else {
        pending.current = target;
      }
    }

    if (!launchConsumed.current) {
      launchConsumed.current = true;
      handle(QuickActions.initial);
    }
    const sub = QuickActions.addListener((action) => handle(action));
    return () => sub.remove();
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    const target = pending.current;
    if (!target) return;
    pending.current = null;
    router.push(target);
  }, [ready]);
}
