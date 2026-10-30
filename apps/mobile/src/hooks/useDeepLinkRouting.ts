/**
 * useDeepLinkRouting — auth + entity deep links, extracted from the root
 * layout (SHELL#78) and given the feedback it was missing (SHELL#71).
 *
 * Cases, all decided by the pure `planDeepLinkNavigation`:
 *
 *   1. Signed magic / reset links resolve locally-pending state before
 *      choosing the API origin and consuming the proof. They ALWAYS route now:
 *      they ARE the sign-in flow.
 *   2. `moosewave://auth/oauth-return?…` is parsed defensively, then sent back
 *      to sign-in until mobile OAuth is enabled server-side.
 *   3. `moosewave://campaign/<id>` (and other entity links) route immediately
 *      when authed; when logged out the target is REMEMBERED and navigated to
 *      after a successful sign-in, so it isn't lost to the auth-gate bounce.
 *   4. Anything else used to be `case "ignore": break` — the app opened on
 *      whatever screen was last shown, indistinguishable from a normal launch,
 *      with no telemetry on the rejection either. Now the user is told and the
 *      rejection is counted (scheme + host only; a malformed magic link still
 *      carries a single-use proof, which must never reach a toast or an
 *      analytics pipeline).
 *
 * Two one-shot guards, both load-bearing:
 *   - `Linking.getInitialURL()` always returns the launch URL, so re-running
 *     the effect (auth flipping after sign-in) would re-process and
 *     double-navigate it.
 *   - a deferred target is flushed once the session is CONFIRMED, which is
 *     why the gate is `deepLinkReady` and not raw `canEnterApp`: a cached
 *     session that is still "checking" may yet 401 and bounce to sign-in, and
 *     landing the target now would discard it.
 */
import * as Linking from "expo-linking";
import type { Href } from "expo-router";
import { useEffect, useRef } from "react";

import { EVENTS } from "@postwave/telemetry";

import { useToast } from "@/components/Toast";
import { useNavigateToHref } from "@/hooks/useNavigateTo";
import { planDeepLinkNavigation } from "@/lib/deepLinks";
import { haptics } from "@/lib/haptics";
import {
  unrecognisedLinkNotice,
  unrecognisedLinkTelemetry,
} from "@/lib/shellNotices";
import { track as trackTelemetry } from "@/lib/telemetry";
import { useAuthStore } from "@/store/auth";

export function useDeepLinkRouting(): void {
  const { toast } = useToast();
  // Replaces instead of pushing when the link resolves to the screen already
  // on top (SHELL#70) — three taps on the same campaign link used to stack
  // three identical screens and cost three back presses to escape.
  const navigate = useNavigateToHref();
  const hydrated = useAuthStore((s) => s.hydrated);
  const canEnterApp = useAuthStore((s) => s.canEnterApp());
  const sessionValidation = useAuthStore((s) => s.sessionValidation);
  const deepLinkReady = canEnterApp && sessionValidation !== "checking";

  // Target that arrived while logged OUT, flushed by the effect below.
  const pendingDeepLink = useRef<Href | null>(null);
  const initialUrlConsumed = useRef(false);

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;

    function handleUrl(url: string | null | undefined): void {
      const plan = planDeepLinkNavigation(url, { isAuthed: deepLinkReady });
      switch (plan.kind) {
        case "navigate":
          navigate(plan.target);
          break;
        case "defer":
          pendingDeepLink.current = plan.target;
          break;
        case "ignore": {
          // A launch with NO url is also "ignore"; stay silent for it.
          const notice = unrecognisedLinkNotice(url);
          if (!notice) break;
          trackTelemetry(
            EVENTS.MOBILE_LINK_HANDLED,
            unrecognisedLinkTelemetry(notice),
          );
          // The screen does not change, so a silent warning toast is easy to
          // miss right after a deliberate tap. Give it a body.
          haptics.warning();
          toast({ message: notice.message, kind: "warning" });
          break;
        }
      }
    }

    if (!initialUrlConsumed.current) {
      void Linking.getInitialURL().then((url) => {
        if (cancelled || initialUrlConsumed.current) return;
        initialUrlConsumed.current = true;
        handleUrl(url);
      });
    }
    const sub = Linking.addEventListener("url", (event) => {
      handleUrl(event.url);
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [hydrated, deepLinkReady, toast, navigate]);

  useEffect(() => {
    if (!hydrated || !deepLinkReady) return;
    const target = pendingDeepLink.current;
    if (!target) return;
    pendingDeepLink.current = null;
    navigate(target);
  }, [hydrated, deepLinkReady, navigate]);
}
