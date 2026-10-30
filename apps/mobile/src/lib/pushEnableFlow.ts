/**
 * pushEnableFlow — the two steps that must happen BEFORE the OS notification
 * prompt, wired to the real device APIs.
 *
 * WHY THIS EXISTS. iOS shows its notification permission dialog exactly once
 * per install. Settings' push switch used to call
 * `registerForPushNotifications()` directly, which fires that dialog cold: the
 * only priming was the switch's own hint, and that hint described the
 * MECHANISM ("Registers or unregisters this device for push notification
 * delivery") rather than the value. A "Don't Allow" tapped against that copy
 * is effectively permanent — every later `requestPermissionsAsync` resolves
 * denied, so the app can never explain itself again.
 *
 * So: rationale first, in Moosewave's own branded sheet, where declining costs
 * nothing and the switch simply flips back. And when permission has ALREADY
 * been denied, do not fire a request that can only fail silently — say so and
 * offer the one destination that can actually change it.
 *
 * The COPY and the branch decision are pure and node-tested in
 * `pushPriming.ts`; this module is only the device wiring, which cannot be
 * imported from a node test (it reaches expo-notifications through push.ts).
 */
import { Linking } from "react-native";

import type { ConfirmOptions } from "@/components/ConfirmSheet";
import { getNotificationPermissionState } from "@/lib/push";
import { pushPrimingPrompt } from "@/lib/pushPriming";

/**
 * Returns true when the caller should go ahead and register (which may show
 * the OS dialog), false when the user declined or was sent to Settings.
 *
 * `confirm` is injected rather than imported so the caller's ConfirmSheet
 * context — and therefore the app's own styling — is the one that renders.
 */
export async function primePushEnable(
  confirm: (options: ConfirmOptions) => Promise<boolean>,
): Promise<boolean> {
  const prompt = pushPrimingPrompt(await getNotificationPermissionState());
  // Already granted: nothing to explain, registration is a no-op prompt-wise.
  if (!prompt) return true;

  const proceed = await confirm({
    title: prompt.title,
    message: prompt.message,
    ...(prompt.consequence ? { consequence: prompt.consequence } : {}),
    confirmLabel: prompt.confirmLabel,
    cancelLabel: prompt.cancelLabel,
  });
  if (!proceed) return false;

  if (prompt.outcome === "open_settings") {
    // `openSettings` can reject on a device with no Settings deep link; the
    // switch is reverted by the caller either way, so a failure here must not
    // take the whole toggle down with it.
    await Linking.openSettings().catch(() => undefined);
    return false;
  }
  return true;
}
