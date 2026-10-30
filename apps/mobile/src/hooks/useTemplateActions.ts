/**
 * hooks/useTemplateActions.ts — the two verbs the templates screen offers, with
 * their confirm, their haptics, their toast, and their hand-off.
 *
 * Split out of app/(tabs)/templates.tsx for the reason SequenceDeleteAction is
 * split out of the sequence screens: the decision of what a verb COSTS belongs
 * next to the verb, not three levels up in a render function that is mostly
 * list plumbing.
 *
 * WHY EXACTLY ONE OF THEM CONFIRMS. `templateCloneConfirm` explains the whole
 * asymmetry: duplicating puts a row in a library you then have to go find, and
 * `DELETE /campaign-templates/{id}` is deliberately not in this app — so it is
 * a one-way door. Starting a campaign creates a draft and then NAVIGATES TO IT,
 * so its result is in front of you and reachable. A confirm on that one would
 * be a speed bump people learn to tap through, which is exactly what makes the
 * other confirm stop working.
 *
 * NEITHER IS QUEUED OFFLINE. See the header of hooks/useCampaignTemplates.ts:
 * neither is registered in lib/offlineMutationContract, so an offline tap must
 * be refused at the button rather than replayed hours later unattended.
 */
import { useCallback } from "react";
import { router } from "expo-router";
import { EVENTS } from "@postwave/telemetry";

import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import {
  useCloneTemplate,
  useStartCampaignFromTemplate,
} from "@/hooks/useCampaignTemplates";
import { haptics } from "@/lib/haptics";
import { track } from "@/lib/telemetry";
import type { MobileTemplate } from "@/lib/templateCatalog";
import {
  templateActionErrorMessage,
  templateCloneConfirm,
} from "@/lib/templatePolicy";

export interface TemplateActions {
  startCampaign: (template: MobileTemplate) => Promise<void>;
  duplicate: (template: MobileTemplate) => Promise<void>;
  starting: boolean;
  duplicating: boolean;
  /**
   * The id of the template a verb is running against, or null. Read from the
   * mutation that is ACTUALLY pending: TanStack keeps `variables` after a
   * mutation settles, so consulting the wrong one dims a row that finished
   * minutes ago while the row genuinely working looks idle.
   */
  busyId: string | null;
}

export function useTemplateActions(
  onSettled: () => void,
): TemplateActions {
  const confirm = useConfirm();
  const { toast } = useToast();
  const start = useStartCampaignFromTemplate();
  const clone = useCloneTemplate();

  const startCampaign = useCallback(
    async (template: MobileTemplate): Promise<void> => {
      if (start.isPending || clone.isPending) return;
      haptics.impact();
      try {
        const created = await start.mutateAsync(template.id);
        haptics.success();
        track(EVENTS.CAMPAIGN_CREATED, { source: "mobile_template" });
        onSettled();
        toast({
          kind: "success",
          message: `Draft created from ${template.name}.`,
        });
        if (created?.id) {
          router.push({
            pathname: "/(tabs)/campaigns/[id]",
            params: { id: created.id },
          });
        }
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: templateActionErrorMessage(
            error,
            "Couldn't create the draft.",
          ),
        });
      }
    },
    [start, clone.isPending, toast, onSettled],
  );

  const duplicate = useCallback(
    async (template: MobileTemplate): Promise<void> => {
      if (start.isPending || clone.isPending) return;
      if (!(await confirm(templateCloneConfirm(template)))) return;
      haptics.impact();
      try {
        const copy = await clone.mutateAsync(template.id);
        haptics.success();
        onSettled();
        toast({
          kind: "success",
          message: copy?.name
            ? `Saved “${copy.name}” to your templates.`
            : "Copy saved to your templates.",
        });
      } catch (error) {
        haptics.error();
        toast({
          kind: "error",
          message: templateActionErrorMessage(
            error,
            "Couldn't duplicate that design.",
          ),
        });
      }
    },
    [clone, start.isPending, confirm, toast, onSettled],
  );

  const busyId = clone.isPending
    ? (clone.variables ?? null)
    : start.isPending
      ? (start.variables ?? null)
      : null;

  return {
    startCampaign,
    duplicate,
    starting: start.isPending,
    duplicating: clone.isPending,
    busyId,
  };
}
