/**
 * lib/audienceDestinationActions.ts — the wire contracts for the three
 * destination verbs/reads that arrived after the monitor shipped: sync-now,
 * membership preview, and per-job diagnostics.
 *
 * Pure and react-native-free so node-run vitest covers every rule; the
 * transport lives in api/audienceDestinations.ts, same seam as
 * lib/audienceDestinationRows.ts.
 *
 * ── SYNC-NOW IS ALWAYS 202, AND THE STATUS IS THE OUTCOME ──────────────────
 * `Sync` (audience_destinations/handlers.go:405-545) answers 202 Accepted on
 * EVERY terminal path — success, failure, cap rejection — with a `status`
 * field carrying the run vocabulary (syncs.go:89-93 plus `partial` and
 * `needs_reconciliation` from destinationTerminalStatus, handlers.go:554-565).
 * So an HTTP-level success is NOT a delivery: every caller must read the
 * returned status, exactly the trap runNowResultMessage already documents for
 * audience syncs.
 *
 * The handler honors `Idempotency-Key` via `manualOperationKey` and answers a
 * replay with `replayed: true` plus the ORIGINAL job — a retry after a client
 * timeout converges on the same server-side operation instead of opening a
 * second delivery to a live ad audience.
 *
 * ── DIAGNOSTICS REFUSALS ARE REASONS, NOT FAILURES ─────────────────────────
 * `JobDiagnostics` (handlers.go:584-643) refuses with five distinct codes.
 * Each is a fact about the job or the server, not a transient error, and the
 * sheet renders the sentence rather than a generic "couldn't load".
 */

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Mirrors newRunOperationKey for audience syncs; one key per press. */
export function newDestinationSyncKey(destinationId: string): string {
  return `mobile-audience-destination-${destinationId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

export interface DestinationSyncNowResult {
  /** running | succeeded | failed | rejected | partial | needs_reconciliation. */
  status: string;
  /** True when Idempotency-Key matched an earlier operation. */
  replayed: boolean;
  providerMessage: string;
  /** The job row's error text — the failure reason on the early-exit paths. */
  jobError: string;
  membersSent: number | null;
  excludedCount: number | null;
  capExceeded: boolean;
}

export function parseSyncNowResult(raw: unknown): DestinationSyncNowResult {
  const body = rec(raw);
  const job = rec(body.job);
  return {
    status: str(body.status) || str(job.status),
    replayed: body.replayed === true,
    providerMessage: str(body.provider_message),
    jobError: str(job.error),
    membersSent: num(body.members_sent) ?? num(job.members_synced),
    excludedCount: num(body.excluded_count),
    capExceeded: body.cap_exceeded === true || job.cap_exceeded === true,
  };
}

export interface SyncNowMessage {
  kind: "success" | "error";
  message: string;
}

/**
 * The sentence for a finished sync-now, keyed on the RETURNED status — never
 * on the HTTP status, which is 202 for every one of these.
 *
 * `needs_reconciliation` is deliberately an error tone: the runner could not
 * establish whether the provider took the members, and "maybe delivered" must
 * not read as delivered (same rule as syncJobTone).
 */
export function syncNowResultMessage(
  result: DestinationSyncNowResult,
  provider: string,
): SyncNowMessage {
  const name = provider || "the destination";
  const replayNote = result.replayed
    ? " (this press matched an earlier run — no second delivery was made)"
    : "";
  if (result.status === "succeeded") {
    const sent =
      result.membersSent !== null
        ? `${result.membersSent} member${result.membersSent === 1 ? "" : "s"}`
        : "the audience";
    const withheld =
      result.excludedCount !== null && result.excludedCount > 0
        ? ` — ${result.excludedCount} withheld by the consent firewall`
        : "";
    return {
      kind: "success",
      message: `Pushed ${sent} to ${name}${withheld}${replayNote}.`,
    };
  }
  if (result.status === "running") {
    return {
      kind: "success",
      message: `A push to ${name} is already in flight; its outcome lands in the sync history${replayNote}.`,
    };
  }
  if (result.status === "rejected" && result.capExceeded) {
    return {
      kind: "error",
      message: `Rejected: the audience is over the size cap, so nothing was sent to ${name}.`,
    };
  }
  if (result.status === "partial") {
    const sent = result.membersSent !== null ? `${result.membersSent}` : "some";
    return {
      kind: "error",
      message: `Partial: only ${sent} members reached ${name}. ${result.jobError || result.providerMessage}`.trim(),
    };
  }
  if (result.status === "needs_reconciliation") {
    return {
      kind: "error",
      message: `${name} may or may not have taken the members — the outcome could not be confirmed. Check the sync history before pushing again.`,
    };
  }
  const reason = result.jobError || result.providerMessage;
  return {
    kind: "error",
    message: reason
      ? `The push to ${name} failed: ${reason}`
      : `The push to ${name} failed.`,
  };
}

export interface DestinationPreview {
  provider: string;
  totalMembers: number | null;
  excludedCount: number | null;
  deliverable: number | null;
  truncated: boolean;
  firewallActive: boolean;
}

/** GET /{id}/preview — bare map (handlers.go:151). */
export function parseDestinationPreview(raw: unknown): DestinationPreview {
  const body = rec(raw);
  return {
    provider: str(body.provider),
    totalMembers: num(body.total_members),
    excludedCount: num(body.excluded_count),
    deliverable: num(body.deliverable),
    truncated: body.truncated === true,
    firewallActive: body.firewall_active === true,
  };
}

/**
 * The membership sentences. A null count renders as "not reported" rather
 * than 0 — zero is a claim about the audience, null is a gap in the answer.
 */
export function previewLines(preview: DestinationPreview): string[] {
  const show = (value: number | null) =>
    value === null ? "not reported" : String(value);
  const lines = [
    `${show(preview.totalMembers)} in the source audience`,
    `${show(preview.excludedCount)} withheld by the consent firewall`,
    `${show(preview.deliverable)} would be pushed`,
  ];
  if (preview.truncated) {
    lines.push(
      "The source is over the size cap — a real push would be rejected.",
    );
  }
  if (!preview.firewallActive) {
    lines.push(
      "The consent firewall is not active on this server, so nothing would be withheld.",
    );
  }
  return lines;
}

export interface JobDiagnostics {
  provider: string;
  providerStatus: string;
  providerMessage: string;
  externalJobId: string;
  externalAudienceId: string;
  jobStatus: string;
  jobError: string;
}

/** GET /{id}/jobs/{job_id}/diagnostics — {destination, job, diagnostics}. */
export function parseJobDiagnostics(raw: unknown): JobDiagnostics {
  const body = rec(raw);
  const job = rec(body.job);
  const diag = rec(body.diagnostics);
  return {
    provider: str(diag.provider),
    providerStatus: str(diag.provider_status),
    providerMessage: str(diag.provider_message),
    externalJobId: str(diag.external_job_id),
    externalAudienceId: str(diag.external_audience_id),
    jobStatus: str(job.status),
    jobError: str(job.error),
  };
}

/**
 * The refusal sentence for a diagnostics read, by the server's own code —
 * or null for errors that are NOT a classified refusal, which the caller
 * hands to errorPresentation like any other failure.
 *
 * These are facts, not transient errors: retrying `diagnostics_unavailable`
 * can never succeed, so the copy explains rather than apologises.
 */
export function diagnosticsRefusalMessage(error: unknown): string | null {
  const e = rec(error);
  const code = str(e.code);
  const status = num(e.status);
  if (code === "diagnostics_unavailable") {
    return "No provider request id was recorded for this job, so there is nothing to look up on the provider's side.";
  }
  if (code === "diagnostics_not_supported") {
    return "This provider does not support job diagnostics.";
  }
  if (code === "adapter_unavailable") {
    return "The provider adapter is not configured on this server, so the provider cannot be asked.";
  }
  if (code === "credential_resolution_failed") {
    return "The provider credentials could not be resolved. Fixing them is done from the web admin.";
  }
  if (code === "provider_diagnostics_failed") {
    return "The provider refused the diagnostics lookup. Its sync history above still shows what was recorded locally.";
  }
  if (status === 403) {
    return "Your role cannot read job diagnostics on this workspace.";
  }
  return null;
}
