/**
 * api/featureFlagOverrides.ts — the two writes behind the feature-flag
 * sheet. api/platformConfig.ts owns the list read.
 *
 *   POST   /api/v1/feature-flags        (admin)  upsert this workspace's override
 *   DELETE /api/v1/feature-flags/{key}  (admin)  remove this workspace's override
 *
 * Both from apps/api/internal/feature_flags/feature_flags.go (:130 Upsert,
 * :178 Delete). Neither touches a platform default.
 */
import { PlatformConfigError } from "./platformConfig";
import { rawRequest } from "./request";

import type { FlagUpsertBody } from "@/lib/featureFlagOverrides";

export interface FlagUpsertResult {
  id: string;
  key: string;
  value: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Create or update the override; the server answers `{id, key, value}`. */
export async function upsertFeatureFlag(
  body: FlagUpsertBody,
): Promise<FlagUpsertResult> {
  const res = await rawRequest<unknown>("POST", "/api/v1/feature-flags", body);
  if (res.error) {
    throw new PlatformConfigError(
      res.error.status,
      res.error.message || "Couldn't save the flag.",
    );
  }
  const r = (res.data ?? {}) as Record<string, unknown>;
  return { id: str(r.id), key: str(r.key) || body.key, value: str(r.value) };
}

/**
 * Remove this workspace's override. 204 on success; 404 means there was no
 * override to remove — reported as an error because the row the user tapped
 * claimed to be one, so the list is stale and the caller should refetch.
 */
export async function deleteFeatureFlagOverride(key: string): Promise<void> {
  const res = await rawRequest<unknown>(
    "DELETE",
    `/api/v1/feature-flags/${encodeURIComponent(key)}`,
  );
  if (res.error) {
    throw new PlatformConfigError(
      res.error.status,
      res.error.message || "Couldn't remove the override.",
    );
  }
}
