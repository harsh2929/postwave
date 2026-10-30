import { rawRequest, type AIApiResult } from "./request";

export type VoiceAxis =
  | "humor"
  | "formality"
  | "optimism"
  | "directness"
  | "warmth";

/**
 * The five tone axes the voice profile trains on. Use this constant to
 * render axis selectors so adding another axis only requires appending here
 * and in the backend `axes.AllowedAxes` mirror.
 */
export const VOICE_AXES: VoiceAxis[] = [
  "humor",
  "formality",
  "optimism",
  "directness",
  "warmth",
];

export interface VoiceLabel {
  id: string;
  tenant_id?: string;
  sample_id?: string;
  sample_text: string;
  axis: VoiceAxis;
  value: number;
  labeled_by_user_id?: string;
  notes?: string;
  created_at: string;
}

export interface VoiceLabelCreateInput {
  sample_text: string;
  axis: VoiceAxis;
  value: number;
  sample_id?: string;
  notes?: string;
}

export interface VoiceLabelListQuery {
  axis?: VoiceAxis;
  page?: number;
  size?: number;
}

export type VoiceLabelListResponse = {
  items: VoiceLabel[];
  total: number;
  page: number;
  size: number;
};

/**
 * GET /api/v1/voice/labels. The gateway returns `{items,total,page,size}`;
 * callers keep the full envelope so list UIs can read pagination metadata.
 */
export async function listVoiceLabels(
  opts: VoiceLabelListQuery = {},
): Promise<AIApiResult<VoiceLabelListResponse>> {
  const qs = new URLSearchParams();
  if (opts.axis) qs.set("axis", opts.axis);
  if (typeof opts.page === "number") qs.set("page", String(opts.page));
  if (typeof opts.size === "number") qs.set("size", String(opts.size));
  const query = qs.toString();
  const path = "/api/v1/voice/labels" + (query ? "?" + query : "");
  return rawRequest<VoiceLabelListResponse>("GET", path);
}

/** POST /api/v1/voice/labels — record a single label. */
export async function createVoiceLabel(
  input: VoiceLabelCreateInput,
): Promise<AIApiResult<{ id: string }>> {
  return rawRequest<{ id: string }>("POST", "/api/v1/voice/labels", input);
}

/** DELETE /api/v1/voice/labels/{id} — admin-only. */
export async function deleteVoiceLabel(
  id: string,
): Promise<AIApiResult<{ deleted: boolean }>> {
  return rawRequest<{ deleted: boolean }>(
    "DELETE",
    `/api/v1/voice/labels/${encodeURIComponent(id)}`,
  );
}
