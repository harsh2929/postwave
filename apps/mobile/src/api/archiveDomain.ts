/**
 * api/archiveDomain.ts — the archive vanity-host lifecycle.
 *
 * Four admin routes, all `session_minimum_role: admin` in the routeauth
 * manifest (api-key scope `admin`):
 *   GET    /api/v1/admin/archive/domain          custom_domain.go:584
 *   POST   /api/v1/admin/archive/domain/verify   custom_domain.go:585
 *   DELETE /api/v1/admin/archive/domain          custom_domain.go:586
 *   PUT    /api/v1/admin/archive/tenant-settings tenant_settings.go:693
 *
 * The domain itself lives on tenant_public_settings (PUT tenant-settings) and
 * the verification row lives beside it (GET/POST/DELETE domain) — which is why
 * clearing the domain and removing the verification are two separate verbs.
 * A verification row left behind keeps resolving that host to this tenant.
 */
import { rawRequest, type AIApiResult } from "./request";

import {
  normalizeArchiveDomainSettings,
  normalizeArchiveDomainStatus,
  type ArchiveDomainSettings,
  type ArchiveDomainStatus,
} from "@/lib/archiveDomain";

const DOMAIN_PATH = "/api/v1/admin/archive/domain";
const TENANT_SETTINGS_PATH = "/api/v1/admin/archive/tenant-settings";

export async function getArchiveDomainStatus(): Promise<
  AIApiResult<ArchiveDomainStatus | null>
> {
  const res = await rawRequest<unknown>("GET", DOMAIN_PATH);
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeArchiveDomainStatus(res.data), error: null };
}

export async function verifyArchiveDomain(): Promise<
  AIApiResult<ArchiveDomainStatus | null>
> {
  const res = await rawRequest<unknown>("POST", `${DOMAIN_PATH}/verify`, {});
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeArchiveDomainStatus(res.data), error: null };
}

/** 204 No Content — clears the verification row, not the column. */
export async function deleteArchiveDomainVerification(): Promise<
  AIApiResult<null>
> {
  const res = await rawRequest<unknown>("DELETE", DOMAIN_PATH);
  if (res.error) return { data: null, error: res.error };
  return { data: null, error: null };
}

/** PATCH-style: only archive_domain is sent; "" clears the column. */
export async function saveArchiveDomain(
  domain: string,
): Promise<AIApiResult<ArchiveDomainSettings | null>> {
  const res = await rawRequest<unknown>("PUT", TENANT_SETTINGS_PATH, {
    archive_domain: domain,
  });
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeArchiveDomainSettings(res.data), error: null };
}
