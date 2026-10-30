// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { ImageIcon, Monitor, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CampaignTemplateHostedPreview } from "@/lib/campaign-templates-api";
import { cn } from "@/lib/utils";

import { PreviewImage } from "./preview-image";

const VARIANT_LABELS: Record<CampaignTemplateHostedPreview["variant"], string> =
  {
    desktop: "Desktop",
    card: "Card",
    mobile: "Mobile",
  };

function VariantIcon({
  variant,
}: {
  variant: CampaignTemplateHostedPreview["variant"];
}) {
  if (variant === "desktop") return <Monitor aria-hidden />;
  if (variant === "mobile") return <Smartphone aria-hidden />;
  return <ImageIcon aria-hidden />;
}

function dimensions(asset: CampaignTemplateHostedPreview): string | null {
  if (!asset.width || !asset.height) return null;
  return `${asset.width.toLocaleString()} × ${asset.height.toLocaleString()}`;
}

export function TemplateCapturePreview({
  assets,
  templateName,
  expanded = false,
}: {
  assets: CampaignTemplateHostedPreview[];
  templateName: string;
  expanded?: boolean;
}) {
  const uniqueAssets = useMemo(
    () =>
      assets.filter(
        (asset, index) =>
          assets.findIndex(
            (candidate) => candidate.variant === asset.variant,
          ) === index,
      ),
    [assets],
  );
  const [activeVariant, setActiveVariant] = useState<
    CampaignTemplateHostedPreview["variant"] | undefined
  >(uniqueAssets[0]?.variant);
  const active =
    uniqueAssets.find((asset) => asset.variant === activeVariant) ??
    uniqueAssets[0];

  useEffect(() => {
    if (
      activeVariant &&
      uniqueAssets.some((asset) => asset.variant === activeVariant)
    ) {
      return;
    }
    setActiveVariant(uniqueAssets[0]?.variant);
  }, [activeVariant, uniqueAssets]);

  if (!active) return null;

  return (
    <section
      aria-label={`Hosted captures for ${templateName}`}
      className="space-y-3"
    >
      <div
        role="group"
        aria-label="Available hosted captures"
        className="flex flex-wrap items-center gap-2"
      >
        {uniqueAssets.map((asset) => {
          const selected = asset.variant === active.variant;
          return (
            <Button
              key={asset.variant}
              type="button"
              size="sm"
              variant={selected ? "secondary" : "outline"}
              aria-pressed={selected}
              onClick={() => setActiveVariant(asset.variant)}
              className="min-h-11 sm:min-h-8"
            >
              <VariantIcon variant={asset.variant} />
              {VARIANT_LABELS[asset.variant]}
            </Button>
          );
        })}
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {VARIANT_LABELS[active.variant]} capture
          {dimensions(active) ? ` · ${dimensions(active)}` : ""}
        </span>
        {active.status === "source_missing" ? (
          <Badge variant="outline">Last verified capture</Badge>
        ) : null}
      </div>
      <div className="rounded-lg border bg-muted/30 p-3 sm:p-6">
        <PreviewImage
          src={active.url}
          alt={`${VARIANT_LABELS[active.variant]} capture of ${templateName}`}
          // The capture's own dimensions, so the box is reserved before the
          // (large) screenshot decodes instead of shoving the page down by up
          // to 1,200px on arrival.
          width={active.width}
          height={active.height}
          className={cn(
            "mx-auto max-w-full rounded border bg-white object-contain shadow-sm",
            expanded ? "max-h-[1200px]" : "max-h-[800px]",
            active.variant === "mobile"
              ? "w-auto max-w-[390px]"
              : active.variant === "card"
                ? "w-auto max-w-xl"
                : "w-auto",
          )}
          wrapperClassName="mx-auto min-h-0 border-0 bg-transparent"
        />
      </div>
    </section>
  );
}
