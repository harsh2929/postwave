/**
 * api/sendWindowCheck.ts — POST /api/v1/send-window/check {scheduled_at}.
 *
 * A POST with pure READ semantics: send_window.go's Check handler evaluates
 * the tenant policy against one instant and writes nothing, which is why the
 * schedule sheet may run it as the picker moves rather than press-driven.
 * The floor is the stricter of the two gates — the mount is read-scoped but
 * routeauth/manifest.json carries session_minimum_role "editor" for this
 * method+path — and the only caller is the schedule sheet, an editor verb's
 * sheet; the hook additionally refuses below editor so a viewer session never
 * spends a guaranteed-403 round trip.
 *
 * Parsing lives in lib/sendWindowVerdict; this module is URL + envelope.
 */
import {
  parseSendWindowVerdict,
  type SendWindowVerdict,
} from "@/lib/sendWindowVerdict";

import { checkedApiResult, rawRequest } from "./request";

export async function checkSendWindow(
  scheduledAtISO: string,
): Promise<SendWindowVerdict | null> {
  const res = await checkedApiResult(
    rawRequest<unknown>("POST", "/api/v1/send-window/check", {
      scheduled_at: scheduledAtISO,
    }),
  );
  return parseSendWindowVerdict(res.data);
}
