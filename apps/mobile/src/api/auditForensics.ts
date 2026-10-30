/**
 * api/auditForensics.ts — transport for the per-event forensic endpoints.
 *
 * Routes and shapes are documented in lib/auditForensics (read off the Go
 * handlers). This module is only URLs, envelopes and the two error codes that
 * are ANSWERS rather than failures:
 *
 *   - inclusion-proof 425 `no_checkpoint` → the row is not rooted yet.
 *   - anomaly-score / session-replay return `available:false` bodies with 200,
 *     so they need no special-casing here.
 *
 * THE CHAIN ID MUST BE PERCENT-ENCODED. Every real correlation id contains a
 * literal slash (`hostname/b64-000001` — chi's request-id format), and chi
 * routes the encoded form as one path segment. An unencoded id would route to
 * a different (nonexistent) path entirely; encodeURIComponent is what keeps
 * this endpoint answering. See audit_chain.go's block comment.
 *
 * Parsing lives in lib/auditForensics so it is unit-testable under node; this
 * module keeps `./request` as its only impure import (the seam the transport
 * tests mock).
 */
import {
  parseAnomalyExplanation,
  parseAuditChain,
  parseInclusionProof,
  parseSessionReplay,
  parseUnmaskResult,
  type AnomalyExplanation,
  type AuditChainResult,
  type InclusionProofAnswer,
  type SessionReplayAnswer,
  type UnmaskResult,
} from "@/lib/auditForensics";

import { checkedApiResult, rawRequest } from "./request";

export function auditChainPath(requestId: string): string {
  return `/api/v1/audit/chain/${encodeURIComponent(requestId)}`;
}

export async function fetchAuditChain(
  requestId: string,
): Promise<AuditChainResult> {
  const res = await checkedApiResult(
    rawRequest<unknown>("GET", auditChainPath(requestId)),
  );
  return parseAuditChain(res.data);
}

export async function fetchAnomalyExplanation(
  auditId: number,
): Promise<AnomalyExplanation> {
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "GET",
      `/api/v1/audit/${encodeURIComponent(String(auditId))}/anomaly-score`,
    ),
  );
  return parseAnomalyExplanation(res.data);
}

/**
 * 425 `no_checkpoint` is the "not rooted yet" answer, not a failure — the
 * Merkle worker runs periodically and the row will be provable shortly.
 */
export async function fetchInclusionProof(
  auditId: number,
): Promise<InclusionProofAnswer> {
  const res = await rawRequest<unknown>(
    "GET",
    `/api/v1/audit/${encodeURIComponent(String(auditId))}/inclusion-proof`,
  );
  if (res.error) {
    if (res.error.status === 425) return { kind: "pending" };
    
    throw Object.assign(new Error(res.error.message), {
      status: res.error.status,
      ...(res.error.code ? { code: res.error.code } : {}),
    });
  }
  return parseInclusionProof(res.data);
}

export async function fetchSessionReplay(
  auditId: number,
): Promise<SessionReplayAnswer> {
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "GET",
      `/api/v1/audit/${encodeURIComponent(String(auditId))}/session-replay`,
    ),
  );
  return parseSessionReplay(res.data);
}

/**
 * Reveal an event's sealed metadata. The reveal itself is written into
 * audit_pii_unmask_history and emitted as an audit.pii_unmask row — this is a
 * READ THAT MINTS STATE, which is why it is press-driven, online-only and
 * never prefetched or queued.
 */
export async function unmaskAuditEvent(
  auditId: number,
  reason: string,
): Promise<UnmaskResult> {
  const res = await checkedApiResult(
    rawRequest<unknown>(
      "POST",
      `/api/v1/audit/${encodeURIComponent(String(auditId))}/unmask`,
      { reason: reason.trim() },
    ),
  );
  return parseUnmaskResult(res.data);
}

export interface RetentionOverrideInput {
  retentionOverrideDays?: number;
  legalHold?: boolean;
}

/** PATCH — each field applies independently; at least one must be present. */
export async function setAuditRetentionOverride(
  auditId: number,
  input: RetentionOverrideInput,
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (input.retentionOverrideDays !== undefined) {
    body.retention_override_days = input.retentionOverrideDays;
  }
  if (input.legalHold !== undefined) body.legal_hold = input.legalHold;
  await checkedApiResult(
    rawRequest<unknown>(
      "PATCH",
      `/api/v1/audit/${encodeURIComponent(String(auditId))}/retention-override`,
      body,
    ),
  );
}
