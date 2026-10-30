/**
 * api/customFieldLimits.ts — GET/PUT /api/v1/settings/custom-fields.
 *
 * GET is viewer in the routeauth manifest (api-key scope read:subscribers) and
 * PUT is admin (scope admin), which is why the card reads for everyone in the
 * workspace and only offers the editor to admins.
 *
 * Mounted at apps/api/internal/customfields/limits.go:343-345.
 */
import { rawRequest, type AIApiResult } from "./request";

import {
  normalizeCustomFieldLimits,
  type CustomFieldLimits,
  type CustomFieldLimitsPatchBody,
} from "@/lib/customFieldLimits";

const PATH = "/api/v1/settings/custom-fields";

export async function getCustomFieldLimits(): Promise<
  AIApiResult<CustomFieldLimits | null>
> {
  const res = await rawRequest<unknown>("GET", PATH);
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeCustomFieldLimits(res.data), error: null };
}

export async function putCustomFieldLimits(
  body: CustomFieldLimitsPatchBody,
): Promise<AIApiResult<CustomFieldLimits | null>> {
  const res = await rawRequest<unknown>("PUT", PATH, body);
  if (res.error) return { data: null, error: res.error };
  return { data: normalizeCustomFieldLimits(res.data), error: null };
}
