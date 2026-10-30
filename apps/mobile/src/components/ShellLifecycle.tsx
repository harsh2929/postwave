/**
 * ShellLifecycle — every app-wide lifecycle concern that is not the launch
 * gate itself, mounted once as a render-nothing component.
 *
 * Why a component and not more hooks in `app/_layout.tsx` (SHELL#78 /
 * NATIVE-V#3): three of these concerns must be able to call `useToast()` and
 * `useConfirm()`, and those hooks only work BELOW the providers that
 * `RootLayout` renders. A component that sits inside `ConfirmProvider` is the
 * only place a single mount can reach all of them — which is also what made
 * SHELL#72 (stacked `Alert` dialogs where a confirm sheet belongs) unfixable
 * where the code used to live.
 *
 * It is deliberately a SIBLING of `PersistQueryClientProvider` rather than a
 * descendant. That provider is keyed on the persistence scope, so it remounts
 * on every auth transition — and the deep-link and cold-start-notification
 * guards below are one-shot refs that must survive exactly that transition
 * (`Linking.getInitialURL()` and `getLastNotificationResponseAsync()` both keep
 * returning the launch value for the whole process). The hooks reach the query
 * cache through the imported `queryClient` singleton, not through context, so
 * nothing is lost by sitting above it.
 */
import { useAppUpdatePrompt } from "@/hooks/useAppUpdatePrompt";
import { useDeepLinkRouting } from "@/hooks/useDeepLinkRouting";
import { useDisplayPreferences } from "@/hooks/useDisplayPreferences";
import { useHomeScreenQuickActions } from "@/hooks/useHomeScreenQuickActions";
import { usePushRegistration } from "@/hooks/usePushRegistration";
import { usePushResponseRouting } from "@/hooks/usePushResponseRouting";
import { useRealtimeCacheSync } from "@/hooks/useRealtimeCacheSync";
import { useSessionRecovery } from "@/hooks/useSessionRecovery";
import { useSharedInboxRouting } from "@/hooks/useSharedInboxRouting";
import { useWidgetBackgroundRefresh } from "@/hooks/useWidgetBackgroundRefresh";

export function ShellLifecycle(): null {
  // Publishes the stored row density into lib/rowDensityStore so leaf list
  // rows can read it synchronously without a provider in the launch tree or a
  // prop threaded through every renderItem (LOVE#51). Mounted here rather than
  // in useAppBootstrap because it reads an IDENTITY-SCOPED preference, and the
  // identity is only known once the auth store has hydrated.
  useDisplayPreferences();
  useSessionRecovery();
  useRealtimeCacheSync();
  usePushRegistration();
  useDeepLinkRouting();
  usePushResponseRouting();
  useSharedInboxRouting();
  // Home-screen long-press shortcuts. Published only for a signed-in
  // identity and revoked on sign-out, so a shared phone never advertises the
  // previous user's destinations (NATIVE#5).
  useHomeScreenQuickActions();
  // Keeps the home-screen widget's App Group snapshot from going blank
  // between visits to the Dashboard tab (DASHBOARD#50 / NATIVE#19).
  useWidgetBackgroundRefresh();
  // "An update is ready — Restart", the mobile counterpart of desktop's
  // DesktopUpdateBadge (SHELL#29). Needs the toast + confirm providers, which
  // is exactly why it is mounted here and not in useAppBootstrap.
  useAppUpdatePrompt();
  return null;
}
