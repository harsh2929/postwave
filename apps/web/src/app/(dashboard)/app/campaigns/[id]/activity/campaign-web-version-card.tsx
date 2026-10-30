// SPDX-License-Identifier: AGPL-3.0-only
"use client";

/**
 * Web version — parity row campaigns-57 (desktop CampaignWebVersionCard +
 * useCampaignDetailData's archive-settings read).
 *
 * A campaign published to the public archive has a web version, but no server
 * endpoint hands out its URL: it is composed from the workspace's archive
 * address (GET /api/v1/admin/archive/tenant-settings) and the campaign's own
 * `archive_slug`. That settings read is ADMIN-scoped on the server, so for
 * anyone else the card says who can resolve the link instead of issuing a
 * request that is guaranteed a 403.
 *
 * The settings query shares its key with the Archive settings page, so the
 * two surfaces read one cache entry for one workspace answer.
 */

import { useMemo } from "react";
import Link from "next/link";
import { Copy, ExternalLink, Globe } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { apiErrorMessage } from "@/lib/api";
import { archiveIssueUrl, getArchiveSettings } from "@/lib/archive-admin-api";
import { effectiveAuthRole } from "@/lib/auth-api";
import { campaignArchiveFields } from "@/lib/campaign-detail-panels-api";
import { copyToClipboard } from "@/lib/clipboard";
import { base, STALE } from "@/lib/query-keys";
import { useAppOrigin } from "@/lib/use-app-origin";

import { PANEL_CLASS, type CampaignPanelScope } from "./campaign-panel-scope";

export function CampaignWebVersionCard({
  scope,
  campaign,
}: {
  scope: CampaignPanelScope;
  /** The campaign payload as the page loaded it; null while loading. */
  campaign: unknown;
}) {
  const { identity, identityReady } = scope;
  const appOrigin = useAppOrigin();
  const { archivePublic, archiveSlug } = campaignArchiveFields(campaign);
  const published = archivePublic && archiveSlug !== "";

  const effectiveRole = identity ? effectiveAuthRole(identity) : null;
  const canReadArchiveSettings = Boolean(
    identity &&
    !identity.viewer_mode &&
    effectiveRole !== null &&
    ["owner", "admin"].includes(effectiveRole),
  );
  // Same key shape as app/archive-settings/page.tsx.
  const settingsKey = useMemo(
    () =>
      [
        ...base("archive-admin", identity?.tenant_id ?? "pending", effectiveRole),
        identity?.user_id ?? "pending-user",
        Boolean(identity?.viewer_mode),
        "settings",
      ] as const,
    [effectiveRole, identity?.tenant_id, identity?.user_id, identity?.viewer_mode],
  );
  const settingsQuery = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => getArchiveSettings(signal),
    enabled: identityReady && published && canReadArchiveSettings,
    staleTime: STALE.reference,
  });

  const url =
    published && settingsQuery.data
      ? archiveIssueUrl(settingsQuery.data, appOrigin, archiveSlug)
      : null;

  const copyLink = async (value: string) => {
    const result = await copyToClipboard(value);
    if (result === "copied") toast.success("Web version link copied");
    else if (result === "unavailable") {
      toast.error(
        "This browser does not allow clipboard access here. Select the link and copy it manually.",
      );
    } else toast.error("The web version link couldn't be copied.");
  };

  return (
    <section
      className={PANEL_CLASS}
      aria-labelledby="campaign-web-version-heading"
      data-testid="campaign-web-version-card"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Globe className="h-4 w-4" aria-hidden />
        <h2 id="campaign-web-version-heading" className="text-base font-semibold">
          Web version
        </h2>
        {published ? <Badge variant="info">Published</Badge> : null}
      </div>

      {campaign === null ? (
        <p className="text-sm text-muted-foreground">Loading campaign…</p>
      ) : !published ? (
        <p className="text-sm text-muted-foreground">
          This campaign is not published to the public archive, so it has no
          web version to share.
        </p>
      ) : !identityReady ? (
        <p className="text-sm text-muted-foreground">Checking your access…</p>
      ) : !canReadArchiveSettings ? (
        <p className="text-sm text-muted-foreground">
          The public link is built from the workspace&apos;s archive address,
          which only an owner or admin can read. Ask one of them for the link to
          this campaign&apos;s web version.
        </p>
      ) : settingsQuery.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          Resolving the public URL…
        </p>
      ) : settingsQuery.isError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">
            Couldn&apos;t read the archive address:{" "}
            {apiErrorMessage(settingsQuery.error)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void settingsQuery.refetch()}
          >
            Retry the archive address
          </Button>
        </div>
      ) : url ? (
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 flex-1 items-center gap-1 truncate font-mono text-xs text-primary underline-offset-2 hover:underline"
            title={url}
          >
            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">{url}</span>
          </a>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void copyLink(url)}
          >
            <Copy className="h-4 w-4" aria-hidden />
            Copy link
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          The workspace has no public archive address yet, so this issue has no
          shareable URL. Set an archive slug or domain in{" "}
          <Link
            href="/app/archive-settings"
            className="text-primary underline-offset-2 hover:underline"
          >
            Archive settings
          </Link>
          .
        </p>
      )}
    </section>
  );
}
