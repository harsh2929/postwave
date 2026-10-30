// SPDX-License-Identifier: AGPL-3.0-only
//
// campaignAssurance.ts — the ops view of Campaign Assurance runs.
//
// The API side (internal/ops/views/campaign_assurance.go over the content-free
// SECURITY DEFINER functions in migration 1938) has been mounted since it
// shipped, with nothing reading it. This is the reader.
//
// The disclosure boundary is the server's: no subject, body, extraction,
// prompt, provider payload, mailbox identity, or error MESSAGE crosses it —
// only a bounded error CODE. Nothing here re-derives content, and the strict
// key check below is what keeps it that way: a content-bearing field added
// server-side fails the parse instead of quietly appearing on an operator's
// screen.
import { fetchOpsViewJSON, viewStatusMessage } from "./opsViewFetch";
import {
  hasDuplicateKey,
  hasOnlyKeys,
  isBoundedText,
  isCanonicalUUID,
  isNonNegativeInteger,
  isRecord,
  isTimestamp,
  MAX_VIEW_ROWS,
} from "./viewSchema";

export interface AssuranceRunRow {
  tenant_id: string;
  campaign_id: string;
  run_id: string;
  run_no: number;
  trigger_kind: string;
  profile: string;
  state: string;
  gate_decision: string;
  attempt_count: number;
  max_attempts: number;
  error_code?: string;
  required_extraction_count: number;
  terminal_extraction_count: number;
  extraction_error_count: number;
  blocking_finding_count: number;
  cost_microunits: number;
  max_modeled_cost_microunits: number;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export type AssuranceRunsResult =
  | { ok: true; rows: AssuranceRunRow[]; nextCursor: string }
  | { ok: false; message: string };

const REQUIRED_KEYS = [
  "tenant_id", "campaign_id", "run_id", "run_no", "trigger_kind", "profile",
  "state", "gate_decision", "attempt_count", "max_attempts",
  "required_extraction_count", "terminal_extraction_count",
  "extraction_error_count", "blocking_finding_count",
  "cost_microunits", "max_modeled_cost_microunits", "created_at", "updated_at",
] as const;

// Present only when the run reached that stage. They are optional in the wire
// contract because Go omits a nil pointer, not because they are unimportant —
// an absent completed_at is exactly how "still running" is expressed.
const OPTIONAL_KEYS = [
  "error_code", "retry_not_before", "completed_at",
  "deterministic_target_count", "modeled_target_count",
  "controlled_observation_target_count", "input_tokens", "output_tokens",
  "invoked_extraction_count", "cache_reuse_count",
  "live_raw_evidence_count", "expired_raw_evidence_count",
  "next_raw_evidence_expiry", "seed_observation_count",
  "latest_seed_observation_at", "next_seed_observation_expiry",
  "command_delivery_attempt_count", "command_available_at",
  "command_lease_expires_at", "lease_expires_at", "heartbeat_at",
  "snapshot_frozen_at",
] as const;

const BAD_SHAPE = "campaign assurance returned an unexpected shape";

export function parseAssuranceRuns(status: number, body: unknown): AssuranceRunsResult {
  if (status !== 200) {
    return { ok: false, message: viewStatusMessage(status, "campaign assurance") };
  }
  if (!isRecord(body) || !hasOnlyKeys(body, ["runs"], ["next_cursor"])) {
    return { ok: false, message: BAD_SHAPE };
  }
  const raw = body.runs;
  if (!Array.isArray(raw) || raw.length > MAX_VIEW_ROWS) {
    return { ok: false, message: BAD_SHAPE };
  }
  // Absent means "last page" and Go omits it, so "" is the normal terminal
  // value. isBoundedText rejects empty strings, so only a present cursor is
  // length-checked.
  const nextCursor = body.next_cursor === undefined ? "" : body.next_cursor;
  if (typeof nextCursor !== "string") return { ok: false, message: BAD_SHAPE };
  if (nextCursor !== "" && !isBoundedText(nextCursor, 512)) {
    return { ok: false, message: BAD_SHAPE };
  }

  const rows: AssuranceRunRow[] = [];
  for (const candidate of raw) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, REQUIRED_KEYS, OPTIONAL_KEYS) ||
      !isCanonicalUUID(candidate.tenant_id) ||
      !isCanonicalUUID(candidate.campaign_id) ||
      !isCanonicalUUID(candidate.run_id) ||
      !isNonNegativeInteger(candidate.run_no) ||
      !isBoundedText(candidate.trigger_kind, 32) ||
      !isBoundedText(candidate.profile, 32) ||
      !isBoundedText(candidate.state, 32) ||
      !isBoundedText(candidate.gate_decision, 32) ||
      !isNonNegativeInteger(candidate.attempt_count) ||
      !isNonNegativeInteger(candidate.max_attempts) ||
      !isNonNegativeInteger(candidate.required_extraction_count) ||
      !isNonNegativeInteger(candidate.terminal_extraction_count) ||
      !isNonNegativeInteger(candidate.extraction_error_count) ||
      !isNonNegativeInteger(candidate.blocking_finding_count) ||
      !isNonNegativeInteger(candidate.cost_microunits) ||
      !isNonNegativeInteger(candidate.max_modeled_cost_microunits) ||
      !isTimestamp(candidate.created_at) ||
      !isTimestamp(candidate.updated_at)
    ) {
      return { ok: false, message: BAD_SHAPE };
    }
    if (candidate.error_code !== undefined && !isBoundedText(candidate.error_code, 128)) {
      return { ok: false, message: BAD_SHAPE };
    }
    if (candidate.completed_at !== undefined && !isTimestamp(candidate.completed_at)) {
      return { ok: false, message: BAD_SHAPE };
    }
    rows.push({
      tenant_id: candidate.tenant_id,
      campaign_id: candidate.campaign_id,
      run_id: candidate.run_id,
      run_no: candidate.run_no,
      trigger_kind: candidate.trigger_kind,
      profile: candidate.profile,
      state: candidate.state,
      gate_decision: candidate.gate_decision,
      attempt_count: candidate.attempt_count,
      max_attempts: candidate.max_attempts,
      required_extraction_count: candidate.required_extraction_count,
      terminal_extraction_count: candidate.terminal_extraction_count,
      extraction_error_count: candidate.extraction_error_count,
      blocking_finding_count: candidate.blocking_finding_count,
      cost_microunits: candidate.cost_microunits,
      max_modeled_cost_microunits: candidate.max_modeled_cost_microunits,
      created_at: candidate.created_at,
      updated_at: candidate.updated_at,
      ...(candidate.error_code === undefined ? {} : { error_code: candidate.error_code }),
      ...(candidate.completed_at === undefined ? {} : { completed_at: candidate.completed_at }),
    });
  }
  // A repeated run id means a paging bug, and a double-counted run makes an
  // incident look twice as bad as it is.
  if (hasDuplicateKey(rows, (row) => row.run_id)) {
    return { ok: false, message: BAD_SHAPE };
  }
  return { ok: true, rows, nextCursor };
}

export type RunHealth =
  | "blocked"
  | "incomplete"
  | "failed"
  | "at-cost-ceiling"
  | "running"
  | "complete";

/**
 * The one line an operator reads per run. Each value is a DIFFERENT action, so
 * none of them may be collapsed:
 *
 *   blocked         assurance worked and refused the send — fix the campaign,
 *                   do not investigate the platform
 *   incomplete      required evidence was unavailable; NOT a pass
 *   failed          the run itself broke and has burned its attempts
 *   at-cost-ceiling it stopped for budget rather than for a verdict
 */
export function runHealth(row: AssuranceRunRow): RunHealth {
  if (row.state === "failed" || row.state === "cancelled") return "failed";
  if (row.state === "incomplete") return "incomplete";
  if (row.gate_decision === "block") return "blocked";
  if (
    row.max_modeled_cost_microunits > 0 &&
    row.cost_microunits >= row.max_modeled_cost_microunits
  ) {
    return "at-cost-ceiling";
  }
  if (row.state === "complete") return "complete";
  return "running";
}

export function healthColor(health: RunHealth): string {
  switch (health) {
    case "failed":
      return "var(--red)";
    case "blocked":
    case "incomplete":
    case "at-cost-ceiling":
      return "var(--amber)";
    case "complete":
      return "var(--green)";
    default:
      return "var(--fg-muted)";
  }
}

export async function fetchAssuranceRuns(): Promise<AssuranceRunsResult> {
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/views/campaign-assurance/runs?limit=${MAX_VIEW_ROWS}`,
  );
  if (!result.ok) {
    return { ok: false, message: viewStatusMessage(result.status, "campaign assurance") };
  }
  return parseAssuranceRuns(result.status, result.body);
}
