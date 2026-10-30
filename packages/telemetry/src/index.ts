/**
 * @postwave/telemetry — one telemetry contract for every client: SDK-free
 * Sentry redaction (events + breadcrumbs), a uniform consent default
 * (opt-IN, capture only on explicit grant), and a canonical PostHog event
 * taxonomy. Closes the audit's split-consent, missing-breadcrumb-redaction,
 * and divergent-event-name findings.
 */

export {
  type RedactableEvent,
  type RedactableBreadcrumb,
  isSensitiveQueryKey,
  isSensitivePathSegment,
  redactQueryString,
  redactPath,
  redactUrl,
  redactEvent,
  redactBreadcrumb,
} from "./redact.js";

export {
  type RedactableSpan,
  type RedactableTransaction,
  redactSpan,
  redactTransaction,
} from "./redactTrace.js";

export {
  type ConsentState,
  TELEMETRY_CONSENT_DEFAULT,
  shouldCapture,
} from "./consent.js";

export { type EventName, EVENTS, isKnownEvent } from "./events.js";
