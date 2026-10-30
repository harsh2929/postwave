import { type ReactElement, useState } from "react";

import { useTabsInteraction } from "../../hooks/useTabsInteraction";
import type { ArchiveIssue } from "../../lib/api-client";
import {
  ARCHIVE_COMMENTS_AVAILABLE,
  ARCHIVE_COMMENTS_UNAVAILABLE_REASON,
  ARCHIVE_PRIVATE_PODCAST_AVAILABLE,
  ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON,
  ARCHIVE_PUBLIC_DELIVERY_AVAILABLE,
  ARCHIVE_PUBLIC_DELIVERY_UNAVAILABLE_REASON,
} from "../../lib/archive-operational-availability";
import { fmtDate } from "../../lib/format-date";
import { StatStrip, type StatCell } from "../StatStrip";
import { CommentsModerationCard } from "./CommentsModerationCard";
import { PodcastTokensCard } from "./PodcastTokensCard";

import "../../styles-archive.css";

type ArchiveWorkspace = "issues" | "comments" | "private-feeds";

const ARCHIVE_WORKSPACES: ReadonlyArray<{
  id: ArchiveWorkspace;
  label: string;
}> = [
  { id: "issues", label: "Issues" },
  { id: "comments", label: "Comments" },
  { id: "private-feeds", label: "Private feeds" },
];

const ARCHIVE_TAB_ITEMS = ARCHIVE_WORKSPACES.map(({ id }) => ({
  value: id,
}));

export function archiveIssueUrl(indexBase: string, issueSlug: string): string {
  return issueSlug
    ? `${indexBase}/${encodeURIComponent(issueSlug)}`
    : indexBase;
}

export function formatArchiveCount(value: number | undefined): string {
  if (!value) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function ArchiveGlyph(): ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="5" rx="1.5" />
      <path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M9 13h6" />
    </svg>
  );
}

function SearchIcon(): ReactElement {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </svg>
  );
}

function RefreshIcon(): ReactElement {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 7v5h-5" />
      <path d="M4 17v-5h5" />
      <path d="M6.1 9A7 7 0 0 1 18 6l2 1" />
      <path d="M17.9 15A7 7 0 0 1 6 18l-2-1" />
    </svg>
  );
}

function LinkIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" />
    </svg>
  );
}

function DetailIcon(): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function ShieldIcon(): ReactElement {
  return (
    <svg
      width="19"
      height="19"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6Z" />
      <path d="m9.5 12 1.7 1.7 3.7-4" />
    </svg>
  );
}

export function ArchivePinIcon({
  filled = false,
}: {
  filled?: boolean;
}): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z" />
    </svg>
  );
}

interface ArchiveRowActionsProps {
  busy: boolean;
  canMutate: boolean;
  issue: ArchiveIssue;
  pinning: boolean;
  publicUrl: string | null;
  onOpenUrl: (url: string) => void;
  onPin: () => void;
  onView: () => void;
}

function ArchiveRowActions({
  busy,
  canMutate,
  issue,
  pinning,
  publicUrl,
  onOpenUrl,
  onPin,
  onView,
}: ArchiveRowActionsProps): ReactElement {
  const subject = issue.subject || "untitled issue";
  const pinLabel = issue.pinned ? "Unpin" : "Pin";

  return (
    <div className="arc-row-actions" aria-label={`Actions for ${subject}`}>
      <button
        type="button"
        className="arc-row-action"
        aria-label={`Open ${subject} in browser`}
        aria-disabled={!publicUrl || undefined}
        aria-describedby={
          publicUrl ? undefined : "archive-public-url-availability"
        }
        onClick={() => {
          if (publicUrl) onOpenUrl(publicUrl);
        }}
      >
        <LinkIcon />
        <span>Open</span>
      </button>
      <button
        type="button"
        className={`arc-row-action${issue.pinned ? " is-pinned" : ""}`}
        aria-label={`${pinning ? `${pinLabel}ning` : pinLabel} ${subject}`}
        aria-disabled={!canMutate || undefined}
        aria-describedby={canMutate ? undefined : "archive-write-availability"}
        aria-busy={pinning || undefined}
        disabled={busy}
        onClick={() => {
          if (canMutate) onPin();
        }}
      >
        <ArchivePinIcon filled={!!issue.pinned} />
        <span>{pinning ? "Working…" : pinLabel}</span>
      </button>
      <button
        type="button"
        className="arc-row-action"
        aria-label={`${canMutate ? "Edit" : "View details for"} ${subject}`}
        aria-describedby={canMutate ? undefined : "archive-write-availability"}
        onClick={onView}
      >
        <DetailIcon />
        <span>{canMutate ? "Edit" : "View"}</span>
      </button>
    </div>
  );
}

interface ArchiveIssueTableProps {
  canPublish: boolean;
  canMutate: boolean;
  indexBase: string | null;
  listBusy: boolean;
  loading: boolean;
  page: number;
  pageRows: ArchiveIssue[];
  pinningSlug: string | null;
  query: string;
  totalPages: number;
  onOpenPublish: () => void;
  onOpenUrl: (url: string) => void;
  onPageChange: (page: number) => void;
  onPin: (issue: ArchiveIssue) => void;
  onSelect: (issue: ArchiveIssue) => void;
  onQueryChange: (query: string) => void;
}

function ArchiveLoadingTable(): ReactElement {
  return (
    <div
      className="arc-loading-table"
      role="status"
      aria-label="Loading archive issues"
    >
      <span className="visually-hidden">Loading archive issues…</span>
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="arc-loading-row" aria-hidden="true">
          <span className="arc-skeleton arc-skeleton-title" />
          <span className="arc-skeleton arc-skeleton-slug" />
          <span className="arc-skeleton arc-skeleton-compact" />
          <span className="arc-skeleton arc-skeleton-date" />
          <span className="arc-skeleton arc-skeleton-actions" />
        </div>
      ))}
    </div>
  );
}

function ArchiveIssueEmptyState({
  canPublish,
  canMutate,
  query,
  onOpenPublish,
  onQueryChange,
}: Pick<
  ArchiveIssueTableProps,
  "canPublish" | "canMutate" | "query" | "onOpenPublish" | "onQueryChange"
>): ReactElement {
  const hasQuery = query.trim().length > 0;
  return (
    <section className="arc-empty" aria-labelledby="archive-empty-title">
      <div className="arc-empty-icon" aria-hidden="true">
        {hasQuery ? <SearchIcon /> : <ArchiveGlyph />}
      </div>
      <p className="arc-kicker">{hasQuery ? "No results" : "Clean slate"}</p>
      <h3 id="archive-empty-title">
        {hasQuery
          ? `No issues match “${query}”`
          : "Your issue catalog is ready for its first publication."}
      </h3>
      <p>
        {hasQuery
          ? "Try a shorter title or slug, or clear the search to return to the full catalog."
          : "Published campaigns will appear here with their permalink, reach, publication date, and review actions."}
      </p>
      <div className="arc-empty-actions">
        {hasQuery ? (
          <button
            type="button"
            className="btn"
            onClick={() => onQueryChange("")}
          >
            Clear search
          </button>
        ) : canPublish && canMutate ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onOpenPublish}
          >
            Publish from campaign
          </button>
        ) : null}
      </div>
    </section>
  );
}

function ArchiveIssueTable({
  canPublish,
  canMutate,
  indexBase,
  listBusy,
  loading,
  page,
  pageRows,
  pinningSlug,
  query,
  totalPages,
  onOpenPublish,
  onOpenUrl,
  onPageChange,
  onPin,
  onSelect,
  onQueryChange,
}: ArchiveIssueTableProps): ReactElement {
  if (loading) return <ArchiveLoadingTable />;

  if (pageRows.length === 0) {
    return (
      <ArchiveIssueEmptyState
        canPublish={canPublish}
        canMutate={canMutate}
        query={query}
        onOpenPublish={onOpenPublish}
        onQueryChange={onQueryChange}
      />
    );
  }

  return (
    <>
      <div className="arc-table-shell">
        <table className="arc-table" aria-label="Published archive issues">
          <caption className="visually-hidden">
            Published archive issues and their management actions
          </caption>
          <thead>
            <tr>
              <th scope="col">Issue</th>
              <th scope="col">Permalink</th>
              <th scope="col" className="arc-number-heading">
                30-day views
              </th>
              <th scope="col">Published</th>
              <th scope="col" className="arc-actions-heading">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((issue, index) => {
              const publicUrl =
                indexBase && issue.slug
                  ? archiveIssueUrl(indexBase, issue.slug)
                  : null;
              const subject = issue.subject || "Untitled issue";
              const key =
                issue.campaignId ??
                issue.campaign_id ??
                issue.id ??
                `${issue.slug}-${index}`;

              return (
                <tr key={String(key)}>
                  <td data-label="Issue" className="arc-issue-cell">
                    <button
                      type="button"
                      className="arc-issue-title"
                      onClick={() => onSelect(issue)}
                    >
                      {subject}
                    </button>
                    <span className="arc-issue-meta">
                      {issue.pinned ? (
                        <span className="arc-pin-badge">Pinned</span>
                      ) : (
                        "Published issue"
                      )}
                    </span>
                  </td>
                  <td data-label="Permalink" className="arc-slug-cell">
                    {issue.slug ? <code>/{issue.slug}</code> : <span>—</span>}
                  </td>
                  <td
                    data-label="30-day views"
                    className="arc-number-cell tabular"
                  >
                    {typeof issue.viewCount === "number"
                      ? formatArchiveCount(issue.viewCount)
                      : "—"}
                  </td>
                  <td data-label="Published" className="arc-date-cell tabular">
                    {issue.publishedAt ? (
                      <time dateTime={issue.publishedAt}>
                        {fmtDate(issue.publishedAt)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td data-label="Actions" className="arc-actions-cell">
                    <ArchiveRowActions
                      issue={issue}
                      publicUrl={publicUrl}
                      canMutate={canMutate}
                      busy={listBusy}
                      pinning={pinningSlug === issue.slug}
                      onOpenUrl={onOpenUrl}
                      onPin={() => onPin(issue)}
                      onView={() => onSelect(issue)}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {totalPages > 1 ? (
        <nav className="arc-pagination" aria-label="Archive issue pages">
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1}
            onClick={() => onPageChange(Math.max(1, page - 1))}
          >
            Previous
          </button>
          <span aria-current="page">
            Page {page.toLocaleString()} of {totalPages.toLocaleString()}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= totalPages}
            onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          >
            Next
          </button>
        </nav>
      ) : null}
    </>
  );
}

function ArchiveDistributionMap({
  linksReady,
  publicDeliveryReady,
}: {
  linksReady: boolean;
  publicDeliveryReady: boolean;
}): ReactElement {
  return (
    <div className="arc-distribution" aria-hidden="true">
      <div className="arc-distribution-label">Publication path</div>
      <div className="arc-distribution-map">
        <div className="arc-distribution-node arc-distribution-source">
          <span className="arc-distribution-icon">
            <ArchiveGlyph />
          </span>
          <span>
            <small>Source</small>
            <strong>Issue catalog</strong>
          </span>
        </div>
        <span className="arc-distribution-line">
          <i />
        </span>
        <div
          className={`arc-distribution-destinations${linksReady ? " is-ready" : ""}`}
        >
          <span>Web archive</span>
          <span>RSS feed</span>
          <span>Search index</span>
        </div>
      </div>
      <div className="arc-distribution-foot">
        <span className="arc-status-dot" />
        {linksReady
          ? "Public-link configuration detected"
          : publicDeliveryReady
            ? "Public links require archive setup"
            : "Public delivery is review-gated"}
      </div>
    </div>
  );
}

function ArchiveHero({
  canPublish = false,
  canMutate,
  err,
  indexBase,
  loading,
  publicDeliveryReady = false,
  rows,
  onOpenPublish,
  onRefresh,
}: Pick<
  ArchivePageContentProps,
  | "canMutate"
  | "canPublish"
  | "err"
  | "indexBase"
  | "loading"
  | "publicDeliveryReady"
  | "rows"
  | "onOpenPublish"
  | "onRefresh"
>): ReactElement {
  const initialLoading = rows === null;
  const refreshing = loading && rows !== null;
  const status = err
    ? "Needs attention"
    : initialLoading
      ? "Loading catalog"
      : refreshing
        ? "Refreshing"
        : !canMutate
          ? "Review access"
          : !publicDeliveryReady
            ? "Delivery review-gated"
            : indexBase
              ? "Catalog connected"
              : "Setup required";

  return (
    <header className="arc-hero">
      <div className="arc-hero-copy">
        <div className="arc-eyebrow">
          <span className="arc-eyebrow-icon">
            <ArchiveGlyph />
          </span>
          Distribution / Archive
        </div>
        <div className="arc-hero-status" role="status">
          <span className="arc-status-dot" />
          {status}
        </div>
        <h1>Give every issue a useful life after send.</h1>
        <p>
          Review the publication catalog, inspect reader reach, and keep every
          permalink deliberate from one calm workspace.
        </p>
        <div className="arc-hero-actions">
          <button
            type="button"
            className="btn btn-primary"
            aria-disabled={!canPublish || undefined}
            aria-describedby={
              canPublish ? undefined : "archive-publish-availability"
            }
            onClick={() => {
              if (canPublish) onOpenPublish();
            }}
          >
            Publish from campaign
          </button>
          <button
            type="button"
            className="btn"
            aria-busy={refreshing || undefined}
            disabled={initialLoading || loading}
            onClick={onRefresh}
          >
            <RefreshIcon />
            {refreshing ? "Refreshing…" : "Refresh catalog"}
          </button>
        </div>
      </div>
      <ArchiveDistributionMap
        linksReady={publicDeliveryReady && !!indexBase}
        publicDeliveryReady={publicDeliveryReady}
      />
    </header>
  );
}

function ArchivePublicControls({
  indexBase,
  publicDeliveryReady = false,
  publicIndexUrl,
  query,
  rssUrl,
  sitemapUrl,
  onCopy,
  onOpenUrl,
  onQueryChange,
}: Pick<
  ArchivePageContentProps,
  | "indexBase"
  | "publicDeliveryReady"
  | "publicIndexUrl"
  | "query"
  | "rssUrl"
  | "sitemapUrl"
  | "onCopy"
  | "onOpenUrl"
  | "onQueryChange"
>): ReactElement {
  const linksReady =
    publicDeliveryReady && ARCHIVE_PUBLIC_DELIVERY_AVAILABLE && !!indexBase;
  const unavailableProps = {
    "aria-disabled": linksReady ? undefined : ("true" as const),
    "aria-describedby": "archive-public-url-availability",
  };
  const copy = (value: string, confirmation: string): void => {
    if (linksReady) onCopy(value, confirmation);
  };

  return (
    <div className="arc-controls">
      <label className="arc-search" htmlFor="archive-search">
        <span>Search issues</span>
        <span className="arc-search-field">
          <SearchIcon />
          <input
            id="archive-search"
            name="archive_search"
            type="search"
            placeholder="Title or permalink…"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="arc-search-clear"
              aria-label="Clear archive search"
              onClick={() => onQueryChange("")}
            >
              Clear
            </button>
          ) : null}
        </span>
      </label>
      <div className="arc-public-tools">
        <div
          id="archive-public-url-availability"
          className={`arc-link-status${linksReady ? " is-ready" : ""}`}
          role="status"
        >
          <span className="arc-status-dot" />
          <span>
            <strong>
              {linksReady
                ? "Public links ready"
                : publicDeliveryReady
                  ? "Links need setup"
                  : "Public delivery review-gated"}
            </strong>
            <small>
              {linksReady
                ? indexBase
                : publicDeliveryReady
                  ? "Add an archive slug in Settings to enable sharing."
                  : ARCHIVE_PUBLIC_DELIVERY_UNAVAILABLE_REASON}
            </small>
          </span>
        </div>
        <div className="arc-public-actions" aria-label="Public archive links">
          <button
            type="button"
            className="btn btn-sm"
            {...unavailableProps}
            onClick={() => copy(publicIndexUrl, "Public archive URL copied")}
          >
            Copy URL
          </button>
          <button
            type="button"
            className="btn btn-sm"
            {...unavailableProps}
            onClick={() => copy(rssUrl, "RSS feed URL copied")}
          >
            Copy RSS
          </button>
          <button
            type="button"
            className="btn btn-sm"
            {...unavailableProps}
            onClick={() => copy(sitemapUrl, "Sitemap URL copied")}
          >
            Copy sitemap
          </button>
          <button
            type="button"
            className="btn btn-sm"
            {...unavailableProps}
            onClick={() => {
              if (linksReady && indexBase) onOpenUrl(indexBase);
            }}
          >
            <LinkIcon />
            Open archive
          </button>
        </div>
      </div>
    </div>
  );
}

function ReviewGatePanel({
  kind,
}: {
  kind: "comments" | "private-feeds";
}): ReactElement {
  const comments = kind === "comments";
  return (
    <section className="arc-review-gate" aria-labelledby={`${kind}-gate-title`}>
      <div className="arc-review-gate-icon">
        <ShieldIcon />
      </div>
      <div className="arc-review-gate-copy">
        <div className="arc-review-gate-meta">
          <span className="arc-kicker">Release safety</span>
          <span className="arc-review-badge">Review gated</span>
        </div>
        <h2 id={`${kind}-gate-title`}>
          {comments
            ? "Comment moderation is held back."
            : "Private feed access is held back."}
        </h2>
        <p>
          {comments
            ? ARCHIVE_COMMENTS_UNAVAILABLE_REASON
            : ARCHIVE_PRIVATE_PODCAST_UNAVAILABLE_REASON}
        </p>
        <ul className="arc-gate-checklist">
          {comments ? (
            <>
              <li>Role checks must match every server mutation.</li>
              <li>Stale requests must never replace newer moderation state.</li>
              <li>Every decision needs recoverable operator history.</li>
            </>
          ) : (
            <>
              <li>Issued tokens must never be recoverable after reveal.</li>
              <li>Revocation and expiry need complete audit evidence.</li>
              <li>Feed URLs must be protected from logs and referrers.</li>
            </>
          )}
        </ul>
        <p className="arc-review-note">
          No reader content or credentials are changed from this workspace while
          the review gate is active.
        </p>
      </div>
    </section>
  );
}

interface AdvancedArchivePanelsProps {
  canAdmin: boolean;
  canMutate: boolean;
  cidBySlug: Record<string, string>;
  commentsIssueId: string;
  rows: ArchiveIssue[] | null;
  workspace: ArchiveWorkspace;
  onCommentsIssueChange: (campaignId: string) => void;
  onFindCampaign: (issue: ArchiveIssue) => string | null;
}

function AdvancedArchivePanel({
  canAdmin,
  canMutate,
  cidBySlug,
  commentsIssueId,
  rows,
  workspace,
  onCommentsIssueChange,
  onFindCampaign,
}: AdvancedArchivePanelsProps): ReactElement {
  const commentsAvailable = canAdmin && canMutate && ARCHIVE_COMMENTS_AVAILABLE;
  const privateFeedsAvailable =
    canAdmin && canMutate && ARCHIVE_PRIVATE_PODCAST_AVAILABLE;

  if (workspace === "comments") {
    if (!commentsAvailable) return <ReviewGatePanel kind="comments" />;

    return (
      <section className="arc-advanced-panel">
        <label className="arc-select-field" htmlFor="archive-comments-issue">
          <span>Moderate comments for</span>
          <select
            id="archive-comments-issue"
            className="input"
            value={commentsIssueId}
            onChange={(event) => onCommentsIssueChange(event.target.value)}
          >
            <option value="">All issues</option>
            {(rows ?? []).map((issue) => {
              const campaignId = cidBySlug[issue.slug] ?? onFindCampaign(issue);
              if (!campaignId) return null;
              return (
                <option key={`${campaignId}-${issue.slug}`} value={campaignId}>
                  {issue.subject || issue.slug || "(untitled)"}
                </option>
              );
            })}
          </select>
        </label>
        <CommentsModerationCard
          key={commentsIssueId || "all"}
          campaignId={commentsIssueId || undefined}
        />
      </section>
    );
  }

  if (!privateFeedsAvailable) return <ReviewGatePanel kind="private-feeds" />;

  return (
    <section className="arc-advanced-panel">
      <PodcastTokensCard canMutate={canAdmin} />
    </section>
  );
}

export interface ArchivePageContentProps extends Omit<
  ArchiveIssueTableProps,
  "canPublish" | "onQueryChange"
> {
  canAdmin: boolean;
  canPublish?: boolean;
  cidBySlug: Record<string, string>;
  commentsIssueId: string;
  err: string | null;
  filteredCount: number;
  publicIndexUrl: string;
  publicDeliveryReady?: boolean;
  rows: ArchiveIssue[] | null;
  rssUrl: string;
  sitemapUrl: string;
  statCells: StatCell[];
  onCommentsIssueChange: (campaignId: string) => void;
  onCopy: (value: string, confirmation: string) => void;
  onFindCampaign: (issue: ArchiveIssue) => string | null;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
}

export function ArchivePageContent({
  canAdmin,
  canPublish = false,
  canMutate,
  cidBySlug,
  commentsIssueId,
  err,
  filteredCount,
  indexBase,
  listBusy,
  loading,
  page,
  pageRows,
  pinningSlug,
  publicIndexUrl,
  publicDeliveryReady = false,
  query,
  rows,
  rssUrl,
  sitemapUrl,
  statCells,
  totalPages,
  onCommentsIssueChange,
  onCopy,
  onFindCampaign,
  onOpenPublish,
  onOpenUrl,
  onPageChange,
  onPin,
  onQueryChange,
  onRefresh,
  onSelect,
}: ArchivePageContentProps): ReactElement {
  const [workspace, setWorkspace] = useState<ArchiveWorkspace>("issues");
  const tabs = useTabsInteraction<ArchiveWorkspace>({
    activation: "manual",
    items: ARCHIVE_TAB_ITEMS,
    onChange: setWorkspace,
    value: workspace,
  });
  const effectivePublicDeliveryReady =
    publicDeliveryReady && ARCHIVE_PUBLIC_DELIVERY_AVAILABLE;
  const effectiveCanPublish = canPublish && effectivePublicDeliveryReady;
  const initialLoading = rows === null;
  const refreshing = loading && rows !== null;
  const resultSummary = initialLoading
    ? "Loading issue catalog…"
    : query
      ? `${filteredCount.toLocaleString()} ${filteredCount === 1 ? "match" : "matches"} for “${query}”`
      : `${filteredCount.toLocaleString()} published ${filteredCount === 1 ? "issue" : "issues"}`;

  return (
    <div className="arc-page">
      <ArchiveHero
        canPublish={effectiveCanPublish}
        canMutate={canMutate}
        err={err}
        indexBase={indexBase}
        loading={loading}
        publicDeliveryReady={effectivePublicDeliveryReady}
        rows={rows}
        onOpenPublish={onOpenPublish}
        onRefresh={onRefresh}
      />
      {!effectiveCanPublish ? (
        <div
          id="archive-publish-availability"
          className="arc-release-note"
          role="status"
        >
          <ShieldIcon />
          <span>
            <strong>Publication is review-gated</strong>
            {ARCHIVE_PUBLIC_DELIVERY_UNAVAILABLE_REASON}
          </span>
        </div>
      ) : null}

      <div className="arc-stat-strip">
        <StatStrip cells={statCells} />
      </div>

      <div
        ref={tabs.listRef}
        {...tabs.listProps}
        className="arc-workspace-tabs"
        aria-label="Archive workspaces"
      >
        {ARCHIVE_WORKSPACES.map((item) => {
          const selected = workspace === item.id;
          const isGated = item.id !== "issues";
          return (
            <button
              key={item.id}
              type="button"
              {...tabs.getTabProps(item.id)}
              className={selected ? "is-selected" : undefined}
            >
              <span>{item.label}</span>
              {item.id === "issues" ? (
                <small>
                  {initialLoading ? "…" : filteredCount.toLocaleString()}
                </small>
              ) : isGated ? (
                <small>Review gated</small>
              ) : null}
            </button>
          );
        })}
      </div>

      <section
        {...tabs.getPanelProps("issues")}
        className="arc-workspace-panel"
      >
        {!canMutate ? (
          <div
            id="archive-write-availability"
            className="arc-access-note"
            role="status"
          >
            <ShieldIcon />
            <span>
              <strong>
                {canAdmin
                  ? "Catalog changes review-gated"
                  : "Review-only access"}
              </strong>
              {canAdmin
                ? "Publishing, editing, and pinning remain frozen. Issue details retain an admin-only unpublish action for removing existing public exposure."
                : "Your role can inspect issue details. Publishing, pinning, editing, and unpublishing require owner or admin access."}
            </span>
          </div>
        ) : null}

        <section
          className="arc-catalog"
          aria-labelledby="archive-catalog-title"
        >
          <header className="arc-section-heading">
            <div>
              <p className="arc-kicker">Publication catalog</p>
              <h2 id="archive-catalog-title">Issues</h2>
              <p
                className="arc-result-summary"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {refreshing ? `Refreshing — ${resultSummary}` : resultSummary}
              </p>
            </div>
            {refreshing ? (
              <span className="arc-refresh-indicator" aria-hidden="true">
                <RefreshIcon />
              </span>
            ) : null}
          </header>

          <ArchivePublicControls
            indexBase={indexBase}
            publicIndexUrl={publicIndexUrl}
            publicDeliveryReady={effectivePublicDeliveryReady}
            query={query}
            rssUrl={rssUrl}
            sitemapUrl={sitemapUrl}
            onCopy={onCopy}
            onOpenUrl={onOpenUrl}
            onQueryChange={onQueryChange}
          />

          {err ? (
            <div className="arc-error" role="alert">
              <span className="arc-error-mark" aria-hidden="true">
                !
              </span>
              <span>
                <strong>
                  {rows
                    ? "Some archive data is unavailable."
                    : "Archive data could not be loaded."}
                </strong>
                {rows
                  ? ` The issue catalog remains visible. ${err}`
                  : ` No catalog data is available yet. ${err}`}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={loading}
                onClick={onRefresh}
              >
                {loading ? "Retrying…" : "Try again"}
              </button>
            </div>
          ) : null}

          {err && rows === null ? null : (
            <ArchiveIssueTable
              canPublish={effectiveCanPublish}
              canMutate={canMutate}
              indexBase={effectivePublicDeliveryReady ? indexBase : null}
              listBusy={listBusy}
              loading={initialLoading}
              page={page}
              pageRows={pageRows}
              pinningSlug={pinningSlug}
              query={query}
              totalPages={totalPages}
              onOpenPublish={onOpenPublish}
              onOpenUrl={onOpenUrl}
              onPageChange={onPageChange}
              onPin={onPin}
              onQueryChange={onQueryChange}
              onSelect={onSelect}
            />
          )}
        </section>
      </section>

      {ARCHIVE_WORKSPACES.filter((item) => item.id !== "issues").map((item) => (
        <section
          key={item.id}
          {...tabs.getPanelProps(item.id)}
          className="arc-workspace-panel"
        >
          {workspace === item.id ? (
            <AdvancedArchivePanel
              canAdmin={canAdmin}
              canMutate={canMutate}
              cidBySlug={cidBySlug}
              commentsIssueId={commentsIssueId}
              rows={rows}
              workspace={item.id}
              onCommentsIssueChange={onCommentsIssueChange}
              onFindCampaign={onFindCampaign}
            />
          ) : null}
        </section>
      ))}
    </div>
  );
}
