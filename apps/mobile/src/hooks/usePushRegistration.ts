/**
 * usePushRegistration — device-level notification wiring, extracted from the
 * root layout (SHELL#78).
 *
 * Two effects with deliberately different gates:
 *
 *  - REGISTRATION is gated on online services, and never prompts. The launch
 *    path only registers when the user has already granted permission; opt-in
 *    happens from the Settings toggle, so a logged-out (or offline) user is
 *    never nagged for a permission they cannot yet use.
 *  - CATEGORIES (Approve/Reject and security Revoke/Review buttons) are
 *    device-local configuration, so they stay registered even while an
 *    authenticated session is offline — the buttons are what make a
 *    killed-app response possible in the first place.
 */
import { useEffect } from "react";

import {
  registerForPushNotificationsIfGranted,
  registerNotificationCategories,
} from "@/lib/push";
import { useAuthStore } from "@/store/auth";

export function usePushRegistration(): void {
  const hydrated = useAuthStore((s) => s.hydrated);
  const canEnterApp = useAuthStore((s) => s.canEnterApp());
  const canUseOnlineServices = useAuthStore((s) => s.canUseOnlineServices());

  useEffect(() => {
    if (hydrated && canUseOnlineServices) {
      void registerForPushNotificationsIfGranted();
    }
  }, [hydrated, canUseOnlineServices]);

  useEffect(() => {
    if (hydrated && canEnterApp) {
      void registerNotificationCategories();
    }
  }, [hydrated, canEnterApp]);
}
