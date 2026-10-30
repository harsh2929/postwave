// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import type { MeResponse } from "@/lib/auth-api";
import {
  CAMPAIGN_BULK_TAG_MAX_IDS,
  type CampaignBulkTagResult,
  bulkTagCampaigns,
  campaignOrgTagProblem,
  normalizeCampaignOrgTag,
} from "@/lib/campaign-folders-api";
import type { Campaign } from "@/lib/campaigns-api";

import { useCampaignWriteGate } from "./use-campaign-write-gate";

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Apply one ORGANIZATION tag to every selected campaign — desktop parity
 * campaigns-11 (CampaignActionOverlays.tsx `CampaignBulkTagModal`).
 *
 * Organization tags group campaigns in the list; they are not the subscriber
 * tags a campaign targets, and the copy says so. The server applies the tag in
 * one transaction (all or nothing) and reports how many rows it inserted, so a
 * campaign that already had the tag is reported as such rather than counted.
 */
export function BulkTagDialog({
  identity,
  campaigns,
  open,
  onOpenChange,
  snapshotStale = false,
  onTagged,
}: {
  identity: MeResponse | null | undefined;
  campaigns: readonly Campaign[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshotStale?: boolean;
  onTagged?: (result: CampaignBulkTagResult & { ids: string[] }) => void;
}) {
  const gate = useCampaignWriteGate(identity, snapshotStale);
  const inputId = useId();
  const helpId = useId();
  const reasonId = useId();
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setValue("");
    setTouched(false);
    setProblem(null);
  }, [open]);

  const count = campaigns.length;
  const blocked =
    gate.blockedReason ??
    (count === 0
      ? "Select at least one campaign to tag."
      : count > CAMPAIGN_BULK_TAG_MAX_IDS
        ? `Tag at most ${CAMPAIGN_BULK_TAG_MAX_IDS} campaigns at once — the server refuses larger batches.`
        : null);
  const tagProblem = campaignOrgTagProblem(value);
  const normalized = normalizeCampaignOrgTag(value);

  const submit = async (): Promise<void> => {
    setTouched(true);
    if (busyRef.current || blocked || tagProblem) return;
    busyRef.current = true;
    setBusy(true);
    setProblem(null);
    const ids = campaigns.map((campaign) => campaign.id);
    try {
      await gate.confirmFresh();
      const result = await bulkTagCampaigns(ids, value);
      const already = count - result.tagged;
      toast.success(
        already > 0
          ? `Tagged ${plural(result.tagged, "campaign")} with “${result.tag}”; ${plural(already, "campaign")} already had it.`
          : `Tagged ${plural(result.tagged, "campaign")} with “${result.tag}”.`,
      );
      onTagged?.({ ...result, ids });
      onOpenChange(false);
    } catch (error) {
      setProblem(apiErrorMessage(error, "Could not apply the tag."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const describedBy = [helpId, blocked ? reasonId : null]
    .filter(Boolean)
    .join(" ");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busyRef.current) return;
        onOpenChange(next);
      }}
    >
      <DialogContent closeDisabled={busy}>
        <DialogHeader>
          <DialogTitle>Tag {plural(count, "campaign")}</DialogTitle>
          <DialogDescription>
            Apply one organization tag to every selected campaign. It only
            groups campaigns in this list — it does not change who receives
            them.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Label htmlFor={inputId}>Tag</Label>
          <Input
            id={inputId}
            value={value}
            placeholder="launch"
            maxLength={80}
            disabled={busy || blocked !== null}
            aria-describedby={describedBy}
            aria-invalid={touched && tagProblem ? true : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              if (problem) setProblem(null);
            }}
          />
          <p id={helpId} className="text-xs text-muted-foreground">
            {normalized && !tagProblem
              ? `Saved as “${normalized}”. `
              : "Tags are saved in lowercase. "}
            A campaign that already carries the tag keeps it unchanged.
          </p>
          {touched && tagProblem ? (
            <p className="text-xs text-destructive" role="alert">
              {tagProblem}
            </p>
          ) : null}
          {blocked ? (
            <p id={reasonId} className="text-xs text-muted-foreground">
              {blocked}
            </p>
          ) : null}
          {problem ? <Alert variant="destructive">{problem}</Alert> : null}
          <DialogFooter className="mt-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={blocked !== null || tagProblem !== null}
              loading={busy}
              title={blocked ?? undefined}
            >
              Apply tag
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
