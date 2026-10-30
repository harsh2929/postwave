/**
 * hooks/useCampaignDraftCheckpoint.ts — ECO-03 wired to the one surface on
 * this app that holds an in-progress campaign draft.
 *
 * That surface is CampaignSubjectModal: a sheet over the campaign detail
 * screen holding subject, preview text, from-name and reply-to until the
 * person taps Save. Everything else about a campaign is read-only here.
 *
 * Two things have to be reconciled and this hook is where they meet:
 *
 *   THE DRAFT lives in the sheet, which is only mounted-and-visible while the
 *   person is editing. THE OFFER has to be visible on the detail screen,
 *   because arriving from a laptop you land there and would never think to
 *   open a sheet to find out that a draft exists. So the checkpoint state
 *   lives at the route, the sheet reports its draft up, and "Resume" seeds the
 *   sheet and opens it.
 *
 *   THE CHECKPOINT IS SHARED with a surface that can edit more than this one.
 *   Every write merges over what the server holds and the auto-delete is
 *   vetoed for anything this surface could not have written — see
 *   lib/campaignCheckpoint for why that asymmetry is not optional.
 */
import { useCallback, useMemo, useRef, useState } from "react";

import {
  useEditorCheckpoint,
  type EditorCheckpointState,
} from "@/hooks/useEditorCheckpoint";
import {
  checkpointFieldsFromDraft,
  campaignDraftFromCheckpoint,
  isMobileOwnedCheckpoint,
  mergeCampaignCheckpoint,
  type CampaignCheckpointContent,
} from "@/lib/campaignCheckpoint";
import {
  campaignFieldsFrom,
  type CampaignFieldsDraft,
  type CampaignFieldsSource,
} from "@/lib/campaignFields";

export interface CampaignDraftCheckpoint {
  state: EditorCheckpointState<CampaignCheckpointContent>;
  /**
   * The draft to open the edit sheet with, or undefined to start from the
   * saved record. Set only by Resume — a checkpoint is never applied without
   * being asked for.
   */
  seed: CampaignFieldsDraft | undefined;
  /**
   * Called by the sheet with its draft while it holds unsaved changes, and
   * with null the moment it does not (closed, saved, or edited back to the
   * saved values). Null is what eventually removes the checkpoint.
   */
  onDraftChange: (draft: CampaignFieldsDraft | null) => void;
  /** Drop the resume seed when the sheet closes, so the next open is clean. */
  clearSeed: () => void;
}

export function useCampaignDraftCheckpoint({
  campaign,
  campaignId,
  canEdit,
  onOpenEditor,
}: {
  /** The saved record. Undefined until it loads. */
  campaign: (CampaignFieldsSource & { updated_at?: string }) | undefined;
  campaignId: string | undefined;
  /** State AND permission: a viewer, or a sent campaign, never writes. */
  canEdit: boolean;
  /** Bring the edit sheet up — Resume has nowhere to put the draft otherwise. */
  onOpenEditor: () => void;
}): CampaignDraftCheckpoint {
  const [draft, setDraft] = useState<CampaignFieldsDraft | null>(null);
  const [seed, setSeed] = useState<CampaignFieldsDraft | undefined>(undefined);

  // The saved record's values, used to fill any field a restored checkpoint
  // does not carry. Held in a ref as well so `onRestore` — called from a
  // button deep inside the banner — reads the current record without becoming
  // a new callback on every refetch.
  const record = useMemo(() => campaignFieldsFrom(campaign), [campaign]);
  const recordRef = useRef(record);
  recordRef.current = record;

  const content = useMemo<CampaignCheckpointContent | null>(
    () => (draft ? checkpointFieldsFromDraft(draft) : null),
    [draft],
  );

  const onRestore = useCallback(
    (restored: CampaignCheckpointContent) => {
      // Applied to the sheet only, and it opens dirty: restoring is not
      // saving. The person still decides whether this becomes the record.
      setSeed(campaignDraftFromCheckpoint(restored, recordRef.current));
      onOpenEditor();
    },
    [onOpenEditor],
  );

  const state = useEditorCheckpoint<CampaignCheckpointContent>({
    entityKey: "campaign",
    entityId: campaignId,
    content,
    // The SAVED record's timestamp, not the local draft's — a checkpoint is
    // only worth offering when it holds work the record does not.
    recordUpdatedAt: campaign?.updated_at,
    canEdit,
    onRestore,
    mergeWithHeld: mergeCampaignCheckpoint,
    canDiscardHeld: isMobileOwnedCheckpoint,
  });

  const clearSeed = useCallback(() => setSeed(undefined), []);

  return { state, seed, onDraftChange: setDraft, clearSeed };
}
