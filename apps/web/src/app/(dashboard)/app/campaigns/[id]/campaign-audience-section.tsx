// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ExternalLink, Lock, Snowflake, Users } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api";
import type { AudienceList } from "@/lib/audience-admin-api";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { freezeCampaignAudience } from "@/lib/campaign-audience-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
  confirmFreshCampaignWriteAuthority,
} from "@/lib/campaign-write-authority";
import type { AudienceCountResult } from "@/lib/campaigns-api";
import { qk, STALE } from "@/lib/query-keys";
import type { Segment } from "@/lib/segments-api";
import { asRoute } from "@/lib/typed-routes";

/**
 * Who a campaign sends to, as the PATCH body carries it: one list, one
 * segment, or neither (every eligible contact in the workspace). Both halves
 * are always present, with "" for "none" — the server reads a missing key as
 * "leave unchanged", so an absent half could never clear anything.
 */
export interface CampaignAudienceChoice {
  list_id: string;
  segment_id: string;
}

type AudienceKind = "workspace" | "list" | "segment";

function kindOf(audience: CampaignAudienceChoice): AudienceKind {
  if (audience.list_id) return "list";
  if (audience.segment_id) return "segment";
  return "workspace";
}

const EVERYONE = "";
const LIST_PREFIX = "list:";
const SEGMENT_PREFIX = "segment:";

/** The picker's single value for an audience. */
export function audienceOptionValue(audience: CampaignAudienceChoice): string {
  if (audience.list_id) return `${LIST_PREFIX}${audience.list_id}`;
  if (audience.segment_id) return `${SEGMENT_PREFIX}${audience.segment_id}`;
  return EVERYONE;
}

/** The PATCH-shaped audience a picker value stands for. */
export function audienceFromOptionValue(value: string): CampaignAudienceChoice {
  if (value.startsWith(LIST_PREFIX)) {
    return { list_id: value.slice(LIST_PREFIX.length), segment_id: "" };
  }
  if (value.startsWith(SEGMENT_PREFIX)) {
    return { list_id: "", segment_id: value.slice(SEGMENT_PREFIX.length) };
  }
  return { list_id: "", segment_id: "" };
}

/**
 * The lists a campaign can send to.
 *
 * A campaign sends to a list's members as this workspace records them, so a
 * list needs a workspace identity: the catalogue marks those rows with
 * `postwave_uuid`. Any other row is a list this workspace does not own — the
 * engine's install-time defaults, one made in the engine's own admin, or,
 * while the catalogue is not scoped to the workspace, another workspace's
 * list. Those are left out entirely rather than shown disabled, because a
 * disabled option still prints a name that is not this workspace's to see.
 * A catalogue that reports no identities therefore offers no lists: the
 * server refuses every list it cannot resolve to one of this workspace's.
 */
export function campaignAudienceLists(
  lists: readonly AudienceList[],
): AudienceList[] {
  return lists.filter((list) => Boolean(list.postwave_uuid));
}

function recipients(n: number): string {
  return `${n.toLocaleString()} recipient${n === 1 ? "" : "s"}`;
}

export function campaignAudienceStatusText({
  audience,
  audienceCount,
  countError,
  frozen,
  loading,
}: {
  audience: CampaignAudienceChoice;
  audienceCount: AudienceCountResult | null;
  countError: string | null;
  frozen: boolean;
  loading: boolean;
}): string {
  if (frozen) {
    return "This campaign sends to the audience snapshot taken when it was frozen.";
  }
  const kind = kindOf(audience);
  if (kind === "workspace") {
    return "Sends to every contact in this workspace who is subscribed and can receive email. The send review shows the exact count.";
  }
  if (loading) return "Counting recipients…";
  if (countError) return countError;
  if (audienceCount) {
    return `${recipients(audienceCount.deliverable)} will receive this.`;
  }
  return `Recipient count unavailable for this ${kind}.`;
}

/**
 * Freeze audience now — parity row campaigns-26.
 *
 * A dynamic audience is re-evaluated when the campaign sends. Freezing
 * evaluates the segment ONCE, snapshots the membership, and flips the campaign
 * to a static audience: from then on the send goes to the snapshot. Someone who
 * joins the segment afterwards is not mailed; someone who leaves it still is.
 *
 * IT IS ONE-WAY FOR THIS CAMPAIGN. The editor offers no unfreeze, and the
 * server refuses to re-point a frozen campaign's list or segment, so the
 * confirm has to carry the whole consequence rather than the verb's name.
 *
 * IT SNAPSHOTS THE SAVED SEGMENT, not the one in the picker above. The server
 * reads `campaigns.segment_id`, so an unsaved pick is not what gets frozen —
 * said out loud beside the button, because the two are on the same screen and
 * look like one thing.
 *
 * Self-reads its campaign id and identity: the detail page composes this
 * section without passing either, and a freeze must be gated on the caller's
 * real write authority rather than on whatever the parent last rendered.
 */
function CampaignAudienceFreeze({
  audience,
  frozen,
}: {
  audience: CampaignAudienceChoice;
  frozen: boolean;
}) {
  const params = useParams<{ id: string }>();
  const campaignId = params?.id ?? "";
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [frozenMembers, setFrozenMembers] = useState<number | null>(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data ?? null;
  const canWrite = canWriteCampaigns(identity);
  const tenantId = identity?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;

  const freezeMutation = useMutation({
    mutationFn: async () => {
      await confirmFreshCampaignWriteAuthority(identity);
      return freezeCampaignAudience(campaignId);
    },
    onSuccess: (result) => {
      setConfirmOpen(false);
      setFrozenMembers(result.frozen_members);
      // The campaign row now carries audience_mode=static and a freeze id.
      void queryClient.invalidateQueries({
        queryKey: qk.campaign(tenantId, role, campaignId),
      });
      toast.success(
        `Audience frozen — ${recipients(result.frozen_members)} captured for this campaign.`,
      );
    },
    onError: (error: unknown) => {
      // 422 freeze_requires_segment / segment_not_found and 409 edit_lease_held
      // each arrive with the server's own sentence; render it, don't restate it.
      toast.error(apiErrorMessage(error, "The audience could not be frozen."));
    },
  });

  const kind = kindOf(audience);
  const blockedReason = !campaignId
    ? "This campaign has no id yet, so its audience cannot be frozen."
    : meQuery.isPending
      ? "Checking your access…"
      : !canWrite
        ? CAMPAIGN_READ_ONLY_MESSAGE
        : frozen
          ? "This audience is already frozen."
          : kind === "workspace"
            ? "Freezing needs a segment: a whole-audience campaign has no membership to snapshot."
            : kind === "list"
              ? "Freezing needs a segment: a list audience always sends to the list's current members."
              : freezeMutation.isPending
                ? "The audience is already being frozen."
                : null;

  return (
    <div className="mt-1 border-t pt-3" data-testid="campaign-audience-freeze">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={blockedReason !== null}
          aria-describedby="campaign-audience-freeze-note"
          onClick={() => setConfirmOpen(true)}
        >
          <Snowflake className="h-4 w-4" aria-hidden />
          {freezeMutation.isPending ? "Freezing…" : "Freeze audience now"}
        </Button>
        {frozenMembers !== null ? (
          <span className="text-xs text-muted-foreground" role="status">
            Audience frozen at {recipients(frozenMembers)}. This campaign now
            sends to that snapshot.
          </span>
        ) : null}
      </div>
      <p
        id="campaign-audience-freeze-note"
        className="mt-2 text-xs text-muted-foreground"
      >
        {blockedReason ??
          "Snapshots the SAVED segment's members. Save the campaign first if you just changed the picker above."}
      </p>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!freezeMutation.isPending) setConfirmOpen(open);
        }}
        title="Freeze this campaign's audience?"
        description="The segment is evaluated once and the result becomes this campaign's permanent recipient list. Subscribers who join the segment afterwards will NOT be mailed, and subscribers who leave it still will. There is no unfreeze — the only way back is a new campaign."
        confirmLabel="Freeze audience"
        cancelLabel="Keep it dynamic"
        onConfirm={async () => {
          await freezeMutation.mutateAsync();
        }}
      />
    </div>
  );
}

export function CampaignAudienceSection({
  audience,
  audienceCount,
  audienceCountError,
  audienceCountLoading,
  frozen,
  lists,
  listsError,
  listsLoading,
  onAudienceChange,
  onRetryLists,
  onRetrySegments,
  segments,
  segmentsError,
  segmentsLoading,
}: {
  audience: CampaignAudienceChoice;
  audienceCount: AudienceCountResult | null;
  /** Why the current list or segment could not be counted, in the server's words. */
  audienceCountError: string | null;
  audienceCountLoading: boolean;
  /** The campaign's audience is a frozen snapshot and cannot be re-pointed. */
  frozen: boolean;
  lists: readonly AudienceList[];
  listsError: boolean;
  listsLoading: boolean;
  onAudienceChange: (audience: CampaignAudienceChoice) => void;
  onRetryLists: () => void;
  onRetrySegments: () => void;
  segments: Segment[];
  segmentsError: boolean;
  segmentsLoading: boolean;
}) {
  const kind = kindOf(audience);
  const value = audienceOptionValue(audience);
  const listOptions = campaignAudienceLists(lists);
  const knownList = listOptions.some(
    (list) => String(list.id) === audience.list_id,
  );
  const knownSegment = segments.some(
    (segment) => segment.id === audience.segment_id,
  );
  // Only a catalogue that loaded can say there is nothing in it; one still
  // loading or one that failed says nothing about the workspace.
  const noLists = !listsLoading && !listsError && listOptions.length === 0;
  const noSegments =
    !segmentsLoading && !segmentsError && segments.length === 0;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <Users className="h-4 w-4" aria-hidden />
        <h2 className="text-base font-semibold">Audience</h2>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="campaign-audience">Send to</Label>
        <Select
          id="campaign-audience"
          value={value}
          disabled={frozen}
          aria-describedby="campaign-audience-status"
          onChange={(event) =>
            onAudienceChange(audienceFromOptionValue(event.target.value))
          }
        >
          <option value={EVERYONE}>
            Everyone eligible (no list or segment)
          </option>
          {kind === "list" && !knownList ? (
            // The campaign's list is not in the catalogue (it failed to load,
            // or the list is gone). Keep it selectable so the picker reflects
            // what is saved instead of silently showing another choice.
            <option value={value}>
              {listsLoading ? "Loading lists…" : "The campaign's current list"}
            </option>
          ) : null}
          {kind === "segment" && !knownSegment ? (
            <option value={value}>
              {segmentsLoading
                ? "Loading segments…"
                : "The campaign's current segment"}
            </option>
          ) : null}
          {listOptions.length > 0 ? (
            <optgroup label="Lists">
              {listOptions.map((list) => (
                <option
                  key={`list-${list.id}`}
                  value={`${LIST_PREFIX}${list.id}`}
                >
                  {list.name}
                </option>
              ))}
            </optgroup>
          ) : null}
          {segments.length > 0 ? (
            <optgroup label="Segments">
              {segments.map((segment) => (
                <option
                  key={`segment-${segment.id}`}
                  value={`${SEGMENT_PREFIX}${segment.id}`}
                >
                  {segment.name}
                  {typeof segment.lastCount === "number"
                    ? ` (${segment.lastCount.toLocaleString()})`
                    : ""}
                </option>
              ))}
            </optgroup>
          ) : null}
        </Select>
        <p
          id="campaign-audience-status"
          className="text-sm text-muted-foreground"
          aria-live="polite"
        >
          {campaignAudienceStatusText({
            audience,
            audienceCount,
            countError: audienceCountError,
            frozen,
            loading: audienceCountLoading,
          })}
        </p>
        {frozen ? (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Its list or segment can&apos;t change. Duplicate the campaign to
            send to a different audience.
          </p>
        ) : null}
        {listsError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-xs text-destructive"
          >
            <span>
              Lists couldn&apos;t be loaded, so none are offered above.
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetryLists}
            >
              Retry lists
            </Button>
          </div>
        ) : null}
        {segmentsError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-xs text-destructive"
          >
            <span>
              Segments couldn&apos;t be loaded, so none are offered above.
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetrySegments}
            >
              Retry segments
            </Button>
          </div>
        ) : null}
        {/* Deep links: a segment's page holds its definition and resolved
            members (CAMP-047); a list's page holds its members. */}
        {kind === "segment" ? (
          <div className="flex flex-wrap gap-3 text-xs">
            <Link
              href={asRoute(`/app/subscribers/segments/${audience.segment_id}`)}
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              View segment definition
            </Link>
            <Link
              href={asRoute(
                `/app/subscribers/segments/${audience.segment_id}#members`,
              )}
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              <Users className="h-3.5 w-3.5" aria-hidden />
              View recipients
            </Link>
          </div>
        ) : null}
        {kind === "list" ? (
          <div className="flex flex-wrap gap-3 text-xs">
            <Link
              href={asRoute(`/app/lists/${audience.list_id}`)}
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              View list and members
            </Link>
          </div>
        ) : null}
        {noLists && noSegments ? (
          <p className="text-xs text-muted-foreground">
            No lists or segments yet. Create a list or a segment to send to part
            of your audience.
          </p>
        ) : noLists ? (
          <p className="text-xs text-muted-foreground">
            No lists to choose from yet. Lists you create in this workspace can
            be used as audiences.
          </p>
        ) : null}
        <CampaignAudienceFreeze audience={audience} frozen={frozen} />
      </div>
    </section>
  );
}
