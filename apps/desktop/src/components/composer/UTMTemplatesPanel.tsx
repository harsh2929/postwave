import type { ReactElement } from "react";

import { ConfirmModal } from "../ConfirmModal";
import { UTMTemplatesView } from "./UTMTemplatesView";
import { useUTMTemplatesController } from "./useUTMTemplatesController";

interface UTMTemplatesPanelProps {
  campaignId: string | number;
  canAdmin: boolean;
  canMutate: boolean;
  onClose: () => void;
  open: boolean;
}

export function UTMTemplatesPanel({
  open,
  onClose,
  campaignId,
  canMutate,
  canAdmin,
}: UTMTemplatesPanelProps): ReactElement {
  const controller = useUTMTemplatesController({
    campaignId,
    canAdmin,
    canMutate,
    open,
  });
  const deleting = controller.mutation === "delete";
  const requestClose = (): void => {
    if (controller.requestClose()) onClose();
  };
  return (
    <>
      <UTMTemplatesView
        campaignId={campaignId}
        controller={controller}
        onClose={requestClose}
        open={open}
      />
      <ConfirmModal
        open={controller.deleteTarget !== null}
        title="Delete UTM template?"
        description={
          controller.deleteTarget?.is_default
            ? "Campaign links will go out untagged unless a per-campaign template applies."
            : "This campaign falls back to the tenant default template (if any)."
        }
        confirmLabel={deleting ? "Deleting…" : "Delete template"}
        danger
        busy={deleting}
        onConfirm={() => void controller.deleteTemplate()}
        onClose={controller.closeDelete}
      />
      <ConfirmModal
        open={controller.discardConfirmOpen}
        title="Discard UTM template changes?"
        description="The edited template fields and preview URL have not been applied."
        confirmLabel="Discard changes"
        danger
        onConfirm={() => {
          controller.discardDraft();
          onClose();
        }}
        onClose={controller.keepEditing}
      />
    </>
  );
}
