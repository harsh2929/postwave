/**
 * lib/auditSinkHealth.ts — pure health derivations for outbound audit
 * sinks, lifted out of app/(tabs)/audit-sinks.tsx so the circuit
 * vocabulary and the failure-budget arithmetic are testable and can't
 * drift from the desktop CircuitBadge/FailureMeter by accident.
 */

export interface AuditSinkHealthInput {
  enabled: boolean;
  circuit_state: string;
  consecutive_failures: number;
  auto_disable_after: number;
  cooldown_until?: string | null;
}

export type AuditSinkTone = "danger" | "warning" | "success";

export function sinkTone(sink: AuditSinkHealthInput): AuditSinkTone {
  if (!sink.enabled || sink.circuit_state === "open") return "danger";
  if (sink.circuit_state === "half_open" || sink.consecutive_failures > 0) {
    return "warning";
  }
  return "success";
}

/** Human-readable circuit badge, mirroring the desktop CircuitBadge labels. */
export function circuitLabel(sink: AuditSinkHealthInput): string {
  if (!sink.enabled) return "disabled";
  switch (sink.circuit_state) {
    case "closed":
      return "healthy";
    case "half_open":
      return "probing";
    case "open":
      return "open";
    default:
      return String(sink.circuit_state || "unknown");
  }
}

/**
 * Percent of the auto-disable budget consumed, clamped to 0-100 and
 * guarded against a zero/negative or non-finite auto_disable_after (the
 * payload is an unvalidated `as`-cast wire shape).
 */
export function failureBudgetPct(sink: AuditSinkHealthInput): number {
  const denom =
    Number.isFinite(sink.auto_disable_after) && sink.auto_disable_after > 0
      ? sink.auto_disable_after
      : 0;
  if (denom <= 0) return 0;
  const raw = (sink.consecutive_failures / denom) * 100;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Is the breaker in a state a reset would actually change? Drives whether
 * the "Reset circuit" action renders at all — offering it on a healthy
 * sink would be a no-op control.
 */
export function canResetCircuit(sink: AuditSinkHealthInput): boolean {
  return sink.circuit_state === "open" || sink.circuit_state === "half_open";
}

/**
 * Compact countdown used for the cooldown pill, e.g. "4m" / "now".
 * `now` is injected so the value ages with a ticking clock instead of
 * freezing at first render.
 */
export function relativeFromNow(value: string, now: number): string {
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return "soon";
  const diffMs = target - now;
  if (diffMs <= 0) return "now";
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
