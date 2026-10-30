/**
 * CampaignUtmAdminActions — the three ADMIN verbs of the link-tagging card,
 * extracted from CampaignUtmCard to keep that card inside the source budget.
 *
 * All three routes bind ScopeAdmin (api/campaignUtm.ts spells out the
 * asymmetry), so this whole row renders null below canAdmin — omitted, never
 * disabled:
 *
 *   - "Use default here"        POST /utm-templates/campaign/{id}
 *   - "Make workspace default"  POST /utm-templates (UpsertDefault)
 *   - "Remove workspace default" DELETE /utm-templates/{id} — destructive
 *     (future sends go untagged), so it runs through ConfirmSheet.
 */
import { useConfirm } from "@/components/ConfirmSheet";
import { useToast } from "@/components/Toast";
import { ActionButton } from "@/components/campaigns/CampaignDetailControls";
import {
  useApplyDefaultUtm,
  useDeleteUtmTemplate,
  useSaveDefaultUtm,
} from "@/hooks/useCampaignUtm";
import { campaignErrorMessage } from "@/lib/campaignErrors";
import type { UtmResolution } from "@/lib/campaignUtm";

export function CampaignUtmAdminActions({
  campaignId,
  resolution,
  canAdmin,
}: {
  campaignId: string;
  resolution: UtmResolution;
  canAdmin: boolean;
}) {
  const { toast } = useToast();
  const confirm = useConfirm();
  const applyDefault = useApplyDefaultUtm(campaignId);
  const saveDefault = useSaveDefaultUtm();
  const removeTemplate = useDeleteUtmTemplate();

  if (!canAdmin) return null;

  const fail = (fallbackMessage: string) => (err: unknown) =>
    toast({
      kind: "error",
      message: campaignErrorMessage(err, fallbackMessage),
    });

  return (
    <>
      {/* Offered only when there IS a default to copy and the campaign is
          not already overridden — a button that would be a no-op is worse
          than no button. */}
      {resolution.fallback && !resolution.overridden ? (
        <ActionButton
          label={applyDefault.isPending ? "Applying…" : "Use default here"}
          onPress={() => {
            const fallback = resolution.fallback;
            if (!fallback || applyDefault.isPending) return;
            applyDefault.mutate(fallback, {
              onSuccess: () =>
                toast({
                  kind: "success",
                  message:
                    "This campaign now carries its own copy of the workspace tagging.",
                }),
              onError: fail("Couldn't set this campaign's tagging."),
            });
          }}
          disabled={applyDefault.isPending}
        />
      ) : null}
      {/* Promote is offered when this campaign carries its own override:
          "make what this campaign does the workspace convention" is the one
          authoring act the API supports that a phone can state honestly. */}
      {resolution.overridden && resolution.effective ? (
        <ActionButton
          label={saveDefault.isPending ? "Saving…" : "Make workspace default"}
          onPress={() => {
            const effective = resolution.effective;
            if (!effective || saveDefault.isPending) return;
            saveDefault.mutate(effective, {
              onSuccess: () =>
                toast({
                  kind: "success",
                  message: "These values are now the workspace default tagging.",
                }),
              onError: fail("Couldn't save the workspace default."),
            });
          }}
          disabled={saveDefault.isPending}
        />
      ) : null}
      {resolution.fallback ? (
        <ActionButton
          label={
            removeTemplate.isPending ? "Removing…" : "Remove workspace default"
          }
          danger
          onPress={() => {
            const fallback = resolution.fallback;
            if (!fallback || removeTemplate.isPending) return;
            void (async () => {
              const ok = await confirm({
                title: "Remove the workspace default tagging?",
                message:
                  "Campaigns without their own tagging will send links with NOTHING appended.",
                confirmLabel: "Remove default",
                destructive: true,
              });
              if (!ok) return;
              removeTemplate.mutate(fallback.id, {
                onSuccess: () =>
                  toast({
                    kind: "success",
                    message: "Workspace default tagging removed.",
                  }),
                onError: fail("Couldn't remove the workspace default."),
              });
            })();
          }}
          disabled={removeTemplate.isPending}
        />
      ) : null}
    </>
  );
}
