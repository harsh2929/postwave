/**
 * Per-subscriber best-send-time read (MAP#49).
 *
 *   GET /api/v1/subscribers/{id}/best-send-time
 *   → 200 { email, best_hour_utc: 0..167, computed_at, sample_size }
 *   → 404 { "error": "insufficient_data", "min_signal_units": 5 }
 *   → 404 { "error": { "code": "not_found" } }
 *
 * This does NOT go through `rawRequest`, and the reason is the shape of that
 * first 404. The handler writes `"error"` as a bare STRING, and the SDK's
 * `parseErrorBody` (packages/sdk-ts/src/errors.ts:327) only reads `.code` when
 * `error` is an OBJECT — so a string body loses the discriminator entirely and
 * `mapError` stamps the generic `http_404`. The raw body survives on
 * `PostwaveError.payload`, so this module catches the error itself and reads it
 * from there. Routing this through `rawRequest` would have collapsed
 * "not enough signal yet" (calm, expected, most subscribers) into
 * "this subscriber does not exist" (alarming, wrong).
 *
 * `src/api/sendTime.ts` is the SEGMENT-level sibling and is deliberately NOT
 * reused: its `best_hour_utc` is a `"HH:00"` hour-of-DAY string, this one is an
 * hour-of-WEEK integer. See src/lib/subscriberSendTime.ts.
 */
import { getClient } from "./sdkClient";
import {
  codeFromError,
  messageFromError,
  statusFromError,
} from "./request";
import {
  classifySendTimeFailure,
  type SendTimeOutcome,
} from "@/lib/subscriberSendTime";

export interface SubscriberBestSendTimeWire {
  email?: string;
  /** Hour of WEEK, 0..167, Sunday 00:00 UTC = 0. */
  best_hour_utc?: number;
  computed_at?: string;
  /**
   * Always 0 on this endpoint — `Repo.GetByID` never populates it. Declared so
   * nobody re-derives it from the wire and renders "0 signals".
   */
  sample_size?: number;
}

export type SubscriberBestSendTimeResult =
  | { ok: true; row: SubscriberBestSendTimeWire }
  | {
      ok: false;
      outcome: SendTimeOutcome;
      message: string;
      /** Present only on the `insufficient` outcome. */
      minSignalUnits?: number;
    };

function payloadOf(err: unknown): unknown {
  return err && typeof err === "object" && "payload" in err
    ? (err as { payload?: unknown }).payload
    : undefined;
}

function minSignalUnitsOf(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { min_signal_units?: unknown }).min_signal_units;
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export async function getSubscriberBestSendTime(
  subscriberId: string,
): Promise<SubscriberBestSendTimeResult> {
  try {
    const { client } = getClient();
    const row = await client.request<SubscriberBestSendTimeWire>(
      "GET",
      `/api/v1/subscribers/${encodeURIComponent(subscriberId)}/best-send-time`,
    );
    return { ok: true, row: row ?? {} };
  } catch (err) {
    const body = payloadOf(err);
    const outcome = classifySendTimeFailure(
      statusFromError(err),
      codeFromError(err),
      body,
    );
    const minSignalUnits = minSignalUnitsOf(body);
    return {
      ok: false,
      outcome,
      message: messageFromError(err),
      ...(minSignalUnits !== undefined ? { minSignalUnits } : {}),
    };
  }
}
