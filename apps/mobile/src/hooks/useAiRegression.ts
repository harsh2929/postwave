/**
 * hooks/useAiRegression.ts — the latest AI regression run.
 *
 *   GET /api/v1/ai-regression/runs/latest   (read:reports)
 *
 * Mounted by ai_regression.MountRoutes (apps/api/main.go:3233); the route list
 * and its scopes are documented verbatim at
 * apps/api/internal/ai_regression/handlers.go:5-15.
 *
 * The endpoint answers 200 with `{"run": null}` when the harness has never
 * executed — NOT a 404 — so a null run is unwrapped as a legitimate empty and
 * `regressionPresentation` renders it as "Never run" rather than as a pass.
 *
 * Mobile is read-only here: TriggerRun and the settings PUT are admin-scoped
 * and change deployment gating for the whole workspace.
 */
import { useQuery } from "@tanstack/react-query";

import { rawRequest } from "@/api/request";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  regressionErrorMessage,
  type LatestRunEnvelope,
  type RegressionRunWire,
} from "@/lib/aiRegression";

export function useLatestRegressionRun() {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["ai-regression-latest", gate.tenantId],
    enabled: gate.enabled && Boolean(gate.tenantId),
    // A harness run is a rare, heavy event; re-asking on every focus is noise.
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<RegressionRunWire | null> => {
      const res = await rawRequest<LatestRunEnvelope>(
        "GET",
        "/api/v1/ai-regression/runs/latest",
      );
      if (res.error) {
        throw new Error(
          regressionErrorMessage(res.error.status, res.error.message),
        );
      }
      return res.data?.run ?? null;
    },
  });
}
