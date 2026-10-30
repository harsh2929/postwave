// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { Button } from "@/components/ui/button";
import {
  CAMPAIGN_SCHEDULING_RELEASE_HOLD,
  type Campaign,
  type CampaignStatus,
} from "@/lib/campaigns-api";

/**
 * Why Send is refused for a status that has already left the draft state. The
 * status badge lives back in the table row, so without this the panel shows a
 * dead button and no reason — worst for `failed`, where retrying the send is
 * the operator's obvious next move.
 */
function sendRefusedReason(status: CampaignStatus): string | null {
  switch (status) {
    case "sending":
      return "This campaign is already sending, so it cannot be sent again.";
    case "sent":
      return "This campaign has already been sent. Duplicate it from its row to send another copy.";
    case "cancelled":
      return "This campaign was cancelled and cannot be sent. Duplicate it from its row to send a fresh copy.";
    case "failed":
      return "This send failed and cannot be retried from here. Duplicate the campaign from its row and send the copy.";
    default:
      return null;
  }
}

export function SelectedCampaignActions({
  canWrite,
  campaign,
  onSend,
  readOnlyMessage,
}: {
  canWrite: boolean;
  campaign: Campaign;
  onSend: () => void;
  readOnlyMessage: string;
}) {
  const refusedReason = sendRefusedReason(campaign.status);
  const terminal = refusedReason !== null;

  return (
    <div className="rounded-md border bg-muted/20 p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Selected
          </div>
          <div className="break-words font-medium">{campaign.name}</div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex">
          <Button
            type="button"
            variant="outline"
            disabled
            title={CAMPAIGN_SCHEDULING_RELEASE_HOLD}
          >
            Scheduling unavailable
          </Button>
          <Button
            type="button"
            disabled={!canWrite || terminal}
            title={!canWrite ? readOnlyMessage : (refusedReason ?? undefined)}
            onClick={onSend}
          >
            Send
          </Button>
        </div>
      </div>
      {refusedReason ? (
        <p className="mt-3 text-sm text-muted-foreground">{refusedReason}</p>
      ) : null}
    </div>
  );
}
