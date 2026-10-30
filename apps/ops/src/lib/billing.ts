// SPDX-License-Identifier: AGPL-3.0-only
//
// billing.ts — typed fetch of the ops Billing view, same fail-loud contract as
// the other views. usageColor encodes the quota lines an operator acts on:
// dunning is always red, then >=100% (overage) red, >=80% amber, otherwise green.
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

export interface BillingRow {
  tenant_id: string;
  slug: string;
  name: string;
  tier: string;
  dunning: boolean;
  monthly_sends_used: number;
  monthly_sends_cap: number;
  usage_fraction: number;
}

export type BillingResult =
  | { ok: true; rows: BillingRow[]; truncated: boolean }
  | { ok: false; message: string };

export function parseBilling(status: number, body: unknown): BillingResult {
  if (status !== 200) return { ok: false, message: viewStatusMessage(status, "billing") };
  const envelope = parseTruncatedEnvelope(body, "tenants");
  if (!envelope) return { ok: false, message: "billing returned an unexpected shape" };
  const rows: BillingRow[] = [];
  for (const candidate of envelope.rows) {
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, [
        "tenant_id", "slug", "name", "tier", "dunning", "monthly_sends_used",
        "monthly_sends_cap", "usage_fraction",
      ]) ||
      !isCanonicalUUID(candidate.tenant_id) ||
      !isBoundedText(candidate.slug, 128) ||
      !isBoundedText(candidate.name, 256) ||
      !isBoundedText(candidate.tier, 64) ||
      typeof candidate.dunning !== "boolean" ||
      !isNonNegativeInteger(candidate.monthly_sends_used) ||
      !isNonNegativeInteger(candidate.monthly_sends_cap) ||
      candidate.monthly_sends_cap === 0 ||
      !isNonNegativeFinite(candidate.usage_fraction) ||
      candidate.usage_fraction !== candidate.monthly_sends_used / candidate.monthly_sends_cap
    ) return { ok: false, message: "billing returned an unexpected shape" };
    rows.push({
      tenant_id: candidate.tenant_id,
      slug: candidate.slug,
      name: candidate.name,
      tier: candidate.tier,
      dunning: candidate.dunning,
      monthly_sends_used: candidate.monthly_sends_used,
      monthly_sends_cap: candidate.monthly_sends_cap,
      usage_fraction: candidate.usage_fraction,
    });
  }
  if (hasDuplicateKey(rows, (row) => row.tenant_id)) {
    return { ok: false, message: "billing returned an unexpected shape" };
  }
  return { ok: true, rows, truncated: envelope.truncated };
}

// usageColor: red if in dunning or over quota, amber >= 80%, else green.
export function usageColor(fraction: number, dunning: boolean): string {
  if (dunning || fraction >= 1) return "var(--red)";
  if (fraction >= 0.8) return "var(--amber)";
  return "var(--green)";
}

export async function fetchBilling(): Promise<BillingResult> {
  const result = await fetchOpsViewJSON(
    `/api/internal/ops/views/billing/by-tenant?limit=${MAX_VIEW_ROWS}`,
  );
  if (!result.ok) return { ok: false, message: viewStatusMessage(result.status, "billing") };
  return parseBilling(result.status, result.body);
}
