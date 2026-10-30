// SPDX-License-Identifier: AGPL-3.0-only
//
// deliverability.ts — typed fetch of the ops Deliverability view, same fail-loud
// contract as the other views. rateColor encodes the mailbox-provider lines:
// 0.10% (harm begins) and 0.30% (the hard ceiling Gmail/Yahoo/Outlook reject at).
import { fetchOpsViewJSON, viewStatusMessage } from "./opsViewFetch";
import {
  hasDuplicateKey,
  hasOnlyKeys,
  isBoundedText,
  isCanonicalUUID,
  isNonNegativeFinite,
  isNonNegativeInteger,
  isRecord,
  MAX_VIEW_ROWS,
  parseTruncatedEnvelope,
} from "./viewSchema";

export interface DeliverabilityRow {
  tenant_id: string;
  slug: string;
  name: string;
  sent_7d: number;
  complained_7d: number;
  bounced_7d: number;
  unsubscribed_7d: number;
  complaint_rate: number;
  bounce_rate: number;
}

export type DeliverabilityResult =
  | { ok: true; rows: DeliverabilityRow[]; truncated: boolean }
  | { ok: false; message: string };

export function parseDeliverability(status: number, body: unknown): DeliverabilityResult {
  if (status !== 200) return { ok: false, message: viewStatusMessage(status, "deliverability") };
  const envelope = parseTruncatedEnvelope(body, "tenants");
  if (!envelope) return { ok: false, message: "deliverability returned an unexpected shape" };
  const rows: DeliverabilityRow[] = [];
  for (const candidate of envelope.rows) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, [
        "tenant_id", "slug", "name", "sent_7d", "complained_7d",
        "bounced_7d", "unsubscribed_7d", "complaint_rate", "bounce_rate",
      ]) ||
      !isCanonicalUUID(candidate.tenant_id) ||
      !isBoundedText(candidate.slug, 128) ||
      !isBoundedText(candidate.name, 256) ||
      !isNonNegativeInteger(candidate.sent_7d) ||
      !isNonNegativeInteger(candidate.complained_7d) ||
      !isNonNegativeInteger(candidate.bounced_7d) ||
      !isNonNegativeInteger(candidate.unsubscribed_7d) ||
      !isNonNegativeFinite(candidate.complaint_rate) ||
      !isNonNegativeFinite(candidate.bounce_rate)
    ) return { ok: false, message: "deliverability returned an unexpected shape" };
    const expectedComplaint = candidate.sent_7d === 0 ? 0 : candidate.complained_7d / candidate.sent_7d;
    const expectedBounce = candidate.sent_7d === 0 ? 0 : candidate.bounced_7d / candidate.sent_7d;
    if (candidate.complaint_rate !== expectedComplaint || candidate.bounce_rate !== expectedBounce) {
      return { ok: false, message: "deliverability returned inconsistent rates" };
    }
    rows.push({
      tenant_id: candidate.tenant_id,
      slug: candidate.slug,
      name: candidate.name,
      sent_7d: candidate.sent_7d,
      complained_7d: candidate.complained_7d,
      bounced_7d: candidate.bounced_7d,
      unsubscribed_7d: candidate.unsubscribed_7d,
      complaint_rate: candidate.complaint_rate,
      bounce_rate: candidate.bounce_rate,
    });
  }
  if (hasDuplicateKey(rows, (row) => row.tenant_id)) {
    return { ok: false, message: "deliverability returned an unexpected shape" };
  }
  return { ok: true, rows, truncated: envelope.truncated };
}

// rateColor: green < 0.10%, amber < 0.30%, red >= 0.30% (the enforced ceiling).
export function rateColor(rate: number): string {
  if (rate >= 0.003) return "var(--red)";
  if (rate >= 0.001) return "var(--amber)";
  return "var(--green)";
}

export async function fetchDeliverability(): Promise<DeliverabilityResult> {
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/views/deliverability/by-tenant?limit=${MAX_VIEW_ROWS}`,
  );
  if (!result.ok) return { ok: false, message: viewStatusMessage(result.status, "deliverability") };
  return parseDeliverability(result.status, result.body);
}
