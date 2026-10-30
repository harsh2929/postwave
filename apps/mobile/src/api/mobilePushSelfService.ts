/**
 * api/mobilePushSelfService.ts — the two device-scoped push controls.
 *
 * Both endpoints exist SOLELY for this app — `/api/v1/mobile/push/devices/*` has no
 * other client on any surface — and both had no caller at all until now. They were
 * built to close mobile findings SHELL#12 (quiet hours, migration 1814) and
 * SHELL#13 (test push), both of which the 2026-07-25 ledger records as `confirmed`.
 * The server half shipped with Go tests; the client half never did.
 *
 * SESSION-ONLY BY CONSTRUCTION, exactly like `mobilePushStatus`: main.go wraps the
 * device group in RequireAuthMethod(session), so an API-key install collects a
 * guaranteed 401 no matter its scopes. Callers must gate on session mode rather than
 * rendering that 401 as "push is broken".
 *
 * Neither call creates a device row. Both answer 404 `device_not_registered` when
 * this installation is unknown or was revoked mid-flight, which is the server
 * telling the client to re-register rather than to retry.
 */
import { getClient } from "@/api/sdkClient";
import { readPushDeviceKey } from "@/lib/push";
import {
  parsePushQuietHours,
  pushQuietHoursBody,
  type PushQuietHours,
} from "@/lib/pushQuietHours";

/** Raised when this installation has no possession key stored at all. */
export class PushDeviceUnknownError extends Error {
  readonly code = "device_not_registered";
  constructor() {
    super("this installation has no push possession key");
    this.name = "PushDeviceUnknownError";
  }
}

/**
 * Save this installation's quiet-hours window.
 *
 * Sends every field rather than a delta. The handler treats an omitted field as
 * "leave the stored value alone" (quiet_hours.go:140-150), which is right for a
 * partial API but wrong for this UI: the user is looking at a complete window and
 * expects Save to mean what they see.
 */
export async function savePushQuietHours(
  window: PushQuietHours,
): Promise<PushQuietHours> {
  const deviceKey = await readPushDeviceKey();
  if (!deviceKey) throw new PushDeviceUnknownError();
  const { client } = getClient();
  const response = await client.mobilePush.setQuietHours(
    pushQuietHoursBody(deviceKey, window),
  );
  // Read the window back off the response rather than echoing the request: the
  // server derives start_local/end_local and substitutes UTC for a blank zone, so
  // the stored truth can differ from what was sent.
  return parsePushQuietHours(response.quiet_hours);
}

export interface PushTestOutcome {
  accepted: boolean;
  /** The server's own caveat about asynchronous delivery confirmation. */
  note: string;
}

/**
 * Send one real notification down the whole chain to this handset.
 *
 * Returns the server's `note` verbatim. Expo accepting a ticket is not proof of
 * handset delivery — the receipt worker reconciles that later — and the handler says
 * so explicitly, so the UI must not upgrade "accepted" into "delivered".
 */
export async function sendPushSelfTest(): Promise<PushTestOutcome> {
  const deviceKey = await readPushDeviceKey();
  if (!deviceKey) throw new PushDeviceUnknownError();
  const { client } = getClient();
  const response = await client.mobilePush.sendTest({ device_key: deviceKey });
  return {
    accepted: Boolean(response.accepted),
    note:
      typeof response.note === "string" && response.note.trim() !== ""
        ? response.note
        : "accepted by the push service; final delivery is confirmed asynchronously",
  };
}
