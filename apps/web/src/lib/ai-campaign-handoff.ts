// SPDX-License-Identifier: AGPL-3.0-only
//
// One-shot, memory-only AI → Campaigns handoff. Generated content may contain
// confidential draft material, so it is deliberately never put in a URL,
// localStorage, sessionStorage, analytics event, or query cache.

export type AiCampaignHandoffMode = "draft" | "ab_test";

export interface AiCampaignHandoff {
  mode: AiCampaignHandoffMode;
  name: string;
  subject: string;
  bodyHtml?: string;
  previewText?: string;
  subjectVariants: string[];
  createdAt: number;
}

let pending: AiCampaignHandoff | null = null;
const MAX_AGE_MS = 10 * 60_000;

function bounded(value: string | undefined, maximum: number): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length > maximum) {
    throw new Error("AI campaign handoff content exceeds its safe limit.");
  }
  return normalized;
}

export function setAiCampaignHandoff(input: {
  mode: AiCampaignHandoffMode;
  name?: string;
  subject: string;
  bodyHtml?: string;
  previewText?: string;
  subjectVariants?: string[];
}): void {
  const subject = bounded(input.subject, 998);
  if (!subject) throw new Error("A campaign subject is required.");
  const variants: string[] = [];
  const seen = new Set<string>();
  for (const rawCandidate of [subject, ...(input.subjectVariants ?? [])]) {
    const candidate = bounded(rawCandidate, 998);
    const identity = candidate.toLocaleLowerCase();
    if (!candidate || seen.has(identity)) continue;
    seen.add(identity);
    variants.push(candidate);
    if (variants.length === 8) break;
  }
  if (input.mode === "ab_test" && variants.length < 2) {
    throw new Error(
      "At least two distinct subjects are required for an A/B handoff.",
    );
  }
  pending = {
    mode: input.mode,
    name: bounded(input.name, 500) || subject,
    subject,
    ...(input.bodyHtml === undefined
      ? {}
      : { bodyHtml: bounded(input.bodyHtml, 200_000) }),
    ...(input.previewText === undefined
      ? {}
      : { previewText: bounded(input.previewText, 2_000) }),
    subjectVariants: variants,
    createdAt: Date.now(),
  };
}

export function takeAiCampaignHandoff(): AiCampaignHandoff | null {
  const result = pending;
  pending = null;
  if (!result || Date.now() - result.createdAt > MAX_AGE_MS) return null;
  return {
    ...result,
    subjectVariants: [...result.subjectVariants],
  };
}

export function clearAiCampaignHandoff(): void {
  pending = null;
}
