/**
 * lib/exportRetentionPolicy.ts — the pure half of the export-retention row.
 *
 * Desktop's ExportRetentionSection (apps/desktop/src/components/settings/
 * ExportRetentionSection.tsx) reads and edits GET/PATCH
 * /api/v1/exports/retention-policy; mobile listed the export bundles and
 * could not say how long they are kept or how many may be active.
 *
 * WIRE SHAPE (apps/api/internal/exports/retention.go):
 *   GET / PATCH → { retention_days, max_per_tenant, current_storage_bytes,
 *                   updated_at? }
 *   PATCH body  → { retention_days?, max_per_tenant? }   (only what changed)
 *   400 out_of_range            — server-side bounds, mirrored in LIMITS
 *   409 export_capacity_conflict — lowering the cap below the live count of
 *                                  queued/running/ready bundles; the server's
 *                                  message names both numbers and is shown
 *                                  verbatim.
 *
 * Import-free apart from the shared byte formatter so it runs under node
 * vitest.
 */
import { bytes } from "./format";

export interface ExportRetentionPolicy {
  retentionDays: number;
  maxPerTenant: number;
  currentStorageBytes: number;
  /** ISO timestamp, "" when the policy has never been saved. */
  updatedAt: string;
}

/** The handler's own bounds (MinRetentionDays … MaxExportsPerTenant). */
export const EXPORT_RETENTION_LIMITS = {
  retentionDays: { min: 7, max: 2555 },
  maxPerTenant: { min: 1, max: 500 },
} as const;

export interface ExportRetentionDraft {
  retentionDays: string;
  maxPerTenant: string;
}

export interface ExportRetentionPatchBody {
  retention_days?: number;
  max_per_tenant?: number;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

/**
 * True for a value already shaped as a policy. The card re-validates what the
 * query hands it (a shared cache can hold any shape) before reading numbers
 * off it — `policy.retentionDays` on an array renders "undefined days".
 */
export function isExportRetentionPolicy(
  value: unknown,
): value is ExportRetentionPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    int(v.retentionDays) !== null &&
    int(v.maxPerTenant) !== null &&
    int(v.currentStorageBytes) !== null &&
    typeof v.updatedAt === "string"
  );
}

/** The wire row → a policy, or null when the two governing numbers are missing. */
export function normalizeExportRetentionPolicy(
  payload: unknown,
): ExportRetentionPolicy | null {
  const raw = (payload ?? {}) as Record<string, unknown>;
  const retentionDays = int(raw.retention_days);
  const maxPerTenant = int(raw.max_per_tenant);
  if (retentionDays === null || maxPerTenant === null) return null;
  return {
    retentionDays,
    maxPerTenant,
    currentStorageBytes: Math.max(0, int(raw.current_storage_bytes) ?? 0),
    updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : "",
  };
}

/** A policy as the strings two numeric inputs hold. */
export function exportRetentionDraft(
  policy: ExportRetentionPolicy,
): ExportRetentionDraft {
  return {
    retentionDays: String(policy.retentionDays),
    maxPerTenant: String(policy.maxPerTenant),
  };
}

/**
 * Digits typed into one field → an integer inside that field's bounds, or
 * null. Non-digits are ignored the way the retention inputs on
 * PrivacyRetentionSection ignore them.
 */
export function parseExportRetentionField(
  text: string,
  key: keyof typeof EXPORT_RETENTION_LIMITS,
): number | null {
  const digits = text.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  const limit = EXPORT_RETENTION_LIMITS[key];
  if (!Number.isFinite(n) || n < limit.min || n > limit.max) return null;
  return n;
}

/**
 * The PATCH for a draft against the policy it was edited from. Only changed
 * fields are sent; an unchanged draft yields an empty body the caller treats
 * as "nothing to save".
 */
export function exportRetentionPatch(
  policy: ExportRetentionPolicy,
  draft: ExportRetentionDraft,
): { ok: true; body: ExportRetentionPatchBody } | { ok: false; message: string } {
  const days = parseExportRetentionField(draft.retentionDays, "retentionDays");
  const max = parseExportRetentionField(draft.maxPerTenant, "maxPerTenant");
  if (days === null || max === null) {
    return {
      ok: false,
      message: `Retention must be ${EXPORT_RETENTION_LIMITS.retentionDays.min}-${EXPORT_RETENTION_LIMITS.retentionDays.max} days and active exports ${EXPORT_RETENTION_LIMITS.maxPerTenant.min}-${EXPORT_RETENTION_LIMITS.maxPerTenant.max}.`,
    };
  }
  const body: ExportRetentionPatchBody = {};
  if (days !== policy.retentionDays) body.retention_days = days;
  if (max !== policy.maxPerTenant) body.max_per_tenant = max;
  return { ok: true, body };
}

/** True when the draft differs from the saved policy (or is unparseable). */
export function exportRetentionDirty(
  policy: ExportRetentionPolicy,
  draft: ExportRetentionDraft,
): boolean {
  const result = exportRetentionPatch(policy, draft);
  return !result.ok || Object.keys(result.body).length > 0;
}

/** The one-line reading of a policy; every number is the server's. */
export function exportRetentionSummary(policy: ExportRetentionPolicy): string {
  const days = policy.retentionDays === 1 ? "1 day" : `${policy.retentionDays} days`;
  const active =
    policy.maxPerTenant === 1
      ? "1 active export"
      : `${policy.maxPerTenant} active exports`;
  return `New bundles are kept ${days} after completion, up to ${active}. ${bytes(policy.currentStorageBytes)} stored now.`;
}

/**
 * The sentence a failed save shows. A capacity conflict and an out-of-range
 * rejection both carry a server sentence that names the numbers involved, so
 * those are shown verbatim rather than paraphrased.
 */
export function exportRetentionSaveError(error: {
  status: number;
  code?: string;
  message: string;
}): string {
  if (error.status === 403) {
    return "Only workspace admins can change export retention.";
  }
  if (
    (error.status === 409 || error.status === 400) &&
    error.message.trim() !== ""
  ) {
    return error.message;
  }
  return error.message || "Couldn't save the export retention policy.";
}
