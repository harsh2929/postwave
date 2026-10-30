/**
 * api/aiPiiMasking.ts — GET/PATCH /api/v1/settings/pii-config.
 *
 * Both verbs are admin in the routeauth manifest (family:admin). The route
 * answers 503 {code: pii_gateway_unconfigured} on a deployment without the
 * gateway; the card treats that as "hide", see lib/aiPiiMasking.ts.
 *
 * Mounted at apps/api/internal/subscribers/pii_config.go:60.
 */
import { rawRequest, type AIApiResult } from "./request";

import {
  normalizePiiMaskingConfig,
  type PiiMaskPatchBody,
  type PiiMaskingConfig,
} from "@/lib/aiPiiMasking";

const PATH = "/api/v1/settings/pii-config";

export async function getPiiMaskingConfig(): Promise<
  AIApiResult<PiiMaskingConfig>
> {
  const res = await rawRequest<unknown>("GET", PATH);
  if (res.error) return { data: null, error: res.error };
  return { data: normalizePiiMaskingConfig(res.data), error: null };
}

export async function patchPiiMaskingConfig(
  body: PiiMaskPatchBody,
): Promise<AIApiResult<PiiMaskingConfig>> {
  const res = await rawRequest<unknown>("PATCH", PATH, body);
  if (res.error) return { data: null, error: res.error };
  return { data: normalizePiiMaskingConfig(res.data), error: null };
}
