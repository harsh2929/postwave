// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import {
  Archive,
  Download,
  FileCode2,
  FileDown,
  Pencil,
  RotateCcw,
  Star,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyTextButton } from "@/components/copy-text-button";
import { IconButton } from "@/components/ui/icon-button";
import { apiErrorMessage } from "@/lib/api";
import {
  archiveCampaignTemplate,
  campaignTemplateCapabilities,
  campaignTemplateExportableSource,
  cloneCampaignTemplate,
  favoriteCampaignTemplate,
  isOwnedCampaignTemplate,
  restoreCampaignTemplate,
  type CampaignTemplate,
} from "@/lib/campaign-templates-api";
import { downloadTextFile } from "@/lib/download";
import { asRoute } from "@/lib/typed-routes";
import { cn } from "@/lib/utils";

/**
 * Client action cluster for the template detail header: an interactive favorite
 * toggle (TMPL-003), a Copy-link control (TMPL-025), source export (TMPL-028),
 * and an overflow menu with Duplicate / Edit / Archive / Restore for owned templates
 * (TMPL-020 / TMPL-024). Ownership-gated so read-only catalog rows never show
 * actions the tenant-scoped backend would reject.
 */
export function TemplateDetailActions({
  template,
}: {
  template: CampaignTemplate;
}) {
  const router = useRouter();
  const [favorited, setFavorited] = useState(Boolean(template.is_favorited));
  const [favBusy, setFavBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState(`/app/templates/${template.id}`);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [lifecycleBusy, setLifecycleBusy] = useState(false);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setShareUrl(`${window.location.origin}/app/templates/${template.id}`);
  }, [template.id]);

  const owned = isOwnedCampaignTemplate(template);
  const capabilities = campaignTemplateCapabilities(template);
  const isReference = template.template_kind === "reference";
  const exportable = campaignTemplateExportableSource(template);
  const slug = template.slug || template.id;

  const toggleFavorite = async () => {
    if (favBusy || !capabilities.can_favorite) return;
    const next = !favorited;
    setFavorited(next);
    setFavBusy(true);
    try {
      await favoriteCampaignTemplate(template.id, next);
    } catch (err) {
      setFavorited(!next);
      toast.error(apiErrorMessage(err, "Could not update favorite."));
    } finally {
      setFavBusy(false);
    }
  };

  const duplicate = async () => {
    try {
      const copy = await cloneCampaignTemplate(template.id);
      toast.success("Template duplicated");
      router.push(`/app/templates/${copy.id}`);
    } catch (err) {
      toast.error(apiErrorMessage(err, "Could not duplicate the template."));
    }
  };

  const archived = Boolean(template.archived_at);

  const changeLifecycle = async () => {
    if (!template.etag || lifecycleBusy) return;
    setLifecycleBusy(true);
    try {
      if (archived) {
        await restoreCampaignTemplate(template.id, template.etag);
        toast.success("Template restored", {
          description: "It is editable and ready to use again.",
        });
      } else {
        await archiveCampaignTemplate(template.id, template.etag);
        toast.success("Template archived", {
          description:
            "It is safely stored in My templates → Archived and can be restored.",
        });
      }
      setLifecycleOpen(false);
      router.refresh();
    } catch (err) {
      toast.error(
        apiErrorMessage(
          err,
          archived
            ? "Could not restore the template."
            : "Could not archive the template.",
        ),
      );
    } finally {
      setLifecycleBusy(false);
    }
  };

  const menuItems: ActionMenuItem[] = [];
  if (capabilities.can_clone && !isReference) {
    menuItems.push({
      label: "Duplicate",
      icon: <FileDown className="h-4 w-4" />,
      onSelect: () => void duplicate(),
    });
  }
  if (exportable.html) {
    menuItems.push({
      label: "Export HTML",
      icon: <Download className="h-4 w-4" />,
      onSelect: () =>
        downloadTextFile(
          `${slug}.html`,
          template.body_html ?? "",
          "text/html;charset=utf-8",
        ),
    });
  }
  if (exportable.mjml) {
    menuItems.push({
      label: "Export MJML",
      icon: <FileCode2 className="h-4 w-4" />,
      onSelect: () =>
        downloadTextFile(
          `${slug}.mjml`,
          template.body_mjml ?? "",
          "application/xml;charset=utf-8",
        ),
    });
  }
  if (owned && capabilities.can_edit_directly) {
    menuItems.push({
      label: "Edit",
      icon: <Pencil className="h-4 w-4" />,
      onSelect: () =>
        router.push(asRoute(`/app/templates/${template.id}/edit`)),
    });
  }
  if (owned && capabilities.can_archive && template.etag) {
    menuItems.push({
      label: "Archive",
      icon: <Archive className="h-4 w-4" />,
      onSelect: () => setLifecycleOpen(true),
    });
  }
  if (owned && capabilities.can_restore && template.etag) {
    menuItems.push({
      label: "Restore",
      icon: <RotateCcw className="h-4 w-4" />,
      onSelect: () => setLifecycleOpen(true),
    });
  }

  return (
    <>
      <IconButton
        aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={favorited}
        onClick={() => void toggleFavorite()}
        disabled={favBusy || !capabilities.can_favorite}
        title={
          capabilities.can_favorite
            ? undefined
            : "Favorites are unavailable until this design is approved."
        }
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
      <CopyTextButton value={shareUrl} label="Copy link" copiedLabel="Copied" />
      {menuItems.length ? (
        <ActionMenu
          label={`Actions for ${template.name}`}
          items={menuItems}
          triggerRef={actionsTriggerRef}
        />
      ) : null}
      <ConfirmDialog
        open={lifecycleOpen}
        onOpenChange={setLifecycleOpen}
        title={archived ? "Restore this template?" : "Archive this template?"}
        description={
          archived
            ? "The template will return to your active library and become editable and usable again."
            : "The template will become read-only and move to My templates → Archived. Existing campaigns remain unchanged, and you can restore it later."
        }
        confirmLabel={
          lifecycleBusy
            ? archived
              ? "Restoring…"
              : "Archiving…"
            : archived
              ? "Restore template"
              : "Archive template"
        }
        onConfirm={changeLifecycle}
        fallbackFocusRef={actionsTriggerRef}
      />
    </>
  );
}
