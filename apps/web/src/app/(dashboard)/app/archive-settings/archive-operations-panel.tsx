// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Eye,
  Link2,
  Pin,
  PinOff,
  Search,
  ShieldAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  archiveShareTargets,
  getArchiveIssuePreview,
  getArchiveStats,
  listArchiveIssues,
  setArchiveIssuePinned,
  unpublishArchiveIssue,
  type ArchiveIssuePreview,
  type ArchiveIssuePage,
  type ArchiveIssueSummary,
  type ArchiveSettings,
} from "@/lib/archive-admin-api";
import { apiErrorMessage } from "@/lib/api";
import {
  effectiveAuthRole,
  whoamiFresh,
  type MeResponse,
} from "@/lib/auth-api";
import { copyToClipboard, isClipboardAvailable } from "@/lib/clipboard";
import { loadNextQueryPage } from "@/lib/infinite-query-action";
import { STALE } from "@/lib/query-keys";
import { useAppOrigin } from "@/lib/use-app-origin";
import { TemplatePreviewFrame } from "../templates/_components/template-preview";
import {
  EngagementEmpty,
  EngagementLoading,
  EngagementMetric,
  EngagementQueryError,
  EngagementSurface,
} from "../_engagement/engagement-ui";

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;

// Private podcast tokens sit below the fold (desktop: the Archive page's
// advanced "private feeds" workspace) and are release-held today; deferring
// the card keeps the route under the dashboard bundle budget.
const PodcastTokensCard = dynamic(
  () =>
    import("@/components/archive/PodcastTokensCard").then(
      (module) => module.PodcastTokensCard,
    ),
  {
    loading: () => (
      <EngagementLoading label="Loading private podcast controls" rows={2} />
    ),
  },
);

interface UnpublishTarget {
  row: ArchiveIssueSummary;
  preview: ArchiveIssuePreview;
}

export function canEmergencyUnpublish(me: MeResponse): boolean {
  const role = effectiveAuthRole(me);
  return me.viewer_mode !== true && (role === "owner" || role === "admin");
}

/**
 * Featuring an issue reorders the public index, which the server mounts behind
 * the same admin scope as unpublish (archive.MountAdminRoutes). A view-as
 * session is withheld for the same reason it is withheld from unpublish: the
 * effective role, not the real one, is what the workspace granted.
 */
export function canFeatureArchiveIssue(me: MeResponse): boolean {
  return canEmergencyUnpublish(me);
}

export function assertFreshArchiveAuthority(
  openedAs: MeResponse,
  fresh: MeResponse,
): void {
  if (
    openedAs.user_id !== fresh.user_id ||
    openedAs.tenant_id !== fresh.tenant_id ||
    openedAs.role !== fresh.role ||
    effectiveAuthRole(openedAs) !== effectiveAuthRole(fresh) ||
    Boolean(openedAs.viewer_mode) !== Boolean(fresh.viewer_mode) ||
    !canEmergencyUnpublish(fresh)
  ) {
    throw new Error(
      "Your workspace or archive authority changed. Close this confirmation and review the issue again.",
    );
  }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatPublishedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function secureOperationKey(): string {
  if (
    typeof crypto === "undefined" ||
    typeof crypto.randomUUID !== "function"
  ) {
    throw new Error(
      "This browser cannot create a secure operation key. Update it before trying again.",
    );
  }
  return crypto.randomUUID();
}

interface ShareTarget {
  id: string;
  label: string;
  url: string;
  confirmation: string;
}

/**
 * Copy/open controls for the three reader-facing archive URLs (desktop gap
 * campaigns-103; desktop's ArchiveShareControls.tsx is the reference).
 *
 * Nothing here is a request: the URLs are composed from the tenant settings
 * already on screen. The whole group is withheld when the archive has no
 * address, because a copy button that hands out a URL resolving nowhere is
 * worse than no button — the operator would paste it into a newsletter before
 * discovering it 404s.
 */
export function ArchiveShareLinks({ settings }: { settings: ArchiveSettings }) {
  const origin = useAppOrigin();
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Resolved after mount so SSR does not render the controls disabled before
  // the Clipboard API is observable.
  const [clipboardReady, setClipboardReady] = useState(true);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setClipboardReady(isClipboardAvailable());
    return () => {
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  const targets = useMemo(
    () => archiveShareTargets(settings, origin),
    [origin, settings],
  );

  if (!targets) {
    return (
      <div className="mt-4 rounded-lg border bg-muted/20 p-3" role="status">
        <p className="text-sm font-medium">Public archive links unavailable</p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          Set an archive slug or a custom domain before copying or opening
          public archive URLs. No link is offered while the archive has no
          address.
        </p>
      </div>
    );
  }

  const shareTargets: ShareTarget[] = [
    {
      id: "index",
      label: "Copy public URL",
      url: targets.publicIndexUrl,
      confirmation: "Public archive URL copied",
    },
    {
      id: "rss",
      label: "Copy RSS",
      url: targets.rssUrl,
      confirmation: "RSS feed URL copied",
    },
    {
      id: "sitemap",
      label: "Copy sitemap",
      url: targets.sitemapUrl,
      confirmation: "Sitemap URL copied",
    },
  ];

  const scheduleReset = (): void => {
    if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => {
      setCopied(null);
      setFailed(null);
      resetTimerRef.current = null;
    }, 1_600);
  };

  async function onCopy(target: ShareTarget): Promise<void> {
    const result = await copyToClipboard(target.url);
    if (result === "copied") {
      setCopied(target.id);
      setFailed(null);
      setAnnouncement(target.confirmation);
    } else {
      // A rejected write must be visible. Silently doing nothing would let the
      // operator paste whatever was on the clipboard before.
      setCopied(null);
      setFailed(target.id);
      setAnnouncement(
        result === "unavailable"
          ? "The clipboard is unavailable. Copy the URL shown on the button instead."
          : "The URL could not be copied. Try again or copy it manually.",
      );
    }
    scheduleReset();
  }

  return (
    <div className="mt-4 space-y-3">
      <p className="break-all text-xs text-muted-foreground" role="status">
        Public archive: <code>{targets.indexBase}</code>
      </p>
      <div className="flex flex-wrap gap-2">
        {shareTargets.map((target) => (
          <Button
            key={target.id}
            type="button"
            variant="outline"
            className="min-h-11"
            disabled={!clipboardReady}
            title={target.url}
            aria-label={
              clipboardReady
                ? `${target.label}: ${target.url}`
                : `Clipboard unavailable — copy ${target.url} manually`
            }
            onClick={() => void onCopy(target)}
          >
            {copied === target.id ? (
              <Check aria-hidden />
            ) : failed === target.id ? (
              <AlertTriangle aria-hidden />
            ) : (
              <Link2 aria-hidden />
            )}
            {copied === target.id
              ? "Copied"
              : failed === target.id
                ? "Copy failed"
                : target.label}
          </Button>
        ))}
        <a
          href={targets.publicIndexUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ExternalLink aria-hidden className="size-4" />
          Open public archive
        </a>
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

function PreviewDialog({
  selected,
  previewKey,
  onClose,
  onRequestUnpublish,
  canUnpublish,
}: {
  selected: ArchiveIssueSummary | null;
  previewKey: readonly unknown[];
  onClose: () => void;
  onRequestUnpublish: (
    row: ArchiveIssueSummary,
    preview: ArchiveIssuePreview,
  ) => void;
  canUnpublish: boolean;
}) {
  const preview = useQuery({
    queryKey: [...previewKey, selected?.slug ?? "closed"],
    queryFn: ({ signal }) => getArchiveIssuePreview(selected!.slug, signal),
    enabled: selected !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  const matched =
    selected !== null &&
    preview.data?.slug === selected.slug &&
    preview.data.campaignId === selected.campaignId;

  return (
    <Dialog
      open={selected !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="break-words">
            {selected?.subject || "Untitled archive issue"}
          </DialogTitle>
          <DialogDescription>
            Authenticated, network-silent inspection. Internal campaign and
            workspace identifiers are deliberately not displayed.
          </DialogDescription>
        </DialogHeader>

        {preview.isPending ? (
          <EngagementLoading
            label="Loading authenticated issue preview"
            rows={5}
          />
        ) : preview.isError || !preview.data ? (
          <EngagementQueryError
            title="Issue preview could not be verified"
            description="No cached HTML is shown after a failed authenticated preview request."
            retrying={preview.isFetching}
            onRetry={() => void preview.refetch()}
          />
        ) : !matched ? (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
          >
            The returned preview did not match the selected issue. Close this
            view and reload the archive list.
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border bg-muted/20 p-3 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Archive slug</dt>
                <dd className="mt-1 break-all font-mono text-sm">
                  {preview.data.slug}
                </dd>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3">
                <dt className="text-xs text-muted-foreground">Published</dt>
                <dd className="mt-1 text-sm">
                  <time dateTime={preview.data.publishedAt}>
                    {formatPublishedAt(preview.data.publishedAt)}
                  </time>
                </dd>
              </div>
              <div className="rounded-lg border bg-muted/20 p-3 sm:col-span-3">
                <dt className="text-xs text-muted-foreground">
                  Public excerpt
                </dt>
                <dd className="mt-1 break-words text-sm leading-relaxed">
                  {preview.data.excerpt || "No excerpt is published."}
                </dd>
              </div>
            </dl>

            <TemplatePreviewFrame
              html={preview.data.htmlBody}
              title={`${preview.data.subject || "Untitled issue"} archive preview`}
              compact
            />

            <div className="flex flex-col gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="font-medium">Emergency removal</p>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Removes this issue from the public archive. The server does
                  not currently expose a version precondition or detailed
                  receipt, so the issue and your authority are re-read
                  immediately before the idempotent request.
                </p>
              </div>
              {canUnpublish ? (
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-11 shrink-0"
                  onClick={() => onRequestUnpublish(selected, preview.data)}
                >
                  <ShieldAlert aria-hidden />
                  Emergency unpublish
                </Button>
              ) : (
                <p className="shrink-0 rounded-md border px-3 py-2 text-xs text-muted-foreground">
                  Admin or owner required
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveOperationsPanel({
  me,
  queryBase,
}: {
  me: MeResponse;
  queryBase: readonly unknown[];
}) {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ArchiveIssueSummary | null>(null);
  const [unpublishTarget, setUnpublishTarget] =
    useState<UnpublishTarget | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pinningCampaignId, setPinningCampaignId] = useState<string | null>(
    null,
  );
  const [pinError, setPinError] = useState<string | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const pinAbortRef = useRef<AbortController | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearch(searchInput.trim()),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setSelected(null);
    setUnpublishTarget(null);
    setAnnouncement("");
    setPinError(null);
    setPinningCampaignId(null);
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = null;
    pinAbortRef.current?.abort();
    pinAbortRef.current = null;
  }, [
    me.user_id,
    me.tenant_id,
    me.role,
    me.effective_role,
    me.viewer_mode,
    search,
  ]);

  useEffect(
    () => () => {
      mutationAbortRef.current?.abort();
      pinAbortRef.current?.abort();
    },
    [],
  );

  const issueListKey = [...queryBase, "issues", search] as const;
  const statsKey = [...queryBase, "stats"] as const;
  const previewKey = [...queryBase, "issue-preview"] as const;
  const stats = useQuery({
    queryKey: statsKey,
    queryFn: ({ signal }) => getArchiveStats(signal),
    staleTime: STALE.dashboard,
  });
  const issues = useInfiniteQuery({
    queryKey: issueListKey,
    queryFn: ({ pageParam, signal }) =>
      listArchiveIssues({
        cursor: pageParam ?? undefined,
        limit: PAGE_SIZE,
        q: search || undefined,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage, _pages, lastPageParam) =>
      lastPage.nextCursor && lastPage.nextCursor !== lastPageParam
        ? lastPage.nextCursor
        : undefined,
    staleTime: STALE.list,
  });
  const rows = useMemo(
    () => issues.data?.pages?.flatMap((page) => page.items) ?? [],
    [issues.data?.pages],
  );
  const canUnpublish = canEmergencyUnpublish(me);
  const canFeature = canFeatureArchiveIssue(me);

  async function toggleFeatured(row: ArchiveIssueSummary) {
    if (!canFeature || pinningCampaignId !== null) return;
    const pinned = !row.pinned;
    const controller = new AbortController();
    pinAbortRef.current?.abort();
    pinAbortRef.current = controller;
    setPinningCampaignId(row.campaignId);
    setPinError(null);
    try {
      await setArchiveIssuePinned({
        campaignId: row.campaignId,
        pinned,
        idempotencyKey: secureOperationKey(),
        signal: controller.signal,
      });
      // The receipt is the write result and it already agreed with what we
      // asked for. Reflect it locally so a failing background refresh cannot
      // repaint the row as unchanged, then refresh as a separate read concern
      // — the server also re-sorts the list, which only a refetch can show.
      queryClient.setQueriesData<InfiniteData<ArchiveIssuePage>>(
        { queryKey: [...queryBase, "issues"] },
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.campaignId === row.campaignId
                      ? { ...item, pinned }
                      : item,
                  ),
                })),
              }
            : current,
      );
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: [...queryBase, "issues"] }),
        queryClient.invalidateQueries({ queryKey: statsKey }),
      ]).catch(() => undefined);
      setAnnouncement(
        `${row.subject || "Untitled archive issue"} was ${
          pinned
            ? "featured at the top of"
            : "removed from the featured section of"
        } the public archive.`,
      );
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setPinError(
        apiErrorMessage(
          error,
          pinned
            ? "The issue could not be featured. Nothing was assumed to have changed."
            : "The issue could not be unfeatured. Nothing was assumed to have changed.",
        ),
      );
    } finally {
      if (pinAbortRef.current === controller) pinAbortRef.current = null;
      setPinningCampaignId((current) =>
        current === row.campaignId ? null : current,
      );
    }
  }

  async function confirmUnpublish() {
    const target = unpublishTarget;
    if (!target) throw new Error("The issue confirmation expired.");
    const controller = new AbortController();
    mutationAbortRef.current?.abort();
    mutationAbortRef.current = controller;
    try {
      const fresh = await whoamiFresh(controller.signal);
      assertFreshArchiveAuthority(me, fresh);
      const latest = await getArchiveIssuePreview(
        target.row.slug,
        controller.signal,
      );
      if (
        latest.slug !== target.row.slug ||
        latest.campaignId !== target.row.campaignId ||
        target.preview.campaignId !== target.row.campaignId
      ) {
        throw new Error(
          "The selected issue changed while confirmation was open. Reload the list and inspect it again.",
        );
      }
      await unpublishArchiveIssue({
        campaignId: latest.campaignId,
        idempotencyKey: secureOperationKey(),
        signal: controller.signal,
      });
      // The positive server receipt is the write result. A follow-up refresh
      // failure must not turn that success into a false "nothing changed"
      // message, so remove the confirmed row locally and refresh in the
      // background as a separate read concern.
      queryClient.setQueriesData<InfiniteData<ArchiveIssuePage>>(
        { queryKey: [...queryBase, "issues"] },
        (current) =>
          current
            ? {
                ...current,
                pages: current.pages.map((page) => ({
                  ...page,
                  items: page.items.filter(
                    (item) => item.campaignId !== latest.campaignId,
                  ),
                })),
              }
            : current,
      );
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: [...queryBase, "issues"],
        }),
        queryClient.invalidateQueries({ queryKey: statsKey }),
      ]).catch(() => undefined);
      queryClient.removeQueries({ queryKey: previewKey });
      setSelected(null);
      setAnnouncement(
        `${target.row.subject || "Untitled archive issue"} was unpublished.`,
      );
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        throw new Error("The archive operation was cancelled safely.");
      }
      throw new Error(
        apiErrorMessage(
          error,
          "The issue could not be unpublished. Nothing was assumed to have changed.",
        ),
      );
    } finally {
      if (mutationAbortRef.current === controller) {
        mutationAbortRef.current = null;
      }
    }
  }

  return (
    <div className="space-y-6">
      <EngagementSurface
        id="ar-performance"
        title="Published issue performance"
        description="Authenticated, tenant-scoped archive totals. View counts exclude traffic classified as bots."
      >
        {stats.isPending ? (
          <EngagementLoading label="Loading archive performance" rows={2} />
        ) : stats.isError || !stats.data ? (
          <EngagementQueryError
            title="Archive performance could not be loaded"
            description="No zero values are inferred from a failed statistics request."
            retrying={stats.isFetching}
            onRetry={() => void stats.refetch()}
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <EngagementMetric
                label="Published issues"
                value={formatCount(stats.data.totalIssues)}
                hint={`${formatCount(stats.data.pinnedIssues)} featured`}
              />
              <EngagementMetric
                label="Views (30 days)"
                value={formatCount(stats.data.views30d)}
                hint="Bot traffic excluded"
              />
              <EngagementMetric
                label="Unique visitors (30 days)"
                value={formatCount(stats.data.uniqueVisitors30d)}
                hint="Daily privacy-preserving identifiers"
              />
              <EngagementMetric
                label="Top measured issue"
                value={
                  stats.data.topIssueViews === null
                    ? "None"
                    : formatCount(stats.data.topIssueViews)
                }
                hint={
                  stats.data.topIssueSubject ??
                  "No measured issue in this window"
                }
              />
            </div>
            {stats.data.totalIssues === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground" role="status">
                Verified empty: the archive statistics request succeeded and
                reported no published issues.
              </p>
            ) : null}
          </>
        )}
      </EngagementSurface>

      <EngagementSurface
        id="ar-issues"
        title="Published issues"
        description="Search and inspect the authenticated archive projection. Preview HTML loads only when you choose an issue."
      >
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1 space-y-2">
            <Label htmlFor="archive-issue-search">
              Search published issues
            </Label>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                ref={searchInputRef}
                id="archive-issue-search"
                type="search"
                aria-describedby="archive-issue-search-hint"
                value={searchInput}
                maxLength={200}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="min-h-11 pl-9 pr-11"
                placeholder="Search subject or archive slug"
                onChange={(event) => setSearchInput(event.target.value)}
              />
              {searchInput ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-1/2 min-h-11 -translate-y-1/2"
                  aria-label="Clear archive search"
                  onClick={() => {
                    setSearchInput("");
                    setSearch("");
                    searchInputRef.current?.focus();
                  }}
                >
                  <X aria-hidden />
                </Button>
              ) : null}
            </div>
            <p
              id="archive-issue-search-hint"
              className="text-xs leading-relaxed text-muted-foreground"
            >
              Search published subjects or slugs. Avoid entering private
              identifiers in this URL-based search.
            </p>
          </div>
        </div>

        <div className="mt-4" aria-busy={issues.isFetching}>
          {issues.isPending ? (
            <EngagementLoading
              label="Loading published archive issues"
              rows={5}
            />
          ) : issues.isError && !issues.data ? (
            <EngagementQueryError
              title="Published issues could not be loaded"
              description="The archive list is unknown; an empty archive is not being inferred."
              retrying={issues.isFetching}
              onRetry={() => void issues.refetch()}
            />
          ) : issues.isRefetchError && !issues.isFetchNextPageError ? (
            <EngagementQueryError
              title="Published issues could not be refreshed"
              description="Previously loaded results are not being presented as a newly verified archive snapshot."
              retrying={issues.isFetching}
              onRetry={() => void issues.refetch()}
            />
          ) : rows.length === 0 ? (
            <EngagementEmpty
              title={
                search ? "No matching published issues" : "No published issues"
              }
              description={
                search
                  ? "The authenticated search completed successfully with no matches. Clear or change the search to inspect other issues."
                  : "The authenticated archive list completed successfully and is verified empty."
              }
            />
          ) : (
            <>
              <ul
                className="divide-y rounded-lg border"
                aria-label="Published archive issues"
              >
                {rows.map((row) => (
                  <li
                    key={`${row.slug}:${row.publishedAt}`}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="break-words font-medium">
                          {row.subject || "Untitled archive issue"}
                        </p>
                        {row.pinned ? (
                          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                            Featured
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {row.slug}
                      </p>
                      {row.excerpt ? (
                        <p className="mt-2 line-clamp-2 break-words text-sm leading-relaxed text-muted-foreground">
                          {row.excerpt}
                        </p>
                      ) : null}
                      <p className="mt-2 text-xs text-muted-foreground">
                        <time dateTime={row.publishedAt}>
                          {formatPublishedAt(row.publishedAt)}
                        </time>
                        {" · "}
                        {formatCount(row.viewCount)} views ·{" "}
                        {formatCount(row.uniqueVisitors)} unique
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      {canFeature ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-11"
                          loading={pinningCampaignId === row.campaignId}
                          disabled={
                            pinningCampaignId !== null &&
                            pinningCampaignId !== row.campaignId
                          }
                          onClick={() => void toggleFeatured(row)}
                        >
                          {row.pinned ? (
                            <PinOff aria-hidden />
                          ) : (
                            <Pin aria-hidden />
                          )}
                          {row.pinned ? "Unfeature" : "Feature"}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => setSelected(row)}
                      >
                        <Eye aria-hidden />
                        Inspect safely
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>

              {pinError ? (
                <div
                  role="alert"
                  className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-emphasis"
                >
                  {pinError}
                </div>
              ) : null}

              {issues.isFetchNextPageError ? (
                <div className="mt-4">
                  <EngagementQueryError
                    title="The next archive page could not be loaded"
                    description="Already loaded issues remain visible. Retry to continue from the verified cursor."
                    retrying={issues.isFetchingNextPage}
                    onRetry={() =>
                      void loadNextQueryPage(issues, issues.isEnabled)
                    }
                  />
                </div>
              ) : issues.hasNextPage ? (
                <div className="mt-4 flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    loading={issues.isFetchingNextPage}
                    onClick={() =>
                      void loadNextQueryPage(issues, issues.isEnabled)
                    }
                  >
                    Load more issues
                  </Button>
                </div>
              ) : (
                <p
                  className="mt-4 text-center text-xs text-muted-foreground"
                  role="status"
                >
                  All verified results are loaded.
                </p>
              )}
            </>
          )}
        </div>
      </EngagementSurface>

      <EngagementSurface
        id="ar-private-podcast"
        title="Private podcast"
        description="Per-subscriber tokenized RSS feeds for premium audio episodes."
      >
        <PodcastTokensCard me={me} />
      </EngagementSurface>

      <div
        className="rounded-xl border border-warning/30 bg-warning/5 p-4 text-sm leading-relaxed"
        role="note"
      >
        <p className="font-medium">Public-delivery controls remain held</p>
        <p className="mt-1 text-muted-foreground">
          Publishing, editing, comments, and private-feed controls are
          intentionally unavailable on web pending delivery and policy review.
          This surface cannot make an issue public — featuring only reorders
          issues that are already published.
        </p>
      </div>

      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>

      <PreviewDialog
        selected={selected}
        previewKey={previewKey}
        canUnpublish={canUnpublish}
        onClose={() => setSelected(null)}
        onRequestUnpublish={(row, preview) => {
          setSelected(null);
          setUnpublishTarget({ row, preview });
        }}
      />

      <ConfirmDialog
        open={unpublishTarget !== null}
        onOpenChange={(open) => {
          if (!open) setUnpublishTarget(null);
        }}
        returnFocusRef={searchInputRef}
        fallbackFocusRef={searchInputRef}
        title="Emergency unpublish archive issue?"
        description={
          <>
            This removes <strong>{unpublishTarget?.row.subject}</strong> from
            the public archive. It does not delete the campaign. Your identity
            and the issue identity will be verified again before the request.
          </>
        }
        confirmationToken={
          unpublishTarget ? `UNPUBLISH ${unpublishTarget.row.slug}` : undefined
        }
        confirmLabel="Unpublish issue"
        confirmVariant="destructive"
        onConfirm={confirmUnpublish}
      />
    </div>
  );
}
