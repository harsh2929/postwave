/**
 * hooks/useAiRegressionAdmin.ts — settings, trigger, golden example.
 *
 * Every route here is `admin`, so the settings READ is gated on the caller
 * already knowing it is an admin: firing it for a viewer would guarantee a 403
 * and make the card look broken. The caller passes `enabled`.
 *
 * A successful trigger invalidates the latest-run badge, because the whole
 * point of pressing it is that the badge should now say "Queued".
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  captureGoldenExample,
  fetchRegressionSettings,
  putRegressionSettings,
  triggerRegressionRun,
} from "@/api/aiRegressionAdmin";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import {
  parseRegressionSettings,
  regressionAdminErrorMessage,
  regressionTriggerFailure,
  type GoldenExampleBody,
  type RegressionSettingsView,
} from "@/lib/aiRegressionAdmin";

export function useRegressionSettings(enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["ai-regression-settings", gate.tenantId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<RegressionSettingsView> => {
      const res = await fetchRegressionSettings();
      if (res.error) {
        throw new Error(
          regressionAdminErrorMessage(res.error.status, res.error.message),
        );
      }
      return parseRegressionSettings(res.data);
    },
  });
}

export function useSaveRegressionSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      warn_threshold: number;
      hard_gate_enabled: boolean;
      hard_gate_threshold: number;
      min_examples_for_gate: number;
    }): Promise<RegressionSettingsView> => {
      const res = await putRegressionSettings(body);
      if (res.error) {
        throw new Error(
          regressionAdminErrorMessage(res.error.status, res.error.message),
        );
      }
      return parseRegressionSettings(res.data);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ai-regression-settings"] });
    },
  });
}

export function useTriggerRegressionRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: { model_version_tag: string }): Promise<void> => {
      const res = await triggerRegressionRun(body);
      if (res.error) {
        // The server's own sentence, verbatim, for each documented refusal.
        const failure = regressionTriggerFailure(
          res.error.status,
          res.error.code,
          res.error.message,
        );
        throw new Error(failure.message);
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["ai-regression-latest"] });
      void qc.invalidateQueries({ queryKey: ["ai-regression-runs"] });
    },
  });
}

export function useCaptureGoldenExample() {
  return useMutation({
    mutationFn: async (body: GoldenExampleBody): Promise<void> => {
      const res = await captureGoldenExample(body);
      if (res.error) {
        throw new Error(
          regressionAdminErrorMessage(res.error.status, res.error.message),
        );
      }
    },
  });
}
