// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Content remix — parity row campaigns-51 (desktop
 * composer/ContentRemixCard).
 *
 * POST /api/v1/campaigns/{id}/remix derives cross-channel assets (web teaser,
 * SMS, social post, podcast outline) from the SAVED campaign body and returns
 * them synchronously. The handler that answers is internal/content_remix — the
 * async archive_content_remix package declares the same path but is not
 * mounted (see lib/campaign-detail-panels-api.ts). The renderer is template-
 * derived, not a model, and the card says so.
 *
 * GATE: the route requires write:campaigns AND the admin scope, which on the
 * session path means owner/admin. Desktop shows the button to editors, who
 * would be refused; here an editor sees why instead.
 *
 * Nothing is persisted: the result lives in this card until the page closes,
 * which is why every asset carries its own Copy.
 */

import { useId, useState } from "react";
import { Copy, Shuffle } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiErrorMessage } from "@/lib/api";
import {
  remixCampaign,
  REMIX_CHANNELS,
  type RemixChannel,
  type RemixResult,
} from "@/lib/campaign-detail-panels-api";
import {
  canAdminCampaigns,
  confirmFreshCampaignAdminAuthority,
} from "@/lib/campaign-write-authority";
import { copyToClipboard } from "@/lib/clipboard";
import { formatWireTimestamp } from "@/lib/go-zero-time";

import { PANEL_CLASS, type CampaignPanelScope } from "./campaign-panel-scope";

export const REMIX_ADMIN_ONLY_MESSAGE =
  "Content remix is limited to owners and admins: the server requires the admin scope on top of campaign write access.";

function channelLabel(channel: string): string {
  return REMIX_CHANNELS.find((entry) => entry.id === channel)?.label ?? channel;
}

export function CampaignRemixCard({ scope }: { scope: CampaignPanelScope }) {
  const { campaignId, identity, identityReady } = scope;
  const toneId = useId();
  const [selected, setSelected] = useState<RemixChannel[]>(
    REMIX_CHANNELS.map((channel) => channel.id),
  );
  const [tone, setTone] = useState("");
  const [result, setResult] = useState<RemixResult | null>(null);

  const canRemix = canAdminCampaigns(identity);

  const remix = useMutation({
    mutationFn: async () => {
      await confirmFreshCampaignAdminAuthority(identity);
      return remixCampaign(campaignId, { channels: selected, tone });
    },
    onSuccess: (next) => setResult(next),
  });

  const toggle = (channel: RemixChannel) => {
    setSelected((current) =>
      current.includes(channel)
        ? current.filter((entry) => entry !== channel)
        : // Keep the server's canonical order regardless of click order.
          REMIX_CHANNELS.map((entry) => entry.id).filter(
            (entry) => entry === channel || current.includes(entry),
          ),
    );
  };

  const blockedReason = !identityReady
    ? "Checking your access…"
    : !canRemix
      ? REMIX_ADMIN_ONLY_MESSAGE
      : selected.length === 0
        ? "Pick at least one channel before generating a remix."
        : remix.isPending
          ? "A remix is already being generated."
          : null;

  const copy = async (text: string) => {
    const outcome = await copyToClipboard(text);
    if (outcome === "copied") toast.success("Copied to clipboard");
    else if (outcome === "unavailable") {
      toast.error(
        "This browser does not allow clipboard access here. Select the text and copy it manually.",
      );
    } else toast.error("The asset couldn't be copied.");
  };

  return (
    <section
      className={PANEL_CLASS}
      aria-labelledby="campaign-remix-heading"
      data-testid="campaign-remix-card"
    >
      <div className="mb-2 flex items-center gap-2">
        <Shuffle className="h-4 w-4" aria-hidden />
        <h2 id="campaign-remix-heading" className="text-base font-semibold">
          Content remix
        </h2>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Repurpose this campaign as cross-channel assets, derived from the saved
        body by a template (not a model) and ready to paste. Save your edits
        first — unsaved changes are not included.
      </p>

      <div
        role="group"
        aria-label="Remix channels"
        className="mb-3 flex flex-wrap gap-1.5"
      >
        {REMIX_CHANNELS.map((channel) => (
          <Button
            key={channel.id}
            type="button"
            size="sm"
            variant={selected.includes(channel.id) ? "secondary" : "outline"}
            aria-pressed={selected.includes(channel.id)}
            onClick={() => toggle(channel.id)}
          >
            {channel.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="grid gap-1">
          <Label htmlFor={toneId}>Tone (optional)</Label>
          <Input
            id={toneId}
            value={tone}
            maxLength={120}
            placeholder="e.g. playful"
            onChange={(event) => setTone(event.target.value)}
          />
        </div>
        <Button
          type="button"
          disabled={blockedReason !== null}
          aria-describedby={`${toneId}-note`}
          onClick={() => remix.mutate()}
        >
          {remix.isPending ? "Generating…" : "Generate remix"}
        </Button>
      </div>
      <p id={`${toneId}-note`} className="mt-2 text-xs text-muted-foreground">
        {blockedReason ?? "Generates one asset per selected channel."}
      </p>

      {remix.isError ? (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Remix failed</AlertTitle>
          <AlertDescription>
            {apiErrorMessage(remix.error, "The remix couldn't be generated.")}
          </AlertDescription>
        </Alert>
      ) : null}

      {result ? (
        result.assets.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No assets came back for the selected channels — is the saved
            campaign body empty?
          </p>
        ) : (
          <div className="mt-3 grid gap-2">
            <p className="text-xs text-muted-foreground">
              Generated{" "}
              {formatWireTimestamp(result.generated_at, "just now")} — review
              before publishing.
            </p>
            {result.assets.map((asset, index) => (
              <article
                key={`${asset.channel}-${index}`}
                className="grid gap-2 rounded-md border p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{channelLabel(asset.channel)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {asset.title}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    aria-label={`Copy the ${channelLabel(asset.channel)} asset`}
                    onClick={() => void copy(asset.body)}
                  >
                    <Copy className="h-4 w-4" aria-hidden />
                    Copy
                  </Button>
                </div>
                <pre
                  tabIndex={0}
                  className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-xs"
                >
                  {asset.body}
                </pre>
              </article>
            ))}
          </div>
        )
      ) : null}
    </section>
  );
}
