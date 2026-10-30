/**
 * Tenant-scoped derived health for one email recipient.
 *
 * The response contract lives in `api/emailHealthWire.ts` and is re-exported
 * here unchanged, so `@/api/emailHealth` stays the one import site callers
 * already use.
 */
import {
  EMAIL_HEALTH_GRADES,
  isRecord,
  isSafeLine,
  parseEmailHealth,
} from "@/api/emailHealthWire";
import type {
  EmailHealth,
  EmailHealthBatchResponse,
  EmailHealthGrade,
} from "@/api/emailHealthWire";
import { getClient } from "@/api/sdkClient";
import { WireShapeError } from "@/lib/wireShapeError";

const BATCH_MALFORMED = "Email health batch response was malformed.";

export { EMAIL_HEALTH_GRADES, parseEmailHealth };
export type {
  EmailHealth,
  EmailHealthBatchResponse,
  EmailHealthEvidence,
  EmailHealthEvidenceKind,
  EmailHealthGrade,
  EmailHealthRecommendation,
  EmailVerificationStatus,
} from "@/api/emailHealthWire";

export async function getEmailHealth(address: string): Promise<EmailHealth> {
  const normalized = address.trim().toLowerCase();
  const { client } = getClient();
  const payload = await client.request<unknown>(
    "GET",
    `/api/v1/verification/health?email=${encodeURIComponent(normalized)}`,
  );
  const parsed = parseEmailHealth(payload, normalized);
  if (!parsed) {
    throw new WireShapeError(
      "email health",
      "Email health response was malformed.",
    );
  }
  return parsed;
}

export async function getEmailHealthBatch(
  emails: string[],
): Promise<EmailHealthBatchResponse> {
  const { client } = getClient();
  const payload = await client.request<unknown>(
    "POST",
    "/api/v1/verification/health/batch",
    { body: { emails } },
  );
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.results) ||
    !isRecord(payload.summary) ||
    !Number.isSafeInteger(payload.total) ||
    !Number.isSafeInteger(payload.duplicates) ||
    Number(payload.total) < 0 ||
    Number(payload.duplicates) < 0 ||
    payload.total !== payload.results.length ||
    Number(payload.total) + Number(payload.duplicates) !== emails.length ||
    !isSafeLine(payload.model_version) ||
    payload.model_version.trim().length === 0
  ) {
    throw new WireShapeError("email health batch", BATCH_MALFORMED);
  }
  const requested = new Set(emails.map((item) => item.trim().toLowerCase()));
  const results = payload.results.map((item) => parseEmailHealth(item));
  if (
    results.length > 1_000 ||
    results.some((item) => item === null || !requested.has(item.email)) ||
    new Set(results.map((item) => item?.email)).size !== results.length
  ) {
    throw new WireShapeError("email health batch", BATCH_MALFORMED);
  }
  const summary = {} as Record<EmailHealthGrade, number>;
  let total = 0;
  for (const grade of EMAIL_HEALTH_GRADES) {
    const count = payload.summary[grade];
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      throw new WireShapeError("email health batch", BATCH_MALFORMED);
    }
    summary[grade] = Number(count);
    total += Number(count);
  }
  if (
    Object.keys(payload.summary).length !== 6 ||
    total !== results.length ||
    results.some((item) => item?.model_version !== payload.model_version)
  ) {
    throw new WireShapeError("email health batch", BATCH_MALFORMED);
  }
  return {
    results: results as EmailHealth[],
    summary,
    total: Number(payload.total),
    duplicates: Number(payload.duplicates),
    model_version: payload.model_version,
  };
}
