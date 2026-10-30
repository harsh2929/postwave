/**
 * api/consentEvents.ts — one read of the consent-event ledger.
 *
 *   GET /api/v1/consent/events?limit=&since=   (admin)
 *
 * READ-ONLY AND ONE PAGE, ON PURPOSE. The GPC card needs the recent slice
 * to say "signals are arriving / failing to correlate"; paging the whole
 * ledger onto a phone reproduces the desktop Consent register nobody asked
 * a phone to be. Writes to this ledger are server-side (the cookie banner,
 * the GPC honour path) — there is nothing for a client to author.
 *
 * UNWRAP BEFORE PARSING: `rawRequest` resolves to the {data,error}
 * ENVELOPE; a failure surfaces as a throw so a broken read can never
 * render as "no signals".
 */
import { rawRequest, type AIApiError } from "@/api/request";
import {
  parseConsentEvents,
  type ConsentEventLike,
} from "@/lib/gpcSignals";

/** One page; the server clamps limit to [1, 1000] (readConsentLimit). */
const PAGE_LIMIT = 200;

export class ConsentEventsError extends Error {
  readonly status: number;
  constructor(error: AIApiError) {
    super(error.message || "Couldn't load consent events.");
    this.name = "ConsentEventsError";
    this.status = error.status;
  }
}

/** True when the ledger refused the session — a permission rule. */
export function isConsentReadDenied(err: unknown): boolean {
  return err instanceof ConsentEventsError && err.status === 403;
}

export async function fetchRecentConsentEvents(
  sinceIso: string,
): Promise<ConsentEventLike[]> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/consent/events?limit=${PAGE_LIMIT}&since=${encodeURIComponent(sinceIso)}`,
  );
  if (res.error) throw new ConsentEventsError(res.error);
  return parseConsentEvents(res.data);
}
