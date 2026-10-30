// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Dynamic content — parity row campaigns-54 (desktop DynamicContentPanel).
 *
 * `{{#if KEY}}A{{else}}B{{/if}}` regions in a campaign body. GET
 * /api/v1/campaigns/{id}/regions parses the PERSISTED body (body_html, else
 * plain_text) into regions; this panel lists them, previews the body with any
 * region collapsed to its true or else branch (locally — no round trip), and
 * appends a region skeleton to the draft.
 *
 * THE OFFSETS BELONG TO THE SAVED BODY. The server reports byte offsets into
 * what it parsed, so branch previews are only computed while the draft equals
 * the saved body; with unsaved edits the panel says "save first" and previews
 * the draft as written rather than splicing stale offsets into it. The saved
 * body is read from the editor's own campaign cache entry (same key), so this
 * costs no extra request, and a save — which invalidates that key — refreshes
 * the regions with it.
 *
 * COLLAPSED BY DEFAULT. Nothing is requested until the author opens it: the
 * editor opens on every campaign and most bodies carry no regions.
 *
 * "Quote a reader reply" is contained exactly as desktop contains it
 * (ReplyQuotePicker): a reply is private correspondence, and receiving it is
 * not consent to republish its text or its sender's address. The button
 * explains that; it loads no reply and inserts nothing.
 */

import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, Plus, Quote } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { EmailPreview } from "@/components/campaigns/email-preview";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api";
import { effectiveAuthRole, whoami, type MeResponse } from "@/lib/auth-api";
import {
  applyRegionPicks,
  getCampaignRegions,
  REGION_SKELETON,
  type RegionBranchPick,
} from "@/lib/campaign-detail-panels-api";
import {
  CAMPAIGN_READ_ONLY_MESSAGE,
  canWriteCampaigns,
} from "@/lib/campaign-write-authority";
import { getCampaign, type Campaign } from "@/lib/campaigns-api";
import { qk, STALE } from "@/lib/query-keys";

type EditorMode = NonNullable<Campaign["editor_mode"]>;
type RegionField = "body_html" | "plain_text";

/** Which draft field "+ Region" appends to, or null when the editor mode has
 *  no body the regions route reads. */
function insertTarget(mode: EditorMode): RegionField | null {
  if (mode === "html") return "body_html";
  if (mode === "plain_text") return "plain_text";
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BRANCHES: readonly { value: RegionBranchPick; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "true", label: "True branch" },
  { value: "false", label: "Else branch" },
];

export function CampaignDynamicContentPanel({
  campaign,
  editorMode,
  identity,
  onInsert,
}: {
  campaign: Campaign;
  editorMode: EditorMode;
  identity?: MeResponse;
  /** Writes the new draft body into the editor's field (unsaved). */
  onInsert: (field: RegionField, nextBody: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const regionId = useId();
  return (
    <section
      className="rounded-md border bg-card p-4"
      data-testid="campaign-dynamic-content"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? (
          <ChevronDown className="h-4 w-4" aria-hidden />
        ) : (
          <ChevronRight className="h-4 w-4" aria-hidden />
        )}
        <GitBranch className="h-4 w-4" aria-hidden />
        <span className="text-base font-semibold">Dynamic content</span>
      </Button>
      <div id={regionId} hidden={!open}>
        {open ? (
          <DynamicContentRegions
            campaign={campaign}
            editorMode={editorMode}
            identity={identity}
            onInsert={onInsert}
          />
        ) : null}
      </div>
    </section>
  );
}

function DynamicContentRegions({
  campaign,
  editorMode,
  identity: identityProp,
  onInsert,
}: {
  campaign: Campaign;
  editorMode: EditorMode;
  identity?: MeResponse;
  onInsert: (field: RegionField, nextBody: string) => void;
}) {
  const campaignId = String(campaign.id ?? "");
  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = identityProp ?? meQuery.data ?? null;
  const identityReady = Boolean(identityProp) || meQuery.isFetched;
  // Same key derivation as campaign-detail-client.tsx: its cached campaign is
  // the saved body, and its save invalidates everything under this key.
  const role = identity
    ? identity.viewer_mode
      ? "viewer"
      : effectiveAuthRole(identity)
    : null;
  const campaignKey = useMemo(
    () => qk.campaign(identity?.tenant_id ?? "anon", role, campaignId),
    [campaignId, identity?.tenant_id, role],
  );
  const savedQuery = useQuery({
    queryKey: campaignKey,
    queryFn: () => getCampaign(campaignId),
    enabled: identityReady && campaignId !== "",
    staleTime: STALE.detail,
  });
  const regionsQuery = useQuery({
    queryKey: [...campaignKey, "regions"],
    queryFn: () => getCampaignRegions(campaignId),
    enabled: identityReady && campaignId !== "",
    staleTime: STALE.detail,
  });
  const [picks, setPicks] = useState<Record<string, RegionBranchPick>>({});
  const [quoteOpen, setQuoteOpen] = useState(false);

  const regions = Array.isArray(regionsQuery.data?.regions)
    ? regionsQuery.data.regions
    : [];
  const parsedField = regionsQuery.data?.source ?? "body_html";
  const draftBody =
    parsedField === "plain_text"
      ? (campaign.plain_text ?? "")
      : (campaign.body_html ?? "");
  const savedBody = savedQuery.data
    ? parsedField === "plain_text"
      ? (savedQuery.data.plain_text ?? "")
      : (savedQuery.data.body_html ?? "")
    : null;
  // Unknown saved body counts as diverged: offsets cannot be trusted unseen.
  const desynced = savedBody === null || savedBody !== draftBody;

  const previewBody =
    regions.length === 0 || desynced
      ? draftBody
      : applyRegionPicks(draftBody, regions, picks);
  const previewHtml =
    parsedField === "plain_text"
      ? `<pre style="white-space:pre-wrap;font:inherit;margin:0">${escapeHtml(previewBody)}</pre>`
      : previewBody;

  const target = insertTarget(editorMode);
  const canWrite = canWriteCampaigns(identity);
  const insertBlockedReason = !canWrite
    ? CAMPAIGN_READ_ONLY_MESSAGE
    : target === null
      ? "Regions are read from the HTML or plain-text body. Switch the editor to HTML or plain text to insert one."
      : null;

  const insertSkeleton = () => {
    if (!target) return;
    const current =
      target === "body_html"
        ? (campaign.body_html ?? "")
        : (campaign.plain_text ?? "");
    onInsert(target, current + REGION_SKELETON);
  };

  return (
    <div className="mt-3 space-y-3">
      <p className="text-sm text-muted-foreground">
        Conditional regions in the body. Subscribers where KEY is truthy see the
        first branch of <code className="font-mono text-xs">{"{{#if KEY}}…{{else}}…{{/if}}"}</code>;
        everyone else sees the else branch. Pick a branch to preview it.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={insertBlockedReason !== null}
          aria-describedby="campaign-region-insert-note"
          onClick={insertSkeleton}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Region
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setQuoteOpen(true)}
        >
          <Quote className="h-4 w-4" aria-hidden />
          Quote a reader reply
        </Button>
      </div>
      <p
        id="campaign-region-insert-note"
        className="text-xs text-muted-foreground"
      >
        {insertBlockedReason ??
          "Appends an {{#if}}…{{else}}…{{/if}} skeleton to the draft body. Save the campaign to keep it."}
      </p>

      {regionsQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t parse regions</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{apiErrorMessage(regionsQuery.error)}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void regionsQuery.refetch()}
            >
              Retry regions
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {regions.length > 0 && desynced ? (
        <p className="text-sm text-muted-foreground" role="status">
          Save the campaign first to preview branches — regions are computed
          against the last saved body, and this draft has changed since.
        </p>
      ) : null}

      {regionsQuery.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          Scanning the saved body for regions…
        </p>
      ) : regions.length === 0 && !regionsQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          No dynamic regions in the saved body yet.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {regions.map((region) => {
            const pick = picks[region.key] ?? "default";
            return (
              <li
                key={`${region.key}-${region.start}`}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span className="break-all font-mono">{region.key}</span>
                    {region.has_else ? (
                      <Badge variant="outline">if / else</Badge>
                    ) : null}
                  </div>
                  {region.children.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      {region.children.length} nested
                    </p>
                  ) : null}
                </div>
                <div
                  role="group"
                  aria-label={`Preview branch for ${region.key}`}
                  className="inline-flex rounded-md border p-0.5"
                >
                  {BRANCHES.map((branch) => {
                    const unavailable =
                      branch.value === "false" && !region.has_else;
                    return (
                      <Button
                        key={branch.value}
                        type="button"
                        size="sm"
                        variant={pick === branch.value ? "secondary" : "ghost"}
                        aria-pressed={pick === branch.value}
                        disabled={desynced}
                        title={
                          unavailable
                            ? "This region has no {{else}} branch: previewing it shows nothing in its place."
                            : undefined
                        }
                        onClick={() =>
                          setPicks((current) => ({
                            ...current,
                            [region.key]: branch.value,
                          }))
                        }
                      >
                        {branch.label}
                      </Button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <EmailPreview
        html={previewHtml}
        emptyLabel="Nothing to preview yet — the body is empty."
      />

      <Dialog open={quoteOpen} onOpenChange={setQuoteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reader quotes require consent</DialogTitle>
            <DialogDescription>
              Private replies cannot be inserted into campaign content from
              this workspace.
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            <AlertTitle>Quotation is unavailable</AlertTitle>
            <AlertDescription>
              A reply is private correspondence; receiving it is not permission
              to republish its text or its sender&apos;s address. Quoting needs a
              consent workflow, least-privilege reply access, masked identity,
              approved attribution, and a publication audit first. No reply
              content or sender address is loaded here.
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button type="button" onClick={() => setQuoteOpen(false)}>
              Understood
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
