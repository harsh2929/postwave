// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import Link from "next/link";
import {
  Archive,
  ArrowRight,
  Columns3,
  Copy,
  FolderPlus,
  Monitor,
  RotateCcw,
  Smartphone,
  Star,
} from "lucide-react";
import { useRef, useState } from "react";

import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { IconButton } from "@/components/ui/icon-button";
import {
  campaignTemplateActionReason,
  campaignTemplateCapabilities,
  campaignTemplateCapabilityLabel,
  campaignTemplateThumbnailUrl,
  isOwnedCampaignTemplate,
  type CampaignTemplateSummary,
} from "@/lib/campaign-templates-api";
import {
  buildCampaignTemplateDetailHref,
  campaignTemplateCardElementID,
} from "@/lib/campaign-template-navigation";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

import {
  LazyAdaptTemplateAction,
  LazyUseTemplateAction,
} from "./deferred-template-actions";
import { PreviewImage } from "./preview-image";
import {
  canDrawTemplateSource,
  TemplateSourceThumbnail,
} from "./template-source-thumbnail";

function humanize(value: string) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

// The product's own provider slug. Every template made in this app carries
// it: the built-in starters and each workspace's own designs alike.
const OWN_PROVIDER = "postwave";

const EXTERNAL_PROVIDER_LABELS: Record<string, string> = {
  reallygoodemails: "Really Good Emails",
  aura_build: "Aura",
};

// Where a design came from, in plain words. A built-in starter says so; a
// design the workspace made itself needs no badge (the tab already says whose
// it is); a design from an outside catalogue names that catalogue.
function providerBadgeLabel(template: CampaignTemplateSummary): string | null {
  const provider = template.provider || template.source;
  if (!provider) return null;
  if (provider === OWN_PROVIDER) {
    return isOwnedCampaignTemplate(template) ? null : "Built-in";
  }
  if (provider === "mine" || provider === "team" || provider === "platform") {
    return null;
  }
  return EXTERNAL_PROVIDER_LABELS[provider] ?? humanize(provider);
}

function TemplateThumbnail({
  template,
}: {
  template: CampaignTemplateSummary;
}) {
  const hostedThumbnail = campaignTemplateThumbnailUrl(template);
  const alt = `Preview of ${template.name}`;
  const badgeLabel = providerBadgeLabel(template);
  const wrapperClassName = "absolute inset-0 min-h-0 rounded-none border-0";
  return (
    <div className="relative aspect-[4/5] overflow-hidden border-b bg-gradient-to-br from-muted/30 to-muted">
      {/* A hosted screenshot wins; otherwise an editable template is drawn
          from its own HTML rather than showing "Preview unavailable". */}
      {!hostedThumbnail && canDrawTemplateSource(template) ? (
        <TemplateSourceThumbnail
          template={template}
          alt={alt}
          wrapperClassName={wrapperClassName}
        />
      ) : (
        <PreviewImage
          src={hostedThumbnail}
          alt={alt}
          className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.015] motion-reduce:transform-none motion-reduce:transition-none"
          wrapperClassName={wrapperClassName}
        />
      )}
      <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
        {template.is_featured ? (
          <Badge className="gap-1 shadow-sm">
            <Star className="h-3 w-3 fill-current" /> Featured
          </Badge>
        ) : null}
        {badgeLabel ? (
          <Badge
            variant="secondary"
            className="bg-background/90 shadow-sm backdrop-blur"
          >
            {badgeLabel}
          </Badge>
        ) : null}
        {template.archived_at ? (
          <Badge variant="outline" className="bg-background/90 shadow-sm">
            Archived
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  detailHref,
  onToggleFavorite,
  onDuplicate,
  onArchive,
  onRestore,
  selected,
  onToggleSelect,
  compareSelected,
  onToggleCompare,
  onAddToCollection,
}: {
  template: CampaignTemplateSummary;
  detailHref: string;
  onToggleFavorite: (template: CampaignTemplateSummary) => void;
  onDuplicate: (template: CampaignTemplateSummary) => void;
  onArchive: (template: CampaignTemplateSummary) => void;
  onRestore: (template: CampaignTemplateSummary) => void;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  compareSelected: boolean;
  onToggleCompare: (template: CampaignTemplateSummary) => void;
  onAddToCollection: (template: CampaignTemplateSummary) => void;
}) {
  const metadata = [
    template.style,
    template.layout_archetype,
    template.industry,
  ]
    .filter(Boolean)
    .slice(0, 2) as string[];
  const favorited = Boolean(template.is_favorited);
  const usageCount = template.usage_count ?? 0;
  const capabilities = campaignTemplateCapabilities(template);
  const actionReason = campaignTemplateActionReason(template);
  const favoriteReasonID = `${campaignTemplateCardElementID(template.id)}-favorite-reason`;
  const primaryReasonID = `${campaignTemplateCardElementID(template.id)}-primary-reason`;
  // Archive sits one row below "Duplicate" in a menu whose other items are all
  // harmless, so a mis-click used to remove the card outright. Confirming here
  // matches the bulk bar and the detail header, which gate the same verb.
  const [archiveOpen, setArchiveOpen] = useState(false);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);

  const menuItems: ActionMenuItem[] = [
    {
      label: compareSelected ? "Remove from comparison" : "Add to comparison",
      icon: <Columns3 className="h-4 w-4" />,
      onSelect: () => onToggleCompare(template),
    },
    {
      label: "Add to collection",
      icon: <FolderPlus className="h-4 w-4" />,
      onSelect: () => onAddToCollection(template),
    },
    ...(capabilities.can_favorite
      ? ([
          {
            label: favorited ? "Remove from favorites" : "Add to favorites",
            icon: <Star className="h-4 w-4" />,
            onSelect: () => onToggleFavorite(template),
          },
        ] satisfies ActionMenuItem[])
      : []),
  ];
  if (capabilities.can_clone) {
    menuItems.push({
      label: "Duplicate",
      icon: <Copy className="h-4 w-4" />,
      onSelect: () => onDuplicate(template),
    });
  }
  if (capabilities.can_archive && template.etag) {
    menuItems.push({
      label: "Archive",
      icon: <Archive className="h-4 w-4" />,
      onSelect: () => setArchiveOpen(true),
    });
  }
  if (capabilities.can_restore && template.etag) {
    menuItems.push({
      label: "Restore",
      icon: <RotateCcw className="h-4 w-4" />,
      onSelect: () => onRestore(template),
    });
  }

  return (
    <Card
      id={campaignTemplateCardElementID(template.id)}
      tabIndex={-1}
      role="article"
      aria-label={`${template.name}${template.archived_at ? " (archived)" : ""}`}
      className={cn(
        "group flex min-w-0 flex-col overflow-hidden transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-md motion-reduce:transform-none motion-reduce:transition-none",
        selected && "border-primary ring-1 ring-primary",
        compareSelected &&
          !selected &&
          "border-primary/60 ring-1 ring-primary/40",
      )}
    >
      <div className="relative">
        <Link href={asRoute(detailHref)} className="block">
          <TemplateThumbnail template={template} />
        </Link>
        <label
          className={cn(
            "absolute left-2 top-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded bg-background/90 p-1.5 shadow-sm backdrop-blur transition-opacity hover:bg-background sm:min-h-8 sm:min-w-8",
            !selected &&
              "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
          )}
          onClick={(event) => event.stopPropagation()}
        >
          <Checkbox
            aria-label={
              selected ? `Deselect ${template.name}` : `Select ${template.name}`
            }
            checked={selected}
            onChange={() => onToggleSelect(template.id)}
          />
        </label>
        <IconButton
          aria-label={`${favorited ? "Remove from favorites" : "Add to favorites"}: ${template.name}`}
          aria-pressed={favorited}
          size="sm"
          aria-disabled={!capabilities.can_favorite}
          aria-describedby={
            capabilities.can_favorite ? undefined : favoriteReasonID
          }
          onClick={() => {
            if (capabilities.can_favorite) onToggleFavorite(template);
          }}
          className="absolute right-2 top-2 h-11 w-11 bg-background/90 shadow-sm backdrop-blur hover:bg-background sm:h-8 sm:w-8"
        >
          <Star
            className={cn(
              "h-4 w-4",
              favorited
                ? "fill-amber-400 text-amber-500"
                : "text-muted-foreground",
            )}
          />
        </IconButton>
        {!capabilities.can_favorite ? (
          <span id={favoriteReasonID} className="sr-only">
            Favorites are unavailable until this design is approved.
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={compareSelected ? "secondary" : "outline"}
          aria-pressed={compareSelected}
          aria-label={`${compareSelected ? "Remove" : "Add"} ${template.name} ${
            compareSelected ? "from" : "to"
          } comparison`}
          onClick={() => onToggleCompare(template)}
          className="absolute bottom-2 right-2 min-h-11 bg-background/90 px-3 text-xs shadow-sm backdrop-blur hover:bg-background sm:min-h-8 sm:px-2 sm:text-[11px]"
        >
          <Columns3 className="h-3.5 w-3.5" aria-hidden />
          {compareSelected ? "Comparing" : "Compare"}
        </Button>
      </div>
      <CardContent className="flex flex-1 flex-col gap-3 p-4">
        <div className="space-y-1">
          <Link
            href={asRoute(detailHref)}
            className="inline-flex min-h-11 items-center py-2 font-medium leading-snug underline-offset-4 hover:underline sm:min-h-0 sm:py-0"
          >
            {template.name}
          </Link>
          <p className="line-clamp-2 min-h-10 text-sm text-muted-foreground">
            {template.description || template.subject}
          </p>
        </div>
        <div className="flex min-h-6 flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="font-normal">
            {campaignTemplateCapabilityLabel(template)}
          </Badge>
          {capabilities.has_desktop_preview ? (
            <Badge variant="outline" className="gap-1 font-normal">
              <Monitor className="h-3 w-3" aria-hidden /> Desktop
            </Badge>
          ) : null}
          {capabilities.has_mobile_preview ? (
            <Badge variant="outline" className="gap-1 font-normal">
              <Smartphone className="h-3 w-3" aria-hidden /> Mobile
            </Badge>
          ) : null}
          {metadata.map((value) => (
            <Badge key={value} variant="outline" className="font-normal">
              {humanize(value)}
            </Badge>
          ))}
          {!metadata.length && template.category ? (
            <Badge variant="outline" className="font-normal">
              {humanize(template.category)}
            </Badge>
          ) : null}
          {usageCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              Used {usageCount.toLocaleString()}×
            </span>
          ) : null}
        </div>
        <div className="mt-auto flex items-center justify-between gap-1 pt-1">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="min-h-11 px-2 sm:min-h-8"
          >
            <Link href={asRoute(detailHref)}>
              View design <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <div className="flex items-center gap-1">
            {template.template_kind === "reference" ? (
              capabilities.can_adapt ? (
                <LazyAdaptTemplateAction
                  template={template}
                  label="Make it mine"
                  size="sm"
                  triggerClassName="min-h-11 sm:min-h-8"
                />
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="min-h-11 sm:min-h-8"
                    aria-disabled="true"
                    aria-describedby={primaryReasonID}
                  >
                    Awaiting review
                  </Button>
                  <span id={primaryReasonID} className="sr-only">
                    {actionReason}
                  </span>
                </>
              )
            ) : capabilities.can_create_campaign ? (
              <LazyUseTemplateAction
                template={template}
                label="Use"
                size="sm"
                triggerClassName="min-h-11 sm:min-h-8"
              />
            ) : (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="min-h-11 sm:min-h-8"
                  aria-disabled="true"
                  aria-describedby={primaryReasonID}
                >
                  Preview only
                </Button>
                <span id={primaryReasonID} className="sr-only">
                  {actionReason}
                </span>
              </>
            )}
            {menuItems.length ? (
              <ActionMenu
                label={`Actions for ${template.name}`}
                items={menuItems}
                triggerClassName="h-11 w-11 sm:h-7 sm:w-7"
                triggerRef={actionsTriggerRef}
              />
            ) : null}
          </div>
        </div>
      </CardContent>
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={`Archive ${template.name}?`}
        description="The template will become read-only and move to My templates → Archived. Existing campaigns remain unchanged, and you can restore it later."
        confirmLabel="Archive template"
        onConfirm={() => onArchive(template)}
        fallbackFocusRef={actionsTriggerRef}
      />
    </Card>
  );
}

function CardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="aspect-[4/5] animate-pulse bg-muted" />
      <div className="space-y-3 p-4">
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-8 animate-pulse rounded bg-muted" />
      </div>
    </div>
  );
}

export interface TemplateGalleryProps {
  templates: CampaignTemplateSummary[];
  galleryPath: string;
  selected: Set<string>;
  compareSelectedIds: Set<string>;
  loading: boolean;
  loadingMore: boolean;
  onToggleFavorite: (template: CampaignTemplateSummary) => void;
  onDuplicate: (template: CampaignTemplateSummary) => void;
  onArchive: (template: CampaignTemplateSummary) => void;
  onRestore: (template: CampaignTemplateSummary) => void;
  onToggleSelect: (id: string) => void;
  onToggleCompare: (template: CampaignTemplateSummary) => void;
  onAddToCollection: (template: CampaignTemplateSummary) => void;
}

export function TemplateGallery({
  templates,
  galleryPath,
  selected,
  compareSelectedIds,
  loading,
  loadingMore,
  onToggleFavorite,
  onDuplicate,
  onArchive,
  onRestore,
  onToggleSelect,
  onToggleCompare,
  onAddToCollection,
}: TemplateGalleryProps) {
  return (
    <div
      className={cn(
        "grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4",
        loading && "opacity-60",
      )}
      aria-busy={loading}
    >
      {templates.map((template) => (
        <TemplateCard
          key={template.id}
          template={template}
          detailHref={buildCampaignTemplateDetailHref(template.id, galleryPath)}
          onToggleFavorite={onToggleFavorite}
          onDuplicate={onDuplicate}
          onArchive={onArchive}
          onRestore={onRestore}
          selected={selected.has(template.id)}
          onToggleSelect={onToggleSelect}
          compareSelected={compareSelectedIds.has(template.id)}
          onToggleCompare={onToggleCompare}
          onAddToCollection={onAddToCollection}
        />
      ))}
      {loadingMore
        ? Array.from({ length: 4 }, (_, index) => (
            <CardSkeleton key={`more-${index}`} />
          ))
        : null}
    </div>
  );
}
