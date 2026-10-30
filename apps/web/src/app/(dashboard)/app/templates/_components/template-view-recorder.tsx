// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect } from "react";

import { recordCampaignTemplateView } from "@/lib/campaign-templates-api";

/**
 * Records a personal recent-view only after the server detail page has
 * successfully resolved and rendered this verified template id. This secondary
 * signal is deliberately fail-soft: history outages never block the preview.
 */
export function TemplateViewRecorder({ templateId }: { templateId: string }) {
  useEffect(() => {
    const controller = new AbortController();
    // Deferring one task makes development StrictMode's setup→cleanup→setup
    // probe safe: the discarded first pass clears its timer before networking,
    // while the committed pass records exactly once.
    const timer = window.setTimeout(() => {
      void recordCampaignTemplateView(templateId, {
        signal: controller.signal,
      }).catch(() => {
        // Recent history is private convenience state, not a prerequisite for
        // viewing a design. The Recent dialog exposes actionable read errors.
      });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [templateId]);

  return null;
}
