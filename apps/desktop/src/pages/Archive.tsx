/**
 * Archive — published-newsletter admin.
 *
 * Lists every campaign that's been flipped `archive_public=true` for the
 * current tenant. From here an operator can:
 *   - Publish a completed campaign snapshot to the public archive.
 *   - Edit the slug + excerpt of an already-published issue.
 *   - Unpublish (with confirmation).
 *   - Hop to the public Substack-style web view via the link icon.
 *
 * Backend surface (apps/api/internal/archive/archive.go):
 *   GET   /api/v1/archive
 *   POST  /api/v1/campaigns/{id}/publish-archive       {slug, excerpt}
 *   POST  /api/v1/campaigns/{id}/unpublish-archive
 *
 * Shape note: the authenticated archive list returns the canonical campaign
 * UUID alongside its public slug. Mutations must use that UUID and never infer
 * identity from a mutable or non-unique subject line.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ClippingMeter } from "../components/archive/ClippingMeter";
import {
  ArchivePageContent,
  ArchivePinIcon as PinIcon,
  archiveIssueUrl,
  formatArchiveCount,
} from "../components/archive/ArchivePageContent";
import { SlideoverShell } from "../components/SlideoverShell";

import { InlineHelp } from "../components/InlineHelp";
import { ConfirmModal } from "../components/ConfirmModal";
import { Modal, ModalFooter } from "../components/Modal";
import { SectionHeader } from "../components/SectionHeader";
import type { StatCell } from "../components/StatStrip";
import { toast } from "../components/Toast";
import {
  type ArchiveIssue,
  type ArchiveIssuePreview,
  type ArchiveStats,
  type ArchiveTenantSettings,
  type Campaign,
  api,
} from "../lib/api-client";
import { fmtDate } from "../lib/format-date";
import { writeClipboardText } from "../lib/clipboard";
import { useCanAdmin } from "../lib/store";
import { tauriApi } from "../lib/tauri";
import { ARCHIVE_PUBLIC_DELIVERY_AVAILABLE } from "../lib/archive-operational-availability";
import { parseArchiveListResponse } from "../lib/api/archive-referral-operations";
import {
  type PersistentLifecycleOperation,
  usePersistentLifecycleOperation,
} from "../hooks/usePersistentLifecycleOperation";
import {
  lifecycleOperationError,
  useDiscardOnlyDraftLifecycle,
  useExistingSettingLifecycle,
  useSingleFlightOperation,
} from "../hooks/useSettingsDraftLifecycle";
import "../styles-action-availability.css";

const PAGE_SIZE = 25;

/* ---------- helpers --------------------------------------------------- */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function isAbsoluteWebUrl(value: string): boolean {
  if (!value.trim()) return true;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      Boolean(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function parseArchiveCampaignCandidates(value: unknown): Campaign[] {
  let candidates: unknown[];
  if (Array.isArray(value)) {
    candidates = value;
  } else if (value && typeof value === "object") {
    const envelope = value as Record<string, unknown>;
    const presentCollection = ["items", "results", "data"].find(
      (key) => envelope[key] !== undefined,
    );
    if (!presentCollection) return [];
    const collection = envelope[presentCollection];
    if (!Array.isArray(collection)) {
      throw new Error(
        `Campaign lookup returned a non-array “${presentCollection}” collection.`,
      );
    }
    candidates = collection;
  } else {
    throw new Error("Campaign lookup returned an invalid response envelope.");
  }

  return candidates.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error(`Campaign result ${index + 1} is not an object.`);
    }
    const record = candidate as Record<string, unknown>;
    const idIsValid =
      (typeof record.id === "string" && record.id.trim().length > 0) ||
      (typeof record.id === "number" && Number.isFinite(record.id));
    if (!idIsValid || typeof record.status !== "string") {
      throw new Error(
        `Campaign result ${index + 1} is missing a valid id or status.`,
      );
    }
    for (const key of ["subject", "name"] as const) {
      if (record[key] !== undefined && typeof record[key] !== "string") {
        throw new Error(
          `Campaign result ${index + 1} has an invalid ${key} field.`,
        );
      }
    }
    return candidate as Campaign;
  });
}

// D08-forms-assets-archive#4: the public archive is PATH-based on a single
// host — the backend builds `{PublicBaseURL}/{tenant_archive_slug}/{slug}`
// (ARCHIVE_PUBLIC_BASE_URL, default https://archive.moosewave.com), which is
// also the contract documented on ArchiveTenantSettings. The old
// `archive.{tenant}.moosewave.com` subdomain scheme matched nothing served,
// and its tenant slug came from a localStorage key no code ever wrote — so
// every URL was a placeholder. Resolve the real slug (+ optional vanity
// domain) from getArchiveTenantSettings instead.
const ARCHIVE_PUBLIC_HOST = "https://archive.moosewave.com";

/**
 * Resolve the tenant's public-archive index base, or null when no archive
 * slug is configured (the tenant has no public archive yet — callers must
 * then disable the "open / copy public URL" affordances rather than hand out
 * a dead link).
 */
function archiveIndexBase(
  settings: ArchiveTenantSettings | null,
): string | null {
  if (!settings) return null;
  const domain = (settings.archive_domain ?? "").trim();
  if (domain) {
    // Vanity host is CNAME'd to Moosewave and serves the tenant at its root.
    return `https://${domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`;
  }
  const slug = (settings.tenant_archive_slug ?? "").trim();
  if (!slug) return null;
  return `${ARCHIVE_PUBLIC_HOST}/${encodeURIComponent(slug)}`;
}

async function openArchiveUrl(url: string): Promise<void> {
  try {
    await tauriApi.openUrl(url);
  } catch (err) {
    toast.error(
      err instanceof Error ? err.message : "Could not open archive URL",
    );
  }
}

function buildArchiveStatCells(
  stats: ArchiveStats | null,
  rows: ArchiveIssue[] | null,
  publicIndexUrl: string,
): StatCell[] {
  return [
    {
      label: "Issues published",
      value:
        typeof stats?.totalIssues === "number"
          ? stats.totalIssues.toLocaleString()
          : rows
            ? rows.length.toLocaleString()
            : "—",
      hint: stats?.pinnedIssues
        ? `${stats.pinnedIssues} pinned to top of archive.`
        : "Every campaign flipped to archive-public.",
    },
    {
      label: "Views (30d)",
      value:
        typeof stats?.views30d === "number"
          ? formatArchiveCount(stats.views30d)
          : "—",
      hint: stats?.uniqueVisitors30d
        ? `${formatArchiveCount(stats.uniqueVisitors30d)} unique visitors in the last 30 days.`
        : "Page-view rollup from the public archive.",
    },
    {
      label: "Top issue (30d)",
      value:
        typeof stats?.topIssueViews === "number"
          ? formatArchiveCount(stats.topIssueViews)
          : "—",
      hint: stats?.topIssueSubject ?? "No views yet on any published issue.",
    },
    {
      label: "Last published",
      value: fmtDate(stats?.lastPublishedAt),
      hint: publicIndexUrl.replace(/^https?:\/\//, ""),
    },
  ];
}

async function copyArchiveValue(text: string, ok: string): Promise<void> {
  const result = await writeClipboardText(text, { contentClass: "public" });
  if (result.ok) toast.success(ok);
  else toast.error(result.message);
}

interface ArchiveOverview {
  rows: ArchiveIssue[];
  stats?: ArchiveStats | null;
  settings?: ArchiveTenantSettings | null;
  warnings: string[];
}

async function fetchArchiveOverview(): Promise<ArchiveOverview> {
  const rows: ArchiveIssue[] = [];
  let cursor: string | undefined;
  let remainingPages = 10;
  const warnings: string[] = [];
  while (remainingPages-- > 0) {
    const response = await api.listArchive({ cursor, limit: 100 });
    if (response.error) {
      throw new Error(response.error.message);
    }
    const payload = parseArchiveListResponse(response.data);
    rows.push(...payload.items);
    cursor = payload.nextCursor;
    if (!cursor) break;
  }
  if (cursor) {
    warnings.push(
      "Showing the newest 1,000 issues. Use a more specific search while full archive pagination is being completed.",
    );
  }
  const [stats, settings] = await Promise.all([
    api.getArchiveStats(),
    api.getArchiveTenantSettings(),
  ]);
  if (stats.error) {
    warnings.push(
      `Performance totals are temporarily unavailable: ${stats.error.message}`,
    );
  }
  if (settings.error) {
    warnings.push(
      `Public-link settings are temporarily unavailable: ${settings.error.message}`,
    );
  }
  return {
    rows,
    stats: stats.error ? undefined : (stats.data ?? null),
    settings: settings.error ? undefined : (settings.data ?? null),
    warnings,
  };
}

/* ---------- page ------------------------------------------------------ */

export function Archive(): ReactElement {
  // Archive publication changes are admin-scoped by the API route policy.
  // Keeping the renderer aligned avoids presenting editors with actions
  // that the server will correctly reject.
  const canAdmin = useCanAdmin();
  // Public-facing catalog edits remain frozen with delivery. Admins retain
  // only the containment action that removes an already-public issue.
  const canMutate = canAdmin && ARCHIVE_PUBLIC_DELIVERY_AVAILABLE;
  const canUnpublish = canAdmin;
  const canPublish = canAdmin && ARCHIVE_PUBLIC_DELIVERY_AVAILABLE;
  const [rows, setRows] = useState<ArchiveIssue[] | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [stats, setStats] = useState<ArchiveStats | null>(null);
  // D08#4: real public-archive config (slug + optional vanity domain), used
  // to build path-based public URLs instead of the fabricated subdomain.
  const [archiveSettings, setArchiveSettings] =
    useState<ArchiveTenantSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ArchiveIssue | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [pinningSlug, setPinningSlug] = useState<string | null>(null);
  const listMutation = useSingleFlightOperation({
    ownerId: "archive-list-pin",
    label: "Archive pin update",
    detail: "Wait for the archive pin request to finish before leaving.",
  });
  const loadOperation = useSingleFlightOperation({
    ownerId: "archive-list-refresh",
    label: "Archive refresh",
    detail: "Wait for the archive refresh to finish before leaving.",
  });
  // Comments-moderation per-issue filter: "" = all issues; otherwise a
  // campaign id resolved from the published-issue rows (the admin
  // comments list filters by campaignId on the wire).
  const [commentsIssueId, setCommentsIssueId] = useState("");
  // Compatibility cache for old responses that predate campaignId on the
  // authenticated list. It is populated only by the authoritative detail
  // endpoint—never by subject matching.
  const [cidBySlug, setCidBySlug] = useState<Record<string, string>>({});
  const rememberCid = (slug: string, id: string): void =>
    setCidBySlug((m) => (m[slug] === id ? m : { ...m, [slug]: id }));

  const load = async (): Promise<void> => {
    const existing = loadOperation.promiseRef.current;
    if (existing) {
      await existing;
      return;
    }
    const request = loadOperation.run(async () => {
      setLoading(true);
      setErr(null);
      try {
        const overview = await fetchArchiveOverview();
        setRows(overview.rows);
        if (overview.stats !== undefined) setStats(overview.stats);
        if (overview.settings !== undefined) {
          setArchiveSettings(overview.settings);
        }
        setErr(overview.warnings.length ? overview.warnings.join(" ") : null);
      } catch (error) {
        setErr(
          lifecycleOperationError(
            error,
            rows
              ? "The refresh failed. Your last loaded archive is still shown."
              : "The archive could not be loaded.",
          ),
        );
      } finally {
        setLoading(false);
      }
    });
    if (request) await request;
  };

  const loadCampaigns = async (): Promise<void> => {
    setCampaignsLoading(true);
    setCampaignsError(null);
    try {
      const res = await api.listCampaigns({ perPage: 200 });
      if (res.error) {
        setCampaignsError(res.error.message);
        return;
      }
      setCampaigns(parseArchiveCampaignCandidates(res.data));
    } catch (error) {
      const message = lifecycleOperationError(error, "Campaign lookup failed.");
      setCampaignsError(message);
      toast.error(message);
    } finally {
      setCampaignsLoading(false);
    }
  };

  useEffect(() => {
    // Parallel fetch — Archive list and campaign list are independent.
    void Promise.all([load(), loadCampaigns()]);
  }, []);

  // Canonical synchronous identity lookup for list-derived controls. Legacy
  // aliases remain read-only compatibility shims for older fixtures.
  const findCampaignId = (issue: ArchiveIssue): string | null => {
    const explicit =
      issue.campaignId ??
      issue.campaign_id ??
      issue.id ??
      cidBySlug[issue.slug];
    if (explicit) return String(explicit);
    return null;
  };

  // Authoritative campaign-id resolution for mutations. New list responses
  // resolve synchronously; old responses get one detail lookup. If neither
  // supplies an ID, the action fails closed.
  const resolveCampaignId = async (
    issue: ArchiveIssue,
  ): Promise<string | null> => {
    const explicit = issue.campaignId ?? issue.campaign_id ?? issue.id;
    if (explicit) return String(explicit);
    const cached = cidBySlug[issue.slug];
    if (cached) return cached;
    const prev = await api.getArchiveIssuePreview(issue.slug);
    const pid = prev.data?.campaignId;
    if (pid) {
      rememberCid(issue.slug, String(pid));
      return String(pid);
    }
    return null;
  };

  const togglePin = async (issue: ArchiveIssue): Promise<void> => {
    if (!canMutate) return;
    const existing = listMutation.promiseRef.current;
    if (existing) {
      await existing;
      return;
    }
    const request = listMutation.run(async () => {
      setPinningSlug(issue.slug);
      try {
        const id = await resolveCampaignId(issue);
        if (!id) {
          toast.error("Couldn't resolve the campaign id for this issue.");
          return;
        }
        const willPin = !issue.pinned;
        const res = willPin
          ? await api.pinArchive(id)
          : await api.unpinArchive(id);
        if (res.error) {
          toast.error(res.error.message);
          return;
        }
        toast.success(willPin ? "Issue pinned" : "Issue unpinned");
        await load();
      } catch (error) {
        toast.error(
          lifecycleOperationError(error, "The archive pin update failed."),
        );
      } finally {
        setPinningSlug(null);
      }
    });
    if (request) await request;
  };

  // The archive list endpoint now honours `?query=` against subject OR
  // archive_slug (apps/api/internal/archive + listsearch). The
  // client-side filter below stays as the default for small archives;
  // for tenants with thousands of issues, swap `api.listArchive()` for
  // `listArchiveWithQuery({ query })` from api-client.
  const filtered = useMemo<ArchiveIssue[]>(() => {
    if (!rows) return [];
    if (!query.trim()) return rows;
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (r.subject ?? "").toLowerCase().includes(q) ||
        (r.slug ?? "").toLowerCase().includes(q),
    );
  }, [rows, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset to page 1 whenever the result set shrinks past current page
  // (same clamp Discounts.tsx carries) — otherwise a narrowing search
  // strands the operator on an empty out-of-range page.
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);

  // Public archive index URL (used by the share-helper buttons and the
  // header "View public archive" link). Null until the tenant configures an
  // archive slug — the buttons below disable themselves rather than emit a
  // dead link (D08#4).
  const configuredIndexBase = archiveIndexBase(archiveSettings);
  const indexBase = ARCHIVE_PUBLIC_DELIVERY_AVAILABLE
    ? configuredIndexBase
    : null;
  const publicIndexUrl = indexBase ?? "";
  const sitemapUrl = indexBase ? `${indexBase}/sitemap.xml` : "";
  const rssUrl = indexBase ? `${indexBase}/feed.xml` : "";

  const statCells = buildArchiveStatCells(stats, rows, publicIndexUrl);

  return (
    <>
      <ArchivePageContent
        canAdmin={canAdmin}
        canMutate={canMutate}
        canPublish={canPublish}
        cidBySlug={cidBySlug}
        commentsIssueId={commentsIssueId}
        err={err}
        filteredCount={filtered.length}
        indexBase={indexBase}
        listBusy={listMutation.active}
        loading={loading}
        page={page}
        pageRows={pageRows}
        pinningSlug={pinningSlug}
        publicIndexUrl={publicIndexUrl}
        publicDeliveryReady={ARCHIVE_PUBLIC_DELIVERY_AVAILABLE}
        query={query}
        rows={rows}
        rssUrl={rssUrl}
        sitemapUrl={sitemapUrl}
        statCells={statCells}
        totalPages={totalPages}
        onCommentsIssueChange={setCommentsIssueId}
        onCopy={(value, confirmation) => {
          void copyArchiveValue(value, confirmation);
        }}
        onFindCampaign={findCampaignId}
        onOpenPublish={() => {
          if (canPublish) setPublishOpen(true);
        }}
        onOpenUrl={(url) => void openArchiveUrl(url)}
        onPageChange={setPage}
        onPin={(issue) => void togglePin(issue)}
        onQueryChange={(value) => {
          setQuery(value);
          setPage(1);
        }}
        onRefresh={() => void load()}
        onSelect={setSelected}
      />
      {selected ? (
        <ArchiveDetailSlideover
          issue={selected}
          canMutate={canMutate}
          canUnpublish={canUnpublish}
          indexBase={indexBase}
          onResolveCampaign={rememberCid}
          onClose={() => setSelected(null)}
          onChanged={() => {
            void load();
            setSelected(null);
          }}
        />
      ) : null}
      <PublishModal
        available={canPublish}
        open={publishOpen}
        campaigns={campaigns}
        campaignsError={campaignsError}
        campaignsLoading={campaignsLoading}
        existingSlugs={(rows ?? []).map((issue) => issue.slug)}
        onRetryCampaigns={() => void loadCampaigns()}
        onClose={() => setPublishOpen(false)}
        onPublished={() => {
          setPublishOpen(false);
          void load();
        }}
      />
    </>
  );
}

/* ---------- publish modal --------------------------------------------- */

interface PublishModalProps {
  available: boolean;
  open: boolean;
  campaigns: Campaign[];
  campaignsError: string | null;
  campaignsLoading: boolean;
  existingSlugs: string[];
  onClose: () => void;
  onPublished: () => void;
  onRetryCampaigns: () => void;
}

function PublishModal({
  available,
  open,
  campaigns,
  campaignsError,
  campaignsLoading,
  existingSlugs,
  onClose,
  onPublished,
  onRetryCampaigns,
}: PublishModalProps): ReactElement {
  const canMutate = useCanAdmin() && available;
  const [campaignId, setCampaignId] = useState<string>("");
  const [slug, setSlug] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const mountedRef = useRef(true);
  const operation = usePersistentLifecycleOperation({
    ownerId: "archive-publish",
    label: "Archive publish request",
    detail:
      "Wait for the archive publish request to finish before leaving Moosewave.",
  });
  const draftDirty = open && Boolean(campaignId || slug || excerpt);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const discardDraft = useCallback((): void => {
    setCampaignId("");
    setSlug("");
    setExcerpt("");
    setSubmitErr(null);
    setDiscardConfirmOpen(false);
    onClose();
  }, [onClose]);
  const requestClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (draftDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    discardDraft();
  }, [discardDraft, draftDirty, operation.promiseRef]);
  useDiscardOnlyDraftLifecycle({
    ownerId: "archive-publish",
    label: "Archive publish draft",
    dirty: draftDirty,
    operationRef: operation.promiseRef,
    discard: discardDraft,
    detail:
      "This campaign, public slug, and excerpt have not been published. Return to the form or explicitly discard them.",
    operationDetail:
      "Wait for the archive publish request to finish before leaving Moosewave.",
    enabled: open,
  });

  // Public archive content is a snapshot of delivered HTML. A scheduled or
  // currently-sending campaign can still change, so only completed sends are
  // eligible.
  const eligible = useMemo<Campaign[]>(() => {
    return campaigns.filter(
      (campaign) => (campaign.status ?? "").toLowerCase() === "sent",
    );
  }, [campaigns]);

  // Reset form whenever the modal opens.
  useEffect(() => {
    if (!open) return;
    setCampaignId("");
    setSlug("");
    setExcerpt("");
    setSubmitErr(null);
    setSubmitting(false);
    setDiscardConfirmOpen(false);
  }, [open]);

  // Auto-fill slug when a campaign is picked (unless the user typed one).
  const onPickCampaign = (id: string): void => {
    setCampaignId(id);
    const c = eligible.find((x) => String(x.id) === id);
    if (c && !slug.trim()) {
      setSlug(slugify(c.subject ?? c.name ?? ""));
    }
  };

  const submit = async (): Promise<void> => {
    if (!canMutate) {
      setSubmitErr(
        "Archive publication is review-gated until the public delivery route is release-qualified.",
      );
      return;
    }
    if (!campaignId) {
      setSubmitErr("Pick a campaign to publish.");
      return;
    }
    const finalSlug = slug.trim();
    if (!finalSlug) {
      setSubmitErr("Add a public slug before publishing.");
      return;
    }
    if (existingSlugs.includes(finalSlug)) {
      setSubmitErr("That slug is already in use by another issue.");
      return;
    }
    if (operation.promiseRef.current) {
      await operation.wait();
      return;
    }
    setSubmitting(true);
    setSubmitErr(null);
    const requestedCampaignId = campaignId;
    const requestedExcerpt = excerpt.trim() || undefined;
    const request = operation.run(async (): Promise<void> => {
      try {
        const res = await api.publishCampaignArchive(requestedCampaignId, {
          slug: finalSlug,
          excerpt: requestedExcerpt ?? "",
        });
        if (!mountedRef.current) return;
        if (res.error) {
          setSubmitErr(res.error.message);
          return;
        }
        setCampaignId("");
        setSlug("");
        setExcerpt("");
        setSubmitErr(null);
        toast.success("Campaign published to archive");
        try {
          onPublished();
        } catch {
          // The publish is committed; a parent refresh/render callback must
          // never leave a retryable form that could republish it.
          onClose();
        }
      } catch (publishError) {
        if (mountedRef.current) {
          setSubmitErr(
            lifecycleOperationError(
              publishError,
              "The archive publish request did not complete.",
            ),
          );
        }
      } finally {
        if (mountedRef.current) setSubmitting(false);
      }
    });
    if (request) await request;
  };

  return (
    <>
      <Modal
        open={open}
        onClose={requestClose}
        title="Publish from campaign"
        description="Choose a completed send, review its permanent public slug, and publish a stable snapshot."
        closeOnBackdrop={!operation.active}
        closeOnEscape={!operation.active}
        closeDisabled={operation.active}
      >
        <div className="field">
          <label className="field-label" htmlFor="archive-campaign">
            Campaign
          </label>
          <select
            id="archive-campaign"
            name="campaign_id"
            className="input"
            value={campaignId}
            disabled={
              operation.active ||
              !canMutate ||
              campaignsLoading ||
              Boolean(campaignsError)
            }
            onChange={(e) => onPickCampaign(e.target.value)}
          >
            <option value="">Select a campaign…</option>
            {eligible.map((c) => (
              <option key={String(c.id)} value={String(c.id)}>
                {(c.subject || c.name || "(untitled)") +
                  ` — ${(c.status ?? "").toLowerCase()}`}
              </option>
            ))}
          </select>
          {campaignsLoading ? (
            <div className="field-hint" role="status">
              Loading completed campaigns…
            </div>
          ) : campaignsError ? (
            <div className="field-error" role="alert">
              Campaigns could not be loaded: {campaignsError}{" "}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={onRetryCampaigns}
              >
                Retry
              </button>
            </div>
          ) : eligible.length === 0 ? (
            <div className="muted arc-field-note">
              No completed campaigns are ready to publish yet.
            </div>
          ) : null}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="archive-slug">
            Public slug
            <InlineHelp text="Required. Becomes the permanent issue path. Use lowercase letters, numbers, and dashes; changing it later breaks existing external links." />
          </label>
          <input
            id="archive-slug"
            name="slug"
            type="text"
            className="input mono"
            placeholder="issue-title"
            value={slug}
            required
            maxLength={64}
            disabled={operation.active || !canMutate}
            onChange={(e) => setSlug(slugify(e.target.value))}
          />
          <div className="field-hint" aria-live="polite">
            {slug.length}/64 · Auto-filled from the selected campaign
          </div>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="archive-excerpt">
            Excerpt <span className="muted">(optional)</span>
            <InlineHelp text="Short blurb shown beneath the title on the archive index. Falls back to the meta description for SEO when present." />
          </label>
          <textarea
            id="archive-excerpt"
            name="excerpt"
            className="input arc-textarea arc-textarea-compact"
            placeholder="Short blurb shown on the archive index."
            rows={3}
            value={excerpt}
            maxLength={280}
            disabled={operation.active || !canMutate}
            onChange={(e) => setExcerpt(e.target.value)}
          />
        </div>

        {submitErr ? <div className="field-error">{submitErr}</div> : null}

        <ModalFooter>
          <button
            type="button"
            className="btn"
            onClick={requestClose}
            disabled={operation.active}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={
              operation.active ||
              !canMutate ||
              !campaignId ||
              !slug.trim() ||
              campaignsLoading ||
              Boolean(campaignsError)
            }
          >
            {submitting ? "Publishing…" : "Publish"}
          </button>
        </ModalFooter>
      </Modal>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard this archive publish draft?"
        description="The selected campaign, public slug, and excerpt have not been published."
        confirmLabel="Discard publish draft"
        danger
        onConfirm={discardDraft}
        onClose={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}

/* ---------- detail slide-over ----------------------------------------- */

interface SlideoverProps {
  issue: ArchiveIssue;
  /** True only when admin scope and public-delivery qualification both pass. */
  canMutate: boolean;
  /** Admin-only containment lane that may remove an existing public issue. */
  canUnpublish: boolean;
  /** Resolved public-archive index base, or null when unconfigured (D08#4). */
  indexBase: string | null;
  /** D08#5: report the authoritative slug→campaignId once resolved, so the
   *  parent's comments-moderation dropdown benefits without a second fetch. */
  onResolveCampaign?: (slug: string, id: string) => void;
  onClose: () => void;
  onChanged: () => void;
}

interface ArchiveEditBaseline {
  slug: string;
  excerpt: string;
  metaDescription: string;
  ogImage: string;
  heroImage: string;
  authorName: string;
  canonicalUrl: string;
}

interface ArchiveSeoDirty {
  meta: boolean;
  og: boolean;
  hero: boolean;
  author: boolean;
  canonical: boolean;
}

const EMPTY_ARCHIVE_SEO_DIRTY: ArchiveSeoDirty = {
  meta: false,
  og: false,
  hero: false,
  author: false,
  canonical: false,
};

function initialArchiveEditBaseline(issue: ArchiveIssue): ArchiveEditBaseline {
  return {
    slug: issue.slug,
    excerpt: issue.excerpt ?? "",
    metaDescription: "",
    ogImage: "",
    heroImage: "",
    authorName: "",
    canonicalUrl: "",
  };
}

function useMountedRef(): { current: boolean } {
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  return mountedRef;
}

function useArchiveDetailHydration({
  issue,
  onResolveCampaign,
  seoDirtyRef,
  setAuthorName,
  setCanonicalUrl,
  setBaseline,
  setErr,
  setHeroImage,
  setMetaDescription,
  setOgImage,
}: {
  issue: ArchiveIssue;
  onResolveCampaign?: (slug: string, campaignId: string) => void;
  seoDirtyRef: { current: ArchiveSeoDirty };
  setAuthorName: (value: string) => void;
  setCanonicalUrl: (value: string) => void;
  setBaseline: (
    update: (current: ArchiveEditBaseline) => ArchiveEditBaseline,
  ) => void;
  setErr: (value: string) => void;
  setHeroImage: (value: string) => void;
  setMetaDescription: (value: string) => void;
  setOgImage: (value: string) => void;
}): ArchiveIssuePreview | null {
  const [detail, setDetail] = useState<ArchiveIssuePreview | null>(null);
  useEffect(() => {
    let alive = true;
    void api
      .getArchiveIssuePreview(issue.slug)
      .then((response) => {
        if (!alive) return;
        if (response.error) {
          setErr(
            `Archive metadata could not be loaded: ${response.error.message}`,
          );
          return;
        }
        if (!response.data) {
          setErr("Archive metadata returned no issue details.");
          return;
        }
        const loaded = response.data;
        setDetail(loaded);
        if (loaded.campaignId) {
          onResolveCampaign?.(issue.slug, String(loaded.campaignId));
        }
        const loadedSeo = {
          metaDescription: loaded.metaDescription ?? "",
          ogImage: loaded.ogImage ?? "",
          heroImage: loaded.heroImage ?? "",
          authorName: loaded.authorName ?? "",
          canonicalUrl: loaded.canonicalUrl ?? "",
        };
        setBaseline((current) => ({ ...current, ...loadedSeo }));
        if (!seoDirtyRef.current.meta) {
          setMetaDescription(loadedSeo.metaDescription);
        }
        if (!seoDirtyRef.current.og) setOgImage(loadedSeo.ogImage);
        if (!seoDirtyRef.current.hero) setHeroImage(loadedSeo.heroImage);
        if (!seoDirtyRef.current.author) setAuthorName(loadedSeo.authorName);
        if (!seoDirtyRef.current.canonical) {
          setCanonicalUrl(loadedSeo.canonicalUrl);
        }
      })
      .catch(() => {
        if (alive) {
          setErr(
            "Archive metadata could not be loaded. Refresh before editing SEO fields.",
          );
        }
      });
    return () => {
      alive = false;
    };
    // Hydration is scoped to the opened issue. Setter identities are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issue.slug]);
  return detail;
}

function resolveArchiveCampaignId(
  detail: ArchiveIssuePreview | null,
  issue: ArchiveIssue,
): string | null {
  const explicit =
    detail?.campaignId ?? issue.campaignId ?? issue.campaign_id ?? issue.id;
  if (explicit) return String(explicit);
  return null;
}

interface ArchiveActionReasons {
  save: string | null;
  pin: string | null;
  unpublish: string | null;
}

function archiveActionReasons(
  canMutate: boolean,
  canUnpublish: boolean,
  campaignId: string | null,
  dirty: boolean,
): ArchiveActionReasons {
  const editUnavailable = canUnpublish
    ? "Editing and pinning are review-gated until public delivery is release-qualified."
    : "Your current role has view-only archive access.";
  const identityUnavailable = !campaignId;

  return {
    save: !canMutate
      ? editUnavailable
      : identityUnavailable
        ? "Wait for the issue's campaign identity to resolve before saving."
        : dirty
          ? null
          : "Make a change before saving.",
    pin: !canMutate
      ? editUnavailable
      : identityUnavailable
        ? "Wait for the issue's campaign identity to resolve before pinning."
        : dirty
          ? "Save or discard your issue changes before changing its pinned state."
          : null,
    unpublish: !canUnpublish
      ? "Your current role has view-only archive access."
      : identityUnavailable
        ? "Wait for the issue's campaign identity to resolve before unpublishing."
        : dirty
          ? "Save or discard your issue changes before unpublishing."
          : null,
  };
}

function ArchiveSeoEditor({
  authorName,
  canonicalUrl,
  disabled,
  heroImage,
  metaDescription,
  ogImage,
  showSeo,
  onAuthorChange,
  onCanonicalChange,
  onHeroChange,
  onMetaChange,
  onOgChange,
  onToggle,
}: {
  authorName: string;
  canonicalUrl: string;
  disabled: boolean;
  heroImage: string;
  metaDescription: string;
  ogImage: string;
  showSeo: boolean;
  onAuthorChange: (value: string) => void;
  onCanonicalChange: (value: string) => void;
  onHeroChange: (value: string) => void;
  onMetaChange: (value: string) => void;
  onOgChange: (value: string) => void;
  onToggle: () => void;
}): ReactElement {
  return (
    <div className="arc-seo-editor">
      <button
        type="button"
        className="btn btn-sm btn-ghost arc-seo-toggle"
        onClick={onToggle}
        aria-expanded={showSeo}
      >
        {showSeo ? "Hide SEO + social preview" : "Edit SEO + social preview"}
      </button>
      {showSeo ? (
        <div className="arc-seo-fields">
          <div className="field">
            <label className="field-label" htmlFor="archive-edit-meta">
              Meta description{" "}
              <span className="muted">(155 chars, fallbacks to excerpt)</span>
            </label>
            <textarea
              id="archive-edit-meta"
              name="meta_description"
              className="input"
              rows={2}
              value={metaDescription}
              maxLength={160}
              onChange={(event) => onMetaChange(event.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="archive-edit-canonical">
              Canonical source URL{" "}
              <span className="muted">(optional SEO override)</span>
            </label>
            <input
              id="archive-edit-canonical"
              name="canonical_url"
              type="url"
              className="input mono"
              placeholder="https://example.com/original-article"
              value={canonicalUrl}
              maxLength={2048}
              onChange={(event) => onCanonicalChange(event.target.value)}
              disabled={disabled}
            />
            <div className="field-hint">
              Use only when another website hosts the primary version. Empty
              keeps this archive issue canonical.
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="archive-edit-og">
              OG / Twitter card image URL
            </label>
            <input
              id="archive-edit-og"
              name="og_image"
              type="url"
              className="input mono"
              placeholder="https://…/og-image.png"
              value={ogImage}
              maxLength={2048}
              onChange={(event) => onOgChange(event.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="archive-edit-hero">
              Hero image URL{" "}
              <span className="muted">(top of the article page)</span>
            </label>
            <input
              id="archive-edit-hero"
              name="hero_image"
              type="url"
              className="input mono"
              placeholder="https://…/hero.jpg"
              value={heroImage}
              maxLength={2048}
              onChange={(event) => onHeroChange(event.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="archive-edit-author">
              Author name <span className="muted">(byline)</span>
            </label>
            <input
              id="archive-edit-author"
              name="author_name"
              type="text"
              className="input"
              placeholder="e.g. Jane Doe"
              value={authorName}
              maxLength={100}
              onChange={(event) => onAuthorChange(event.target.value)}
              disabled={disabled}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ArchiveDetailViewProps {
  actionReasons: ArchiveActionReasons;
  activeAction: "save" | "pin" | "unpublish" | null;
  authorName: string;
  canMutate: boolean;
  canUnpublish: boolean;
  canonicalUrl: string;
  confirmingUnpublish: boolean;
  detail: ArchiveIssuePreview | null;
  discardConfirmOpen: boolean;
  err: string | null;
  excerpt: string;
  heroImage: string;
  indexBase: string | null;
  issue: ArchiveIssue;
  metaDescription: string;
  ogImage: string;
  operationBusy: boolean;
  showSeo: boolean;
  slug: string;
  onAuthorChange: (value: string) => void;
  onCanonicalChange: (value: string) => void;
  onCancelUnpublish: () => void;
  onDiscard: () => void;
  onDiscardCancel: () => void;
  onExcerptChange: (value: string) => void;
  onHeroChange: (value: string) => void;
  onMetaChange: (value: string) => void;
  onOgChange: (value: string) => void;
  onPin: () => void;
  onRequestClose: () => void;
  onSave: () => void;
  onSlugChange: (value: string) => void;
  onStartUnpublish: () => void;
  onToggleSeo: () => void;
  onUnpublish: () => void | Promise<void>;
}

function ArchiveDetailView({
  actionReasons,
  activeAction,
  authorName,
  canMutate,
  canUnpublish,
  canonicalUrl,
  confirmingUnpublish,
  detail,
  discardConfirmOpen,
  err,
  excerpt,
  heroImage,
  indexBase,
  issue,
  metaDescription,
  ogImage,
  operationBusy,
  showSeo,
  slug,
  onAuthorChange,
  onCanonicalChange,
  onCancelUnpublish,
  onDiscard,
  onDiscardCancel,
  onExcerptChange,
  onHeroChange,
  onMetaChange,
  onOgChange,
  onPin,
  onRequestClose,
  onSave,
  onSlugChange,
  onStartUnpublish,
  onToggleSeo,
  onUnpublish,
}: ArchiveDetailViewProps): ReactElement {
  const url = indexBase ? archiveIssueUrl(indexBase, issue.slug) : null;
  const readOnlyDescription = canMutate
    ? undefined
    : "archive-detail-write-availability";
  return (
    <>
      <SlideoverShell
        open
        onClose={onRequestClose}
        size="lg"
        eyebrow="Published issue"
        title={issue.subject || "(untitled)"}
        subtitle={`Published ${new Date(issue.publishedAt).toLocaleString()}`}
        busy={operationBusy}
        className="archive-detail-slideover"
      >
        <div>
          {url ? (
            <button
              type="button"
              onClick={() => void openArchiveUrl(url)}
              className="muted mono arc-detail-public-url"
            >
              {url}
            </button>
          ) : null}
          {!canMutate ? (
            <div
              id="archive-detail-write-availability"
              className="pw-action-status"
              role="status"
            >
              {canUnpublish
                ? "Public catalog editing and pinning are review-gated. You can inspect details or use the admin-only unpublish action below to remove existing exposure."
                : "Your current role has view-only archive access. Public details and performance remain available to inspect."}
            </div>
          ) : null}
        </div>
        {detail?.htmlBody ? (
          <div className="arc-clipping-meter">
            <ClippingMeter html={detail.htmlBody} />
          </div>
        ) : null}
        <SectionHeader
          title="Public details"
          description="Visible on the archive index and individual issue pages."
        />
        <div className="field">
          <label className="field-label" htmlFor="archive-edit-slug">
            Public slug
            <InlineHelp text="Required. Becomes the permanent issue path. Use lowercase letters, numbers, and dashes. Changing it breaks existing external links." />
          </label>
          <input
            id="archive-edit-slug"
            name="slug"
            type="text"
            className="input mono"
            value={slug}
            required
            maxLength={64}
            disabled={operationBusy || !canMutate}
            aria-describedby={readOnlyDescription}
            onChange={(event) => onSlugChange(slugify(event.target.value))}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="archive-edit-excerpt">
            Excerpt
            <InlineHelp text="Short blurb shown beneath the title on the archive index." />
          </label>
          <textarea
            id="archive-edit-excerpt"
            name="excerpt"
            className="input arc-textarea"
            rows={4}
            value={excerpt}
            maxLength={280}
            disabled={operationBusy || !canMutate}
            aria-describedby={readOnlyDescription}
            onChange={(event) => onExcerptChange(event.target.value)}
          />
        </div>
        <SectionHeader
          title="Performance"
          description="30-day rollup from the public archive analytics."
        />
        <div className="arc-detail-metrics">
          <div>
            <div className="muted arc-detail-metric-label">Views (30d)</div>
            <div className="tabular arc-detail-metric-value">
              {issue.viewCount !== undefined
                ? formatArchiveCount(issue.viewCount)
                : "—"}
            </div>
          </div>
          <div>
            <div className="muted arc-detail-metric-label">Unique (30d)</div>
            <div className="tabular arc-detail-metric-value">
              {issue.uniqueVisitors !== undefined
                ? formatArchiveCount(issue.uniqueVisitors)
                : "—"}
            </div>
          </div>
        </div>
        <ArchiveSeoEditor
          authorName={authorName}
          canonicalUrl={canonicalUrl}
          disabled={operationBusy || !canMutate}
          heroImage={heroImage}
          metaDescription={metaDescription}
          ogImage={ogImage}
          showSeo={showSeo}
          onAuthorChange={onAuthorChange}
          onCanonicalChange={onCanonicalChange}
          onHeroChange={onHeroChange}
          onMetaChange={onMetaChange}
          onOgChange={onOgChange}
          onToggle={onToggleSeo}
        />
        {err ? <div className="field-error">{err}</div> : null}
        <ArchiveDetailActions
          issue={issue}
          canUnpublish={canUnpublish}
          busy={operationBusy}
          activeAction={activeAction}
          reasons={actionReasons}
          onSave={onSave}
          onPin={onPin}
          onClose={onRequestClose}
          onStartUnpublish={onStartUnpublish}
        />
      </SlideoverShell>
      <ConfirmModal
        open={discardConfirmOpen}
        title="Discard archive issue changes?"
        description="The slug, excerpt, SEO, canonical source, social preview, and byline edits have not been saved."
        confirmLabel="Discard changes"
        danger
        onConfirm={onDiscard}
        onClose={onDiscardCancel}
      />
      <ConfirmModal
        open={confirmingUnpublish}
        title="Unpublish this issue?"
        description="The issue will disappear from the public archive, sitemap, and RSS feed. The original campaign is preserved."
        confirmLabel="Unpublish issue"
        danger
        busy={operationBusy}
        confirmDisabled={Boolean(actionReasons.unpublish)}
        onConfirm={onUnpublish}
        onClose={onCancelUnpublish}
      >
        <p className="muted">
          Existing links will stop resolving after downstream caches are
          cleared. You can publish the campaign again after the delivery route
          is release-qualified.
        </p>
      </ConfirmModal>
    </>
  );
}

interface ArchiveSecondaryActionsOptions {
  campaignId: string | null;
  canMutate: boolean;
  canUnpublish: boolean;
  dirty: boolean;
  issuePinned: boolean;
  mountedRef: { current: boolean };
  operation: PersistentLifecycleOperation;
  onChanged: () => void;
  onClose: () => void;
  setActiveAction: (action: "save" | "pin" | "unpublish" | null) => void;
  setErr: (message: string | null) => void;
}

function createArchiveSecondaryActions({
  campaignId,
  canMutate,
  canUnpublish,
  dirty,
  issuePinned,
  mountedRef,
  operation,
  onChanged,
  onClose,
  setActiveAction,
  setErr,
}: ArchiveSecondaryActionsOptions): {
  togglePin: () => Promise<void>;
  unpublish: () => Promise<void>;
} {
  const finishSuccessfulChange = (message: string): void => {
    toast.success(message);
    try {
      onChanged();
    } catch {
      onClose();
    }
  };

  const togglePin = async (): Promise<void> => {
    if (!canMutate || dirty || operation.promiseRef.current) return;
    if (!campaignId) {
      setErr("Could not resolve campaign id for this issue.");
      return;
    }
    setErr(null);
    const willPin = !issuePinned;
    const request = operation.run(async (): Promise<void> => {
      setActiveAction("pin");
      try {
        const response = willPin
          ? await api.pinArchive(campaignId)
          : await api.unpinArchive(campaignId);
        if (!mountedRef.current) return;
        if (response.error) {
          setErr(response.error.message);
          return;
        }
        finishSuccessfulChange(willPin ? "Issue pinned" : "Issue unpinned");
      } catch (pinError) {
        if (mountedRef.current) {
          setErr(
            lifecycleOperationError(
              pinError,
              "The archive pin request did not complete.",
            ),
          );
        }
      } finally {
        if (mountedRef.current) setActiveAction(null);
      }
    });
    if (request) await request;
  };

  const unpublish = async (): Promise<void> => {
    if (!canUnpublish || dirty || operation.promiseRef.current) return;
    if (!campaignId) {
      setErr("Could not resolve campaign id for this issue.");
      return;
    }
    setErr(null);
    const request = operation.run(async (): Promise<void> => {
      setActiveAction("unpublish");
      try {
        const response = await api.unpublishCampaignArchive(campaignId);
        if (!mountedRef.current) return;
        if (response.error) {
          setErr(response.error.message);
          return;
        }
        finishSuccessfulChange("Issue unpublished");
      } catch (unpublishError) {
        if (mountedRef.current) {
          setErr(
            lifecycleOperationError(
              unpublishError,
              "The archive unpublish request did not complete.",
            ),
          );
        }
      } finally {
        if (mountedRef.current) setActiveAction(null);
      }
    });
    if (request) await request;
  };

  return { togglePin, unpublish };
}

function ArchiveDetailSlideover({
  issue,
  canMutate,
  canUnpublish,
  indexBase,
  onResolveCampaign,
  onClose,
  onChanged,
}: SlideoverProps): ReactElement {
  const [slug, setSlug] = useState(issue.slug);
  const [excerpt, setExcerpt] = useState(issue.excerpt ?? "");
  // SEO knobs — only sent in the PATCH body when the user has touched
  // them (the `…Dirty` flags below) so unrelated saves don't clobber
  // existing values (the seoDirty guards keep a blank baseline from wiping
  // stored values on save).
  //
  // D08-forms-assets-archive#7: the admin-LIST row (IssueSummary) does NOT
  // carry the archive_* SEO columns — they live only on IssueDetail. So we open
  // blank, then hydrate from the admin preview endpoint (below) once it lands,
  // seeding each field only while it's still untouched so stored values become
  // visible instead of looking unset.
  const [metaDescription, setMetaDescription] = useState<string>("");
  const [ogImage, setOgImage] = useState<string>("");
  const [heroImage, setHeroImage] = useState<string>("");
  const [authorName, setAuthorName] = useState<string>("");
  const [canonicalUrl, setCanonicalUrl] = useState<string>("");
  const [seoDirty, setSeoDirty] = useState<ArchiveSeoDirty>(
    EMPTY_ARCHIVE_SEO_DIRTY,
  );
  const [showSeo, setShowSeo] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeAction, setActiveAction] = useState<
    "save" | "pin" | "unpublish" | null
  >(null);
  const [confirmingUnpublish, setConfirmingUnpublish] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [baseline, setBaseline] = useState<ArchiveEditBaseline>(() =>
    initialArchiveEditBaseline(issue),
  );
  const mountedRef = useMountedRef();
  const seoDirtyRef = useRef(seoDirty);
  const operation = usePersistentLifecycleOperation({
    ownerId: `archive-issue-${issue.slug}`,
    label: "Archive issue request",
    detail:
      "Wait for the archive issue request to finish before leaving Moosewave.",
  });
  seoDirtyRef.current = seoDirty;
  const dirty =
    slug !== baseline.slug ||
    excerpt !== baseline.excerpt ||
    metaDescription !== baseline.metaDescription ||
    ogImage !== baseline.ogImage ||
    heroImage !== baseline.heroImage ||
    authorName !== baseline.authorName ||
    canonicalUrl !== baseline.canonicalUrl;

  const discardAndClose = useCallback((): void => {
    setSlug(baseline.slug);
    setExcerpt(baseline.excerpt);
    setMetaDescription(baseline.metaDescription);
    setOgImage(baseline.ogImage);
    setHeroImage(baseline.heroImage);
    setAuthorName(baseline.authorName);
    setCanonicalUrl(baseline.canonicalUrl);
    setSeoDirty(EMPTY_ARCHIVE_SEO_DIRTY);
    setErr(null);
    setConfirmingUnpublish(false);
    setDiscardConfirmOpen(false);
    onClose();
  }, [baseline, onClose]);
  const requestClose = useCallback((): void => {
    if (operation.promiseRef.current) return;
    if (dirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }, [dirty, onClose, operation.promiseRef]);
  const detail = useArchiveDetailHydration({
    issue,
    onResolveCampaign,
    seoDirtyRef,
    setAuthorName,
    setCanonicalUrl,
    setBaseline,
    setErr,
    setHeroImage,
    setMetaDescription,
    setOgImage,
  });

  // Resolve only from canonical API identity. Missing IDs fail closed instead
  // of guessing from duplicate or edited subject lines.
  const campaignId = useMemo(
    () => resolveArchiveCampaignId(detail, issue),
    [detail, issue],
  );

  const save = async (): Promise<boolean> => {
    if (!canMutate) {
      setErr("Only an owner or admin can save archive issue changes.");
      return false;
    }
    if (!campaignId) {
      setErr(
        "Could not resolve campaign id for this issue — refresh the page and retry.",
      );
      return false;
    }
    if (!slug.trim()) {
      setErr("Add a public slug before saving this issue.");
      return false;
    }
    if (!isAbsoluteWebUrl(ogImage)) {
      setErr("Add an absolute http(s) URL for the social preview image.");
      return false;
    }
    if (!isAbsoluteWebUrl(heroImage)) {
      setErr("Add an absolute http(s) URL for the hero image.");
      return false;
    }
    if (!isAbsoluteWebUrl(canonicalUrl)) {
      setErr("Add an absolute http(s) URL for the canonical source.");
      return false;
    }
    if (operation.promiseRef.current) {
      return (await operation.promiseRef.current) === true;
    }
    const requested: ArchiveEditBaseline = {
      slug: slug.trim(),
      excerpt: excerpt.trim(),
      metaDescription: metaDescription.trim(),
      ogImage: ogImage.trim(),
      heroImage: heroImage.trim(),
      authorName: authorName.trim(),
      canonicalUrl: canonicalUrl.trim(),
    };
    setErr(null);
    const request = operation.run(async (): Promise<boolean> => {
      setActiveAction("save");
      try {
        const res = await api.publishCampaignArchive(campaignId, {
          slug: requested.slug,
          excerpt: requested.excerpt,
          // PATCH semantics: only attach SEO fields when touched, so
          // saving the excerpt doesn't wipe an OG image set previously.
          metaDescription: seoDirty.meta
            ? requested.metaDescription
            : undefined,
          ogImage: seoDirty.og ? requested.ogImage : undefined,
          heroImage: seoDirty.hero ? requested.heroImage : undefined,
          authorName: seoDirty.author ? requested.authorName : undefined,
          canonicalUrl: seoDirty.canonical ? requested.canonicalUrl : undefined,
        });
        if (!mountedRef.current) return false;
        if (res.error) {
          setErr(res.error.message);
          return false;
        }
        setSlug(requested.slug);
        setExcerpt(requested.excerpt);
        setMetaDescription(requested.metaDescription);
        setOgImage(requested.ogImage);
        setHeroImage(requested.heroImage);
        setAuthorName(requested.authorName);
        setCanonicalUrl(requested.canonicalUrl);
        setBaseline(requested);
        setSeoDirty(EMPTY_ARCHIVE_SEO_DIRTY);
        toast.success("Issue updated");
        try {
          onChanged();
        } catch {
          onClose();
        }
        return true;
      } catch (saveError) {
        if (mountedRef.current) {
          setErr(
            lifecycleOperationError(
              saveError,
              "The archive issue update did not complete.",
            ),
          );
        }
        return false;
      } finally {
        if (mountedRef.current) {
          setActiveAction(null);
        }
      }
    });
    return request ? await request : false;
  };

  const { togglePin, unpublish } = createArchiveSecondaryActions({
    campaignId,
    canMutate,
    canUnpublish,
    dirty,
    issuePinned: !!issue.pinned,
    mountedRef,
    operation,
    onChanged,
    onClose,
    setActiveAction,
    setErr,
  });

  useExistingSettingLifecycle({
    ownerId: `archive-issue-${issue.slug}`,
    label: "Archive issue details",
    dirty,
    operationRef: operation.promiseRef,
    save,
    discard: discardAndClose,
    detail:
      "This issue's slug, excerpt, SEO, canonical source, social preview, or byline changes have not been saved.",
    operationDetail:
      "Wait for the archive issue request to finish before leaving Moosewave.",
  });

  const actionReasons = archiveActionReasons(
    canMutate,
    canUnpublish,
    campaignId,
    dirty,
  );

  return (
    <ArchiveDetailView
      actionReasons={actionReasons}
      activeAction={activeAction}
      authorName={authorName}
      canMutate={canMutate}
      canUnpublish={canUnpublish}
      canonicalUrl={canonicalUrl}
      confirmingUnpublish={confirmingUnpublish}
      detail={detail}
      discardConfirmOpen={discardConfirmOpen}
      err={err}
      excerpt={excerpt}
      heroImage={heroImage}
      indexBase={indexBase}
      issue={issue}
      metaDescription={metaDescription}
      ogImage={ogImage}
      operationBusy={operation.active}
      showSeo={showSeo}
      slug={slug}
      onAuthorChange={(value) => {
        setAuthorName(value);
        setSeoDirty((current) => ({ ...current, author: true }));
      }}
      onCanonicalChange={(value) => {
        setCanonicalUrl(value);
        setSeoDirty((current) => ({ ...current, canonical: true }));
      }}
      onCancelUnpublish={() => setConfirmingUnpublish(false)}
      onDiscard={discardAndClose}
      onDiscardCancel={() => setDiscardConfirmOpen(false)}
      onExcerptChange={setExcerpt}
      onHeroChange={(value) => {
        setHeroImage(value);
        setSeoDirty((current) => ({ ...current, hero: true }));
      }}
      onMetaChange={(value) => {
        setMetaDescription(value);
        setSeoDirty((current) => ({ ...current, meta: true }));
      }}
      onOgChange={(value) => {
        setOgImage(value);
        setSeoDirty((current) => ({ ...current, og: true }));
      }}
      onPin={() => void togglePin()}
      onRequestClose={requestClose}
      onSave={() => void save()}
      onSlugChange={setSlug}
      onStartUnpublish={() => setConfirmingUnpublish(true)}
      onToggleSeo={() => setShowSeo((value) => !value)}
      onUnpublish={unpublish}
    />
  );
}

function ArchiveDetailActions({
  issue,
  canUnpublish,
  busy,
  activeAction,
  reasons,
  onSave,
  onPin,
  onClose,
  onStartUnpublish,
}: {
  issue: ArchiveIssue;
  canUnpublish: boolean;
  busy: boolean;
  activeAction: "save" | "pin" | "unpublish" | null;
  reasons: ArchiveActionReasons;
  onSave: () => void;
  onPin: () => void;
  onClose: () => void;
  onStartUnpublish: () => void;
}): ReactElement {
  const unavailable = (reason: string | null): true | undefined =>
    reason ? true : undefined;
  return (
    <>
      {reasons.save || reasons.pin || reasons.unpublish ? (
        <div className="pw-action-status" role="status">
          {reasons.save ? (
            <span id="archive-save-availability">
              Save changes: {reasons.save}
            </span>
          ) : null}{" "}
          {reasons.pin ? (
            <span id="archive-pin-availability">Pin action: {reasons.pin}</span>
          ) : null}{" "}
          {reasons.unpublish ? (
            <span id="archive-unpublish-availability">
              Unpublish action: {reasons.unpublish}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="arc-detail-actions">
        <button
          type="button"
          className={`btn btn-primary${reasons.save ? " pw-discoverable-unavailable" : ""}`}
          onClick={() => {
            if (!reasons.save) onSave();
          }}
          disabled={busy}
          aria-disabled={unavailable(reasons.save)}
          aria-describedby={
            reasons.save ? "archive-save-availability" : undefined
          }
        >
          {activeAction === "save" ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          className={`btn${reasons.pin ? " pw-discoverable-unavailable" : ""}`}
          onClick={() => {
            if (!reasons.pin) onPin();
          }}
          disabled={busy}
          aria-disabled={unavailable(reasons.pin)}
          aria-describedby={
            reasons.pin ? "archive-pin-availability" : undefined
          }
          data-archive-action="pin"
        >
          <PinIcon filled={!!issue.pinned} />
          {activeAction === "pin"
            ? issue.pinned
              ? "Unpinning…"
              : "Pinning…"
            : issue.pinned
              ? "Unpin"
              : "Pin to top"}
        </button>
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
      </div>
      <div className="arc-danger-zone">
        {canUnpublish ? (
          <SectionHeader
            title="Danger zone"
            description="Unpublishing removes the issue from the public archive, sitemap, and RSS feed. The campaign itself is preserved — you can re-publish later."
          />
        ) : null}
        {canUnpublish ? (
          <button
            type="button"
            className={`btn btn-danger${reasons.unpublish ? " pw-discoverable-unavailable" : ""}`}
            onClick={() => {
              if (!reasons.unpublish) onStartUnpublish();
            }}
            disabled={busy}
            aria-disabled={unavailable(reasons.unpublish)}
            aria-describedby={
              reasons.unpublish ? "archive-unpublish-availability" : undefined
            }
          >
            Unpublish issue
          </button>
        ) : null}
      </div>
    </>
  );
}
