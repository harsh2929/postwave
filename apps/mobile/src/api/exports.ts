/**
 * api/exports.ts — the tenant data-export subsystem (GET/POST /api/v1/exports).
 *
 * This is NOT the privacy/DSAR export in src/api/settingsExtras.ts. That one
 * files a regulator-facing request and returns a reference id; this one builds a
 * ZIP of the workspace's own data and hands back a signed, time-limited
 * download URL. Mobile shipped the former and had no client for the latter at
 * all, which is backwards: a signed URL is more useful on a phone than
 * anywhere else, because the share sheet can put it straight into Files, a
 * password manager, or a colleague's inbox.
 *
 * Wire facts (apps/api/internal/exports/exports.go):
 *   - all three routes require the admin scope.
 *   - GET returns { exports: [...] }, newest first, LIMIT 200.
 *   - nullable columns are flattened to "" server-side (derefStr), never null.
 *   - POST with an empty/absent include[] defaults to every supported resource.
 */
import { rawRequest, type AIApiResult } from "./request";

import type { TenantExportRow } from "@/lib/exportRows";

export type { TenantExportRow } from "@/lib/exportRows";

export async function listTenantExports(): Promise<
  AIApiResult<{ exports: TenantExportRow[] }>
> {
  return rawRequest<{ exports: TenantExportRow[] }>("GET", "/api/v1/exports");
}

export async function getTenantExport(
  id: string,
): Promise<AIApiResult<TenantExportRow>> {
  return rawRequest<TenantExportRow>(
    "GET",
    `/api/v1/exports/${encodeURIComponent(id)}`,
  );
}

/**
 * Queue a new export.
 *
 * `include` is deliberately omitted rather than sent as [] — the server treats
 * an absent/empty list as "everything supported", and hard-coding the resource
 * list client-side is exactly how the outbound-webhook event catalog drifted
 * two entries behind the Go source.
 */
export async function requestTenantExport(): Promise<
  AIApiResult<{ id: string; status: string }>
> {
  return rawRequest<{ id: string; status: string }>(
    "POST",
    "/api/v1/exports",
    {},
  );
}
