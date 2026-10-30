/**
 * CampaignBulkLayer — the selection bar and the three sheets it opens.
 *
 * Kept out of app/(tabs)/campaigns/index.tsx so that screen stays a readable state
 * ladder (gate → filter → list → empty) rather than acquiring a second screen
 * inside itself. Everything here is driven by one controller
 * (hooks/useCampaignSelection); this file only decides what is on screen.
 */
import {
  CampaignBulkTagSheet,
  CampaignFolderPickerSheet,
} from "@/components/campaigns/CampaignBulkSheets";
import { CampaignCompareSheet } from "@/components/campaigns/CampaignCompareSheet";
import { CampaignSelectionBar } from "@/components/campaigns/CampaignSelectionBar";
import type { CampaignSelectionController } from "@/hooks/useCampaignSelection";

export function CampaignBulkLayer({
  selection,
}: {
  selection: CampaignSelectionController;
}) {
  if (!selection.active) return null;
  return (
    <>
      <CampaignSelectionBar
        count={selection.selected.length}
        verbs={selection.verbs}
        onDone={selection.exit}
        busyLabel={selection.busyLabel}
      />

      <CampaignBulkTagSheet
        visible={selection.sheet === "tag"}
        onClose={selection.closeSheet}
        count={selection.selected.length}
        onApply={selection.applyTag}
        pending={selection.pending}
      />

      <CampaignFolderPickerSheet
        visible={selection.sheet === "folder"}
        onClose={selection.closeSheet}
        count={selection.selected.length}
        folders={Array.isArray(selection.folders.data) ? selection.folders.data : []}
        foldersLoading={selection.folders.isLoading}
        foldersFailed={selection.folders.isError}
        onPick={selection.applyFolder}
        onCreate={selection.applyNewFolder}
        pending={selection.pending}
      />

      <CampaignCompareSheet
        visible={selection.sheet === "compare"}
        onClose={selection.closeSheet}
        rows={Array.isArray(selection.compare.data) ? selection.compare.data : []}
        loading={selection.compare.isLoading}
        error={selection.compare.error}
        onRetry={() => void selection.compare.refetch()}
        nameFor={selection.nameFor}
      />
    </>
  );
}
