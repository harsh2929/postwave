/**
 * api/campaignSendTimeSetting.ts — the workspace default for send-time
 * optimization on NEW campaigns.
 *
 * GET/PUT /api/v1/settings/send-time-optimization
 * (apps/api/internal/settings/send_time_optimization.go) — both ADMIN in the
 * routeauth manifest, the same floor the send-time screen already carries.
 * Wire shape is {enabled: bool} both ways; the PUT decodes a pointer, so the
 * body must carry the field explicitly.
 */
import { rawRequest, type AIApiResult } from "./request";

const PATH = "/api/v1/settings/send-time-optimization";

export async function getSendTimeOptimizationSetting(): Promise<
  AIApiResult<unknown>
> {
  return rawRequest<unknown>("GET", PATH);
}

export async function putSendTimeOptimizationSetting(
  enabled: boolean,
): Promise<AIApiResult<unknown>> {
  return rawRequest<unknown>("PUT", PATH, { enabled });
}
