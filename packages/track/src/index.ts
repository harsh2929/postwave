/**
 * @postwave/track — the browser producer for Moosewave's first-party event
 * endpoint (frontier G-20b).
 *
 * The backend already ships a public, cookieless ingestion endpoint —
 * POST /api/public/track/event — that resolves the tenant from the request
 * Host (a verified first-party CNAME), records the event onto the subscriber's
 * activity timeline, and de-duplicates on a client-supplied id. But there was
 * no CLIENT: nothing for a site to embed to actually send events. This is that
 * client.
 *
 * SCOPE — this is the IDENTIFIED-user producer. The endpoint attributes events
 * by email, so this tracks known/logged-in users (e.g. "viewed pricing",
 * "added to cart") without third-party cookies. Tracking ANONYMOUS visitors and
 * stitching them to a profile on login is the remaining half of G-20b and needs
 * a backend anonymous-ingestion endpoint (the identify path already supports the
 * anonymous_id → known stitch); this library is forward-compatible with it.
 */

/** Options for {@link createTracker}. */
export interface TrackerOptions {
  /**
   * The absolute or relative URL of the public track endpoint. Defaults to
   * "/api/public/track/event" on the current origin — which, for a site served
   * over its verified first-party CNAME, is exactly where the endpoint lives.
   */
  endpoint?: string;
  /**
   * fetch implementation to use. Defaults to the global `fetch`. Injectable so
   * the tracker is usable in tests and non-browser runtimes.
   */
  fetchImpl?: typeof fetch;
  /**
   * Generates the idempotency id when an event does not carry one. Defaults to
   * `crypto.randomUUID()` with a non-crypto fallback. Injectable for tests.
   */
  idGenerator?: () => string;
}

/** A first-party event to record for a known (email-identified) subscriber. */
export interface TrackEvent {
  /** The subscriber's email — how the endpoint attributes the event. Required. */
  email: string;
  /** The event name, e.g. "Viewed Pricing" or "Placed Order". Required. */
  eventName: string;
  /** Optional coarse type, lower-cased server-side (e.g. "page_view", "order"). */
  eventType?: string;
  /** Arbitrary event properties. */
  properties?: Record<string, unknown>;
  /** A stable external id for the subscriber, preserved in the event metadata. */
  externalId?: string;
  /** When the event happened; defaults to now server-side if omitted. */
  occurredAt?: Date;
  /**
   * Idempotency key. Two sends with the same id de-duplicate server-side (safe
   * retries). Auto-generated per call when omitted.
   */
  sourceEventId?: string;
}

/** The server's acknowledgement. `recorded` is false for an unknown subscriber. */
export interface TrackResult {
  accepted: boolean;
  recorded: boolean;
  deduped?: boolean;
  id?: string;
}

/** Thrown when the endpoint returns a non-2xx response. */
export class TrackError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "TrackError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_ENDPOINT = "/api/public/track/event";

function defaultIdGenerator(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Non-crypto fallback — this is only an idempotency key, not a secret.
  return `evt-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * createTracker returns a tracker bound to an endpoint. The returned `track`
 * never throws for the "unknown subscriber" case — the endpoint accepts and
 * ignores those (recorded=false) — but does reject with a {@link TrackError} on
 * a genuine 4xx/5xx so callers can surface real failures.
 */
export function createTracker(options: TrackerOptions = {}) {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const genId = options.idGenerator ?? defaultIdGenerator;
  if (typeof doFetch !== "function") {
    throw new Error("@postwave/track: no fetch implementation available (pass options.fetchImpl)");
  }

  async function track(event: TrackEvent): Promise<TrackResult> {
    const email = event.email?.trim();
    if (!email) {
      throw new TrackError(0, "missing_email", "track() requires an email to attribute the event");
    }
    if (!event.eventName?.trim()) {
      throw new TrackError(0, "missing_event_name", "track() requires an eventName");
    }
    const body: Record<string, unknown> = {
      email,
      event_name: event.eventName.trim(),
      source_event_id: event.sourceEventId ?? genId(),
    };
    if (event.eventType) body.event_type = event.eventType;
    if (event.externalId) body.external_id = event.externalId;
    if (event.properties) body.properties = event.properties;
    if (event.occurredAt) {
      // `new Date("whenever the CMS gave us")` is an Invalid Date, and
      // toISOString() throws RangeError on one. Every other input mistake here
      // raises a TrackError the caller can identify; this one raised a bare
      // RangeError from two lines below the validation block, in a library that
      // runs on customers' own pages.
      if (Number.isNaN(event.occurredAt.getTime())) {
        throw new TrackError(
          0,
          "invalid_occurred_at",
          "track() received an Invalid Date for occurredAt",
        );
      }
      body.occurred_at = event.occurredAt.toISOString();
    }

    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      // First-party same-origin call; no credentials needed (the CNAME is the credential).
      credentials: "omit",
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      let message = `${res.status}`;
      try {
        const err = (await res.json()) as { error?: { code?: string; message?: string } };
        code = err.error?.code ?? code;
        message = err.error?.message ?? message;
      } catch {
        // keep status-only error
      }
      throw new TrackError(res.status, code, message);
    }
    // The 4xx/5xx path above already tolerates a body that is not JSON. This
    // one did not, and a 2xx is exactly where an unparseable body arrives in
    // practice: a CDN or gateway answering 200 with an HTML interstitial, or a
    // 204 with no body at all. Callers were told they could catch TrackError to
    // "surface real failures"; instead they got a raw
    // `SyntaxError: Unexpected token '<'` escaping a tracking call on their own
    // page. Same defence, both directions.
    let data: TrackResult;
    try {
      data = (await res.json()) as TrackResult;
    } catch {
      throw new TrackError(
        res.status,
        "invalid_response",
        `track endpoint returned ${res.status} with a body that is not JSON`,
      );
    }
    return {
      accepted: data.accepted ?? true,
      recorded: data.recorded ?? false,
      ...(data.deduped !== undefined ? { deduped: data.deduped } : {}),
      ...(data.id !== undefined ? { id: data.id } : {}),
    };
  }

  return { track };
}

export type Tracker = ReturnType<typeof createTracker>;
