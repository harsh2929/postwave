/**
 * Redaction for Sentry PERFORMANCE data — transaction events and spans.
 *
 * `redactEvent`/`redactBreadcrumb` cover errors and breadcrumbs. They do not
 * cover the second envelope Sentry sends: transactions. A transaction carries
 * its own copies of exactly the strings the error path takes care to scrub —
 * the route name in `transaction`, the request URL in each http span's
 * `description`, and a `data` bag that http/db integrations fill with the full
 * URL, the query string and sometimes the statement.
 *
 * The mobile SDK sets `tracesSampleRate` with no transaction hook. No spans
 * are produced today because no tracing integration is registered, so this is
 * latent rather than live — which is the point. The day someone adds
 * `reactNavigationIntegration()` or turns on the fetch instrumentation, spans
 * start flowing on a config that was written without a scrubber, and Moosewave
 * puts subscriber identity in the PATH (`/subscribers/<email>`,
 * `/sms/<phoneE164>`). Wiring the hooks now means that change cannot silently
 * become a disclosure.
 *
 * ONE THING THIS MUST NOT DO: `redactEvent` deletes `contexts` wholesale,
 * which is right for an error and fatal for a transaction — Sentry reads
 * `contexts.trace.trace_id`/`span_id` to assemble the trace, and an event
 * without them is dropped at ingest. So the trace context is lifted out,
 * reduced to its structural fields, and put back.
 */

import { redactEvent, redactPath, redactUrl } from "./redact.js";
import type { RedactableEvent } from "./redact.js";

const REDACTED = "[redacted]";

/** A span as it appears on the wire (Sentry's `SpanJSON`). */
export interface RedactableSpan {
  description?: unknown;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A transaction event: an event plus a name, a span list and a trace context. */
export interface RedactableTransaction extends RedactableEvent {
  transaction?: unknown;
  spans?: RedactableSpan[];
}

/**
 * Structural trace fields. Everything else on `contexts.trace` — notably the
 * `data` bag, which the http integration fills with the request URL — is
 * dropped rather than scrubbed, matching how `redactEvent` treats `extra`.
 */
const SAFE_TRACE_KEYS = new Set([
  "trace_id",
  "span_id",
  "parent_span_id",
  "op",
  "status",
  "origin",
  "exclusive_time",
]);

/**
 * Span `data` keys worth keeping: bounded, structural, and useful for reading
 * a trace. The two URL-shaped keys are kept but scrubbed; everything absent
 * from this list is deleted, so a new integration inventing its own key is
 * dropped by default instead of shipped by default.
 */
const SAFE_SPAN_DATA_KEYS = new Set([
  "http.request.method",
  "http.response.status_code",
  "http.response_content_length",
  "server.address",
  "server.port",
  "db.system",
  "url",
  "http.url",
]);

const URL_SPAN_DATA_KEYS = new Set(["url", "http.url"]);

function isBoundedValue(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  return typeof value === "string" && value.length <= 200;
}

/**
 * An http span's description is `"<METHOD> <url>"`; a navigation span's is a
 * route path. Anything else is free text an integration composed, which can
 * carry a caught server message or user input, so it is replaced rather than
 * parsed.
 */
function redactSpanDescription(description: string): string {
  const httpMatch = /^([A-Z]{3,7})\s+(\S+)$/u.exec(description);
  if (httpMatch) return `${httpMatch[1]} ${redactUrl(httpMatch[2] ?? "")}`;
  if (description.startsWith("/")) return redactPath(description);
  return REDACTED;
}

/** Mutates + returns the span with its description and data bag scrubbed. */
export function redactSpan<T extends RedactableSpan>(span: T): T {
  if (typeof span.description === "string") {
    span.description = redactSpanDescription(span.description);
  } else if (span.description !== undefined) {
    delete span.description;
  }
  const data = span.data;
  if (data) {
    for (const [key, value] of Object.entries(data)) {
      if (!SAFE_SPAN_DATA_KEYS.has(key)) {
        delete data[key];
      } else if (URL_SPAN_DATA_KEYS.has(key)) {
        if (typeof value === "string") data[key] = redactUrl(value);
        else delete data[key];
      } else if (!isBoundedValue(value)) {
        delete data[key];
      }
    }
  }
  return span;
}

/**
 * Reduce `contexts.trace` to its structural fields. Returns undefined when the
 * event has no trace context, so the caller can leave `contexts` deleted.
 */
function structuralTraceContext(
  event: RedactableTransaction,
): Record<string, unknown> | undefined {
  const contexts = event.contexts;
  if (typeof contexts !== "object" || contexts === null) return undefined;
  const trace = (contexts as Record<string, unknown>).trace;
  if (typeof trace !== "object" || trace === null) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(trace as Record<string, unknown>)) {
    if (SAFE_TRACE_KEYS.has(key) && isBoundedValue(value)) kept[key] = value;
  }
  return kept;
}

/** Mutates + returns the transaction with name, spans and trace context scrubbed. */
export function redactTransaction<T extends RedactableTransaction>(event: T): T {
  // Lifted BEFORE redactEvent, which deletes `contexts` outright.
  const trace = structuralTraceContext(event);
  redactEvent(event);
  if (trace) event.contexts = { trace };
  if (typeof event.transaction === "string") {
    event.transaction = event.transaction.startsWith("/")
      ? redactPath(event.transaction)
      : event.transaction;
  }
  for (const span of event.spans ?? []) redactSpan(span);
  return event;
}
