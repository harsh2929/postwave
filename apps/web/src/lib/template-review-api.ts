// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export type TemplateReviewKind = "comment" | "approve" | "request_changes";

export interface TemplateReviewEvent {
  id: string;
  template_version: number;
  actor_email: string;
  kind: TemplateReviewKind;
  body: string;
  created_at: string;
}

export async function listTemplateReviewEvents(id: string, version: number, signal?: AbortSignal): Promise<{ items: TemplateReviewEvent[]; truncated: boolean }> {
  const response = await api.get<{ items: TemplateReviewEvent[]; truncated: boolean }>(
    `/api/v1/campaign-templates/${encodeURIComponent(id)}/review-events`,
    { signal, requireOnline: true, query: { version } },
  );
  if (!response || !Array.isArray(response.items) || typeof response.truncated !== "boolean") {
    throw new Error("Template review history could not be verified.");
  }
  return response;
}

export async function addTemplateReviewEvent(input: {
  templateId: string;
  version: number;
  etag: string;
  kind: TemplateReviewKind;
  body: string;
}): Promise<TemplateReviewEvent> {
  if (!/^"[^"\r\n]+"$/.test(input.etag) || !Number.isSafeInteger(input.version) || input.version < 1) {
    throw new Error("A current template version is required for review.");
  }
  return api.post<TemplateReviewEvent>(
    `/api/v1/campaign-templates/${encodeURIComponent(input.templateId)}/review-events`,
    { version: input.version, kind: input.kind, body: input.body },
    { headers: { "If-Match": input.etag }, requireOnline: true, maxAttempts: 1 },
  );
}
