// SPDX-License-Identifier: AGPL-3.0-only

import { api } from "@/lib/api";

export interface TemplateBlockImpactItem {
  template_id: string;
  template_name: string;
  pinned_version: string;
  template_version: number;
}

export interface TemplateBlockImpact {
  items: TemplateBlockImpactItem[];
  truncated: boolean;
}

export async function getTemplateBlockImpact(blockId: string, signal?: AbortSignal): Promise<TemplateBlockImpact> {
  const result = await api.get<TemplateBlockImpact>(
    `/api/v1/campaign-templates/block-impact/${encodeURIComponent(blockId)}`,
    { signal, requireOnline: true },
  );
  if (!result || !Array.isArray(result.items) || typeof result.truncated !== "boolean") {
    throw new Error("Linked-template impact could not be verified.");
  }
  return result;
}
