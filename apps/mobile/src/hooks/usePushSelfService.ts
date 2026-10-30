/**
 * hooks/usePushSelfService.ts — quiet hours and the round-trip test.
 *
 * Gated the same three ways `usePushDeviceStatus` is, and for the same reasons:
 * the app-wide online gate, session mode (the route is behind
 * RequireAuthMethod(session), so an API-key install collects a guaranteed 401), and
 * whether push is switched on locally at all — a window for notifications the user
 * has disabled is a setting with nothing to apply it to.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  PushDeviceUnknownError,
  savePushQuietHours,
  sendPushSelfTest,
  type PushTestOutcome,
} from "@/api/mobilePushSelfService";
import { pushDeviceErrorMessage, type PushQuietHours } from "@/lib/pushQuietHours";
import { useAuthStore } from "@/store/auth";

import { useOnlineQueryGate } from "./useOnlineQueryGate";

/** Whether the two controls may be offered at all. */
export function usePushSelfServiceAvailable(input: {
  locallyEnabled: boolean;
}): boolean {
  const gate = useOnlineQueryGate();
  const sessionMode = useAuthStore((s) => s.mode) === "session";
  return (
    gate.enabled &&
    Boolean(gate.tenantId) &&
    sessionMode &&
    input.locallyEnabled
  );
}

/**
 * Turn any failure from these two endpoints into a sentence naming the remedy.
 *
 * A missing local possession key is surfaced as `device_not_registered` too: from
 * the user's point of view "this handset has no key" and "the server has no row for
 * this handset" are the same situation with the same fix.
 */
export function pushSelfServiceError(err: unknown, fallback: string): string {
  if (err instanceof PushDeviceUnknownError) {
    return pushDeviceErrorMessage("device_not_registered", fallback);
  }
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code ?? "")
      : "";
  return pushDeviceErrorMessage(code, fallback);
}

export function useSavePushQuietHours() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (window: PushQuietHours): Promise<PushQuietHours> =>
      savePushQuietHours(window),
    onSuccess: () => {
      // The status read reports `registered` and delivery state for this row; a
      // saved window can change nothing there, but a save that raced a revocation
      // means the cached "registered" is now a lie.
      void queryClient.invalidateQueries({
        queryKey: ["mobile-push-device-status"],
      });
    },
  });
}

export function useSendPushSelfTest() {
  return useMutation({
    mutationFn: (): Promise<PushTestOutcome> => sendPushSelfTest(),
  });
}
