/**
 * api/exportRetentionPolicy.ts — GET/PATCH /api/v1/exports/retention-policy.
 *
 * Both verbs are admin in the routeauth manifest, the same floor as the
 * export list this row sits beneath. The GET upserts the defaults on first
 * read, so it always answers a row.
 *
 * Mounted at apps/api/internal/exports/retention.go:76.
 */
import { rawRequest, type AIApiResult } from "./request";

import {
  normalizeExportRetentionPolicy,
  type ExportRetentionPatchBody,
  type ExportRetentionPolicy,
} from "@/lib/exportRetentionPolicy";

const PATH = "/api/v1/exports/retention-policy";

export async function getExportRetentionPolicy(): Promise<
  AIApiResult<ExportRetentionPolicy | null>
> {
  const res = await rawRequest<unknown>("GET", PATH);
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeExportRetentionPolicy(res.data), error: null };
}

export async function patchExportRetentionPolicy(
  body: ExportRetentionPatchBody,
): Promise<AIApiResult<ExportRetentionPolicy | null>> {
  const res = await rawRequest<unknown>("PATCH", PATH, body);
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeExportRetentionPolicy(res.data), error: null };
}
