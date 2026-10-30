// SPDX-License-Identifier: AGPL-3.0-only
//
// Voice profile label client.

import { api } from "./api";

export type VoiceLabelAxis =
  | "humor"
  | "formality"
  | "optimism"
  | "directness"
  | "warmth";

export const VOICE_LABEL_AXES: VoiceLabelAxis[] = [
  "humor",
  "formality",
  "optimism",
  "directness",
  "warmth",
];

export interface VoiceLabelInput {
  sample_text: string;
  axis: VoiceLabelAxis;
  value: number;
  sample_id?: string;
  notes?: string;
}

export interface VoiceLabel {
  id: string;
  tenant_id: string;
  sample_id?: string;
  sample_text: string;
  axis: VoiceLabelAxis;
  value: number;
  labeled_by_user_id?: string;
  notes?: string;
  created_at: string;
}

export interface VoiceLabelListResponse {
  items: VoiceLabel[];
  total: number;
  page: number;
  size: number;
}

export interface VoiceLabelCreateResponse {
  id: string;
}

export interface VoiceLabelListQuery {
  axis?: VoiceLabelAxis;
  page?: number;
  size?: number;
}

export const voiceLabelsApi = {
  create: (input: VoiceLabelInput): Promise<VoiceLabelCreateResponse> =>
    api.post<VoiceLabelCreateResponse>("/api/v1/voice/labels", input),

  list: (query: VoiceLabelListQuery = {}): Promise<VoiceLabelListResponse> =>
    api.get<VoiceLabelListResponse>("/api/v1/voice/labels", {
      query: {
        axis: query.axis,
        page: query.page,
        size: query.size,
      },
    }),

  delete: (id: string): Promise<void> =>
    api.delete<void>(`/api/v1/voice/labels/${encodeURIComponent(id)}`),

  export: (): Promise<VoiceLabel[]> =>
    api.get<VoiceLabel[]>("/api/v1/voice/labels/export.json"),
};
