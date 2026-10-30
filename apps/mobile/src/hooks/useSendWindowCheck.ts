/**
 * hooks/useSendWindowCheck.ts — "is THIS time inside the send window?",
 * asked while the schedule sheet is open (desktop parity: SendChecklist's
 * send-window row, which checks the scheduled time before the send).
 *
 * The instant is truncated to the MINUTE before it becomes part of the query
 * key: the wheel emits second-level values while it settles, and a key that
 * moves per second would refetch a policy evaluation whose answer cannot
 * differ within the minute.
 *
 * Editor-gated in the hook as well as by the hosting sheet — the manifest
 * floor for POST /send-window/check is editor, and a query that is offered
 * below its floor is a guaranteed-403 round trip.
 */
import { useQuery } from "@tanstack/react-query";

import { checkSendWindow } from "@/api/sendWindowCheck";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import {
  sendWindowCheckInstant,
  type SendWindowVerdict,
} from "@/lib/sendWindowVerdict";
import { useAuthStore } from "@/store/auth";

/** A policy is edited on the timescale of an admin, not of a wheel spin. */
const VERDICT_STALE_MS = 60_000;

export function useSendWindowCheck(picked: Date, enabled: boolean) {
  const gate = useOnlineQueryGate();
  const mode = useAuthStore((s) => s.mode);
  const canCheck = canAccessMinimumRole("editor", gate.effectiveRole, mode);
  const instant = sendWindowCheckInstant(picked);
  return useQuery<SendWindowVerdict | null>({
    queryKey: ["send-window-check", gate.tenantId, instant],
    enabled:
      enabled &&
      canCheck &&
      gate.enabled &&
      Boolean(gate.tenantId) &&
      instant !== null,
    staleTime: VERDICT_STALE_MS,
    queryFn: () => checkSendWindow(instant!),
  });
}
