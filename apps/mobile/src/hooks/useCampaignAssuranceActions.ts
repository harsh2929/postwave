/**
 * hooks/useCampaignAssuranceActions.ts — the two Campaign Assurance verbs a phone
 * can legitimately perform.
 *
 * ── WHY THESE TWO AND NOT THE OTHER THREE ──────────────────────────────────
 * `MountWrite` (campaignassuranceapi/handlers.go:120-140, mounted at
 * apps/api/main.go:5019) exposes five writes. Two belong on a phone:
 *
 *   START   POST /assurance-runs — editor, `write:campaigns`. The card's old copy
 *           said "no mounted client API can create the first run without an exact
 *           send plan"; that is false. `content_revision_id` and `send_plan_id`
 *           are both OPTIONAL, and when the plan is omitted the server freezes the
 *           current draft itself through Preparer.PrepareAssuranceSnapshot
 *           (handlers.go:242-263). That Preparer IS wired in the production
 *           composition (apps/api/campaign_assurance_composition.go:159), so the
 *           phone needs neither a frozen revision nor a desktop editor.
 *   CANCEL  POST /assurance-runs/{runID}/cancel — editor, `write:campaigns`.
 *
 * `apply` still stays off the phone because it needs an exact strong campaign ETag
 * and a stored patch. Governed overrides are deliberately supported by the mobile
 * assurance card: the UI requires an owner/admin, an overridable finding, and a
 * reason, while the server re-verifies `write:campaigns`, `send:transactional`,
 * actor role, tenant binding, and policy before appending the receipt.
 *
 * ── WHY THE SDK AND NOT rawRequest ─────────────────────────────────────────
 * Both handlers call `requireIdempotencyKey` and answer 400
 * `idempotency_key_required` without one. The SDK auto-mints a key for
 * non-idempotent methods (packages/sdk-ts/src/client.ts:441-449), so going through
 * the typed client makes the header impossible to forget. `request_id` is a
 * separate concern — it identifies the logical run request rather than the HTTP
 * attempt — so it gets its own stable id from the offline-mutation generator.
 */
import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getClient } from "@/api/client";
import {
  recordCampaignAssuranceOverride,
  type RecordCampaignAssuranceOverrideInput,
} from "@/api/campaignAssuranceOverride";
import {
  assuranceCardControl,
  MOBILE_ASSURANCE_RUN_PROFILE,
} from "@/lib/campaignAssuranceGate";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import { haptics } from "@/lib/haptics";
import { canAccessMinimumRole } from "@/lib/mobileRouteManifest";
import { newOfflineOperationId } from "@/lib/offlineMutations";

/**
 * Invalidate every cached assurance read for this campaign.
 *
 * Matched by predicate rather than by an exact key because
 * `useCampaignAssurance` keys on [tenantId, effectiveRole, campaignId, "latest"] —
 * an exact-key invalidation would silently miss the moment either of the first two
 * changes, and the failure mode is a card that shows a finished run as still
 * queued.
 */
function useAssuranceInvalidation(campaignId: string | undefined) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      predicate: (query) =>
        Array.isArray(query.queryKey) &&
        query.queryKey[0] === "campaign-assurance" &&
        query.queryKey.includes(campaignId),
    });
}

/** Start a run against the campaign's CURRENT content. */
export function useStartAssuranceRun(campaignId: string | undefined) {
  const invalidate = useAssuranceInvalidation(campaignId);
  return useMutation({
    mutationFn: async (): Promise<void> => {
      if (!campaignId) throw new Error("no campaign");
      const { client } = getClient();
      await client.campaignAssurance.createRun(campaignId, {
        profile: MOBILE_ASSURANCE_RUN_PROFILE,
        request_id: newOfflineOperationId(),
      });
    },
    onSuccess: () => void invalidate(),
  });
}

/**
 * Cancel a run.
 *
 * Callers MUST gate the control on `assuranceRunIsCancellable(run.state)`; the
 * server's UPDATE matches only `queued`/`running` (lifecycle.go:383) and answers a
 * conflict otherwise. Re-cancelling an already-cancelled run is a deliberate
 * success on the server (service.go:360-362), so a double tap is safe.
 */
export function useCancelAssuranceRun(campaignId: string | undefined) {
  const invalidate = useAssuranceInvalidation(campaignId);
  return useMutation({
    mutationFn: async (runId: string): Promise<void> => {
      if (!campaignId) throw new Error("no campaign");
      const { client } = getClient();
      await client.campaignAssurance.cancelRun(campaignId, runId);
    },
    onSuccess: () => void invalidate(),
  });
}

/** Append one governed, finding-scoped mobile override receipt. */
export function useOverrideAssuranceFinding(campaignId: string | undefined) {
  const invalidate = useAssuranceInvalidation(campaignId);
  return useMutation({
    mutationFn: async (
      input: Omit<RecordCampaignAssuranceOverrideInput, "campaignId">,
    ): Promise<void> => {
      if (!campaignId) throw new Error("no campaign");
      await recordCampaignAssuranceOverride({ campaignId, ...input });
    },
    onSuccess: () => void invalidate(),
  });
}

/**
 * The card's whole action surface in one call: which control to show, what to do
 * when it is pressed, and whether a request is in flight.
 *
 * This exists because the card was doing all three inline and crossed its
 * complexity ceiling. That ceiling was right: deciding a control, wrapping two
 * mutations in toasts, and rendering a receipt are three jobs, and only the third
 * belongs in a component.
 */
export function useAssuranceRunControls(input: {
  campaignId: string;
  effectiveRole: string | null;
  runId: string | undefined;
  runState: string | undefined;
  hasReceipt: boolean;
  toast: (notice: { kind: "success" | "error"; message: string }) => void;
}) {
  const start = useStartAssuranceRun(input.campaignId);
  const cancel = useCancelAssuranceRun(input.campaignId);
  const control = assuranceCardControl({
    // Both writes are `editor` in the generated policy manifest (reviewed rows),
    // so a viewer sees the receipt and no controls rather than buttons that 403.
    mayWrite: canAccessMinimumRole("editor", input.effectiveRole),
    runState: input.runState,
    hasReceipt: input.hasReceipt,
  });

  const { toast } = input;
  const runId = input.runId;

  const press = useCallback(() => {
    haptics.tap();
    if (control === "cancel") {
      if (!runId) return;
      cancel.mutate(runId, {
        onSuccess: () => toast({ kind: "success", message: "Run cancelled." }),
        onError: (err) =>
          toast({
            kind: "error",
            message: campaignErrorMessage(err, "Couldn't cancel the run."),
          }),
      });
      return;
    }
    start.mutate(undefined, {
      onSuccess: () =>
        toast({ kind: "success", message: "Campaign Assurance started." }),
      onError: (err) =>
        toast({
          kind: "error",
          message: campaignErrorMessage(
            err,
            "Couldn't start Campaign Assurance.",
          ),
        }),
    });
  }, [cancel, control, runId, start, toast]);

  return {
    control,
    press,
    pending: start.isPending || cancel.isPending,
  } as const;
}
