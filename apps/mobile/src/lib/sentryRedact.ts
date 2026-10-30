/**
 * Sentry PII/secret redaction for the mobile surface.
 *
 * The redaction rules are now owned by @postwave/telemetry — the single
 * source of truth every Moosewave surface (apps/api observability/sentry.go,
 * apps/web, apps/desktop, apps/mobile) shares so the scrub shape can't drift.
 * The 2026-06-21 ecosystem audit found these had diverged (desktop redacted
 * breadcrumb URLs; web + mobile did not). This module now just re-exports the
 * shared primitives so existing mobile imports (sentry.ts, the unit test)
 * keep working unchanged, and sentry.ts wires both `redactEvent` (beforeSend)
 * and `redactBreadcrumb` (beforeBreadcrumb).
 */

export {
  type RedactableEvent,
  type RedactableBreadcrumb,
  isSensitiveQueryKey,
  redactQueryString,
  redactUrl,
  redactEvent,
  redactBreadcrumb,
  type RedactableSpan,
  type RedactableTransaction,
  redactSpan,
  redactTransaction,
} from "@postwave/telemetry";
