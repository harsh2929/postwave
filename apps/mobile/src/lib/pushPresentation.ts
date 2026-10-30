/**
 * lib/pushPresentation.ts — how a notification PRESENTS itself.
 *
 * Split out of lib/push.ts, which had grown to hold every push concern at once
 * (NATIVE#54): registration, device keys, revocation journalling, telemetry,
 * response parsing and the approval decision, plus this — the OS-level
 * presentation surface. That surface is a genuinely separate concern with a
 * different audience: these values are a CONTRACT with the operating system and
 * with the Go sender (category ids must match `categoryForEvent`, channel ids
 * must match `androidChannelForEvent`), while the rest of push.ts is a
 * client-side lifecycle.
 *
 * Keeping it separate also means the two "the OS is the source of truth"
 * registration calls sit next to the comments explaining why each is
 * write-once, instead of being read as ordinary setup in the middle of a
 * token-minting flow.
 */
import * as Notifications from "expo-notifications";

import {
  androidPushChannels,
  type PushChannelImportance,
} from "@/lib/pushChannels";
import { PUSH_ACTION_REVOKE_SESSION } from "@/lib/pushSecuritySession";

// Foreground notifications still show a banner — the default is
// "silent" which is wrong for an event-driven app like this.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/**
 * iOS notification CATEGORY identifiers. These select which action buttons
 * the system shows on a notification; they MUST match the `categoryId` the
 * backend sender sets (apps/api/internal/mobilepush —
 * categoryForEvent). The split mirrors the shared @postwave/notifications
 * manifest: approvals gets Approve/Reject, security gets Revoke/Review, and
 * every non-actionable category gets a single generic View action.
 */
export const PUSH_CATEGORY_APPROVAL = "approval";
export const PUSH_CATEGORY_SECURITY = "security";
export const PUSH_CATEGORY_ENTITY = "entity";

/**
 * Canonical notification ACTION identifiers. The response handler in
 * hooks/usePushResponseRouting.ts branches on these (Approve/Reject uses the
 * approvals API; Revoke session uses the exact-session auth endpoint; View
 * routes to the review surface). Exported so the handler + tests reference one
 * source of truth instead of stringly-typed literals.
 */
export const PUSH_ACTION_APPROVE = "approve";
export const PUSH_ACTION_REJECT = "reject";
export const PUSH_ACTION_VIEW = "view";

/**
 * registerNotificationCategories — register the OS notification categories
 * (and their action buttons) so iOS renders Approve/Reject on an approval
 * push, Revoke/Review on a security push, and View on an entity push.
 * Idempotent: Expo's setNotificationCategoryAsync upserts by identifier, so
 * calling this on every launch is safe. Best-effort — a failure here must
 * never brick push registration (the notification still arrives; it just
 * lacks the buttons).
 *
 * Action option notes:
 *   - Approve/Reject require device authentication and foreground the app.
 *     The response listener then asks for an explicit business confirmation;
 *     a person holding a locked/shared phone cannot silently decide.
 *   - Revoke session has the same protections and is destructive; the handler
 *     additionally binds it to the exact security event and session id.
 *   - Reject is marked isDestructive so iOS tints it red.
 *   - View foregrounds the app (default) and routes to the entity.
 *
 * `categorySummaryFormat` (NATIVE#14) is what iOS shows on the collapsed stack
 * once several notifications from the same category arrive: without it the
 * user reads the generic system summary instead of "3 more approvals waiting".
 */
export async function registerNotificationCategories(): Promise<void> {
  try {
    await Notifications.setNotificationCategoryAsync(
      PUSH_CATEGORY_APPROVAL,
      [
        {
          identifier: PUSH_ACTION_APPROVE,
          buttonTitle: "Approve",
          options: {
            isAuthenticationRequired: true,
            opensAppToForeground: true,
          },
        },
        {
          identifier: PUSH_ACTION_REJECT,
          buttonTitle: "Reject",
          // GOVERNANCE#37 — rejecting REQUIRES a reason everywhere else in the
          // app (`rejectDraftSubmitState` refuses to build a request without
          // one), and this button used to be the single door around that rule.
          // `textInput` makes the OS collect it: iOS opens an inline field on
          // the notification, Android renders a direct-reply box, and the text
          // comes back as `NotificationResponse.userText`.
          //
          // It is still not a guarantee — a submit can be empty and a platform
          // may give us nothing — so the handler treats a missing reason as
          // "open the request", never as "reject without one". See
          // `pushRejectPlan` in lib/pushDecisionFlow.ts.
          textInput: {
            submitButtonTitle: "Reject",
            placeholder: "Why is this being rejected?",
          },
          options: {
            isAuthenticationRequired: true,
            isDestructive: true,
            opensAppToForeground: true,
          },
        },
      ],
      { categorySummaryFormat: "%u more approvals waiting" },
    );
    await Notifications.setNotificationCategoryAsync(
      PUSH_CATEGORY_SECURITY,
      [
        {
          identifier: PUSH_ACTION_REVOKE_SESSION,
          buttonTitle: "Revoke session",
          options: {
            isAuthenticationRequired: true,
            isDestructive: true,
            // The in-app confirm sheet is mandatory; never perform this
            // destructive action as a background notification response.
            opensAppToForeground: true,
          },
        },
        {
          identifier: PUSH_ACTION_VIEW,
          buttonTitle: "Review devices",
          options: { opensAppToForeground: true },
        },
      ],
      { categorySummaryFormat: "%u more security alerts" },
    );
    await Notifications.setNotificationCategoryAsync(
      PUSH_CATEGORY_ENTITY,
      [
        {
          identifier: PUSH_ACTION_VIEW,
          buttonTitle: "View",
          options: { opensAppToForeground: true },
        },
      ],
      { categorySummaryFormat: "%u more Moosewave alerts" },
    );
  } catch {
    // best-effort — categories are an enhancement, not a prerequisite for
    // delivery. Swallow so a registration failure never blocks the token.
  }
}

const ANDROID_IMPORTANCE: Record<
  PushChannelImportance,
  Notifications.AndroidImportance
> = {
  high: Notifications.AndroidImportance.HIGH,
  default: Notifications.AndroidImportance.DEFAULT,
  low: Notifications.AndroidImportance.LOW,
};

/**
 * registerAndroidNotificationChannels — one channel per notification category
 * (NATIVE#13), so Android's per-channel controls become real: a user can leave
 * approvals on HIGH with a sound and silence bounce traffic entirely, which one
 * shared "default" channel made impossible.
 *
 * Idempotent — setNotificationChannelAsync upserts by id, and Android
 * deliberately ignores importance/sound changes on an existing channel so a
 * user's own choice is never overwritten by a reinstall of the same id.
 *
 * Channels are created in order and failures are NOT swallowed per-channel: a
 * missing channel means Android silently drops that category's notifications,
 * which is worse than a visible registration failure the user can retry.
 */
export async function registerAndroidNotificationChannels(): Promise<void> {
  for (const channel of androidPushChannels()) {
    const importance = ANDROID_IMPORTANCE[channel.importance];
    await Notifications.setNotificationChannelAsync(channel.id, {
      name: channel.name,
      description: channel.description,
      importance,
      // A LOW-importance channel is explicitly silent; giving it a vibration
      // pattern is contradictory and Android would ignore it anyway.
      ...(channel.importance === "low"
        ? {}
        : { vibrationPattern: [0, 250, 250, 250] }),
      lightColor: "#e55262",
    });
  }
}
