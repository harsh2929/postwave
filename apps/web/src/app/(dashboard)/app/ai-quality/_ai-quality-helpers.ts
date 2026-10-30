// SPDX-License-Identifier: AGPL-3.0-only
//
// Presentation helpers shared by the AI-quality control plane and the
// lazily-loaded run-evidence panel. Kept free of React so either side can
// import them without pulling the other into its chunk.

import type {
  AiRegressionGateResult,
  AiRegressionSurface,
} from "@/lib/ai-regression-api";

export function surfaceLabel(surface: AiRegressionSurface): string {
  return {
    campaign_draft: "Campaign draft",
    subject_line: "Subject line",
    sequence_draft: "Sequence draft",
    campaign_summary: "Campaign summary",
    reply_intent: "Reply intent",
  }[surface];
}

export function gateVariant(
  gate: AiRegressionGateResult | null,
): "success" | "warning" | "destructive" | "outline" {
  if (gate === "pass") return "success";
  if (gate === "fail") return "destructive";
  if (gate === "advisory") return "warning";
  return "outline";
}
