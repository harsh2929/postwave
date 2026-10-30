// SPDX-License-Identifier: AGPL-3.0-only
"use client";

//
// Landing Pages list surface. The pages list + New-page control are the
// primary, above-the-fold content (LAND-002); the shared multi-channel ops
// panel is demoted to a collapsible section below. Includes search / status
// filter / sortable headers / pagination (LAND-023), per-page views·conversions
// ·conversion-rate columns (LAND-006), multi-select + bulk actions (LAND-035),
// a per-row overflow menu (edit·view·copy-url·duplicate·publish·restore·
// archive — LAND-001/018/021/034), pending states + success toasts (LAND-012/
// 020), a styled confirm + undo on archive (LAND-010), inline slug-conflict
// handling (LAND-009), a shared EmptyState (LAND-019), and a create form with a
// template picker, custom domain, live URL preview and name/slug guards
// (LAND-015/026/033). Create-form open state is URL-reflected (LAND-030).

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowUpDown,
  Copy,
  ExternalLink,
  LayoutTemplate,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RelativeTime } from "@/components/relative-time";
import { TableSkeleton } from "@/components/dashboard/skeletons";
import { ActionMenu, type ActionMenuItem } from "@/components/ui/action-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { ApiError } from "@/lib/api";
import { copyToClipboard } from "@/lib/clipboard";
import { slugify } from "@/lib/slugify";
import {
  filterLandingPages,
  formatCount,
  landingMetrics,
  LANDING_SORT_KEYS,
  LANDING_STATUS_FILTERS,
  nextSort,
  paginate,
  sortLandingPages,
  statusLabel,
  totalPages,
  type LandingSortKey,
  type LandingStatusFilter,
  type SortOrder,
} from "@/lib/landing-list-helpers";
import { publicLandingUrl } from "@/lib/landing-page-content";
import {
  type LandingPage,
  type LandingPageCreateInput,
  type LandingPageStatus,
} from "@/lib/landing-pages-api";
import {
  canAdminLandingPages,
  confirmFreshLandingPageAdminAuthority,
  LANDING_PAGE_ADMIN_ONLY_MESSAGE,
} from "@/lib/landing-page-authority";
import { base, qk, STALE } from "@/lib/query-keys";
import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { useAppOrigin } from "@/lib/use-app-origin";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { cn } from "@/lib/utils";

const perPage = 20;

// The landing-pages client is only touched from the list query and the row
// handlers, so it loads on first use instead of in the route's eager chunk
// (bundle budget). Types stay static; only the runtime module is deferred.
const loadLandingPagesApi = () =>
  import("@/lib/landing-pages-api").then((mod) => mod.landingPagesApi);

const LazyMultiChannelOpsPanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/multi-channel-ops-panel").then(
      (module) => module.MultiChannelOpsPanel,
    ),
  {
    ssr: false,
    loading: () => (
      <p
        role="status"
        aria-live="polite"
        className="text-sm text-muted-foreground"
      >
        Loading provider setup…
      </p>
    ),
  },
);

// Keep this exactly aligned with apps/api/internal/landingpages/landingpages.go.
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const NAME_MAX = 200;

const TEMPLATES = [
  "signup",
  "waitlist",
  "event",
  "product",
  "coming-soon",
  "custom",
] as const;

const listSchema = {
  page: intParam(1),
  q: stringParam(""),
  status: enumParam(LANDING_STATUS_FILTERS, "all"),
  sort: enumParam(LANDING_SORT_KEYS, "updatedAt"),
  order: enumParam(["asc", "desc"] as const, "desc"),
  new: enumParam(["0", "1"] as const, "0"),
} as const;

function uniqueSlug(baseSlug: string, existing: Set<string>): string {
  const root = slugify(`${baseSlug}-copy`).slice(0, 64) || "page-copy";
  if (!existing.has(root)) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root}-${i}`.slice(0, 64);
    if (!existing.has(candidate)) return candidate;
  }
  return `${root}-${Date.now()}`.slice(0, 64);
}

export default function LandingPagesPage() {
  const queryClient = useQueryClient();
  const origin = useAppOrigin();

  const { state, setState, reset } = useTableUrlState(listSchema);
  const { page, q, status, sort, order } = state;

  // Create-form open state is local (immediate + testable) but mirrored to the
  // URL as ?new=1 so it is deep-linkable and survives refresh (LAND-030). A
  // deep-link / command-palette navigation to ?new=1 opens it via the effect.
  const [showNew, setShowNew] = useState(state.new === "1");
  useEffect(() => {
    if (state.new === "1") setShowNew(true);
  }, [state.new]);

  const [queryInput, setQueryInput] = useState(q);
  const [draftSlug, setDraftSlug] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftTemplate, setDraftTemplate] = useState<string>("signup");
  const [draftDomain, setDraftDomain] = useState("");
  const [creating, setCreating] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const slugInputRef = useRef<HTMLInputElement>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // React state commits after the current event turn. This synchronous set is
  // the actual duplicate-submit lock for create, row, undo and bulk actions.
  const activeWritesRef = useRef<Set<string>>(new Set());
  const [opsOpen, setOpsOpen] = useState(false);
  const [confirm, setConfirm] = useState<
    | { kind: "archive"; page: LandingPage }
    | { kind: "bulk-archive"; pages: LandingPage[] }
    | null
  >(null);

  const meQuery = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const identity = meQuery.data;
  const tenantId = meQuery.data?.tenant_id ?? "anon";
  const role = identity ? effectiveAuthRole(identity) : null;
  const viewerMode = identity?.viewer_mode === true;
  const canAdmin = canAdminLandingPages(identity);
  const landingScopeKey = useMemo(
    () => base("landing-pages", tenantId, role),
    [role, tenantId],
  );
  const landingBaseKey = useMemo(
    () =>
      [...landingScopeKey, identity?.user_id ?? "anon", viewerMode] as const,
    [identity?.user_id, landingScopeKey, viewerMode],
  );
  const listKey = useMemo(
    () => [...landingBaseKey, "list"] as const,
    [landingBaseKey],
  );

  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: async () => (await loadLandingPagesApi()).list(),
    enabled: meQuery.isSuccess,
    staleTime: STALE.list,
  });
  const pages = useMemo(
    () => (Array.isArray(listQuery.data) ? listQuery.data : []),
    [listQuery.data],
  );

  const loading = meQuery.isLoading || (listQuery.isPending && !listQuery.data);
  const loadError =
    listQuery.error instanceof Error
      ? listQuery.error.message
      : meQuery.error instanceof Error
        ? meQuery.error.message
        : listQuery.isError
          ? "this is a failed request, not an empty list"
          : null;

  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: landingBaseKey,
      exact: false,
    });

  const filtered = useMemo(
    () => filterLandingPages(pages, { q, status }),
    [pages, q, status],
  );
  const sorted = useMemo(() => {
    const s = sortLandingPages(filtered, sort, order);
    // On the default "all" view, sink archived pages to the bottom so they
    // never interleave with live/draft rows (LAND-023). An explicit status
    // filter (e.g. "archived") shows the natural sort.
    if (status !== "all") return s;
    return [
      ...s.filter((p) => p.status !== "archived"),
      ...s.filter((p) => p.status === "archived"),
    ];
  }, [filtered, sort, order, status]);
  const pageCount = totalPages(sorted.length, perPage);
  const clampedPage = Math.min(page, pageCount);
  const rows = useMemo(
    () => paginate(sorted, clampedPage, perPage),
    [sorted, clampedPage],
  );
  const existingSlugs = useMemo(
    () => new Set(pages.map((p) => p.slug.toLowerCase())),
    [pages],
  );
  const isFiltered = q.trim() !== "" || status !== "all";

  // A role/viewer-mode/workspace transition gets a distinct key. Retire the
  // previous identity's cache as well so an admin response cannot remain
  // resident after a downgrade or shared-device identity change.
  const previousIdentityRef = useRef<{
    stamp: string;
    baseKey: readonly unknown[];
  } | null>(null);
  const identityStamp = identity
    ? `${identity.user_id}\u0000${identity.tenant_id}\u0000${role ?? ""}\u0000${viewerMode}`
    : "anon";
  useEffect(() => {
    if (!identity) return;
    const previous = previousIdentityRef.current;
    if (previous && previous.stamp !== identityStamp) {
      void queryClient
        .cancelQueries({ queryKey: previous.baseKey, exact: false })
        .then(() =>
          queryClient.removeQueries({
            queryKey: previous.baseKey,
            exact: false,
          }),
        );
    }
    previousIdentityRef.current = {
      stamp: identityStamp,
      baseKey: landingBaseKey,
    };
  }, [identity, identityStamp, landingBaseKey, queryClient]);

  useEffect(() => {
    if (!meQuery.isSuccess || canAdmin) return;
    activeWritesRef.current.clear();
    setSelected(new Set());
    setConfirm(null);
    setShowNew(false);
    setCreating(false);
    setBulkBusy(false);
  }, [canAdmin, meQuery.isSuccess]);

  const counts = useMemo(() => {
    let published = 0;
    for (const p of pages) if (p.status === "published") published++;
    return { total: pages.length, published };
  }, [pages]);
  const selectedPages = useMemo(
    () => pages.filter((candidate) => selected.has(candidate.id)),
    [pages, selected],
  );
  const selectedDrafts = selectedPages.filter((p) => p.status === "draft");
  const selectedPublished = selectedPages.filter(
    (p) => p.status === "published",
  );
  const selectedArchived = selectedPages.filter((p) => p.status === "archived");
  const selectedArchivable = selectedPages.filter(
    (p) => p.status !== "archived",
  );

  function setPageBusy(id: string, busy: boolean) {
    setBusyIds((current) => {
      const next = new Set(current);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function reserveWrites(keys: string[]): boolean {
    if (!canAdmin || !identity) {
      toast.error(LANDING_PAGE_ADMIN_ONLY_MESSAGE);
      return false;
    }
    if (keys.some((key) => activeWritesRef.current.has(key))) return false;
    for (const key of keys) activeWritesRef.current.add(key);
    return true;
  }

  function releaseWrites(keys: string[]) {
    for (const key of keys) activeWritesRef.current.delete(key);
  }

  async function verifyAdmin(): Promise<void> {
    await confirmFreshLandingPageAdminAuthority(identity);
  }

  // --- create --------------------------------------------------------------
  function openCreate() {
    if (!canAdmin) {
      toast.error(LANDING_PAGE_ADMIN_ONLY_MESSAGE);
      return;
    }
    setShowNew(true);
    setState({ new: "1" });
  }
  function closeCreate() {
    setShowNew(false);
    setState({ new: "0" });
    setSlugError(null);
    setNameError(null);
  }

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!reserveWrites(["create"])) return;
    const intent: LandingPageCreateInput = {
      name: draftName.trim(),
      slug: draftSlug.trim(),
      template: draftTemplate,
      ...(draftDomain.trim() ? { domain: draftDomain.trim() } : {}),
    };
    const { name, slug } = intent;
    let bad = false;
    if (!name) {
      setNameError("Enter a name for this page.");
      bad = true;
    } else {
      setNameError(null);
    }
    if (!slug) {
      setSlugError("Enter a slug for the public URL.");
      bad = true;
    } else if (!SLUG_PATTERN.test(slug)) {
      setSlugError(
        "Start with a lowercase letter, then use lowercase letters, digits or dashes (64 characters maximum).",
      );
      bad = true;
    } else {
      setSlugError(null);
    }
    if (bad) {
      if (!name) nameInputRef.current?.focus();
      else slugInputRef.current?.focus();
      releaseWrites(["create"]);
      return;
    }

    setCreating(true);
    try {
      await verifyAdmin();
      const created = await (await loadLandingPagesApi()).create(intent);
      setDraftSlug("");
      setDraftName("");
      setDraftDomain("");
      setDraftTemplate("signup");
      setShowNew(false);
      setState({ new: "0" });
      invalidate();
      toast.success(`Created "${created.name}".`, {
        action: {
          label: "Edit",
          onClick: () => {
            window.location.href = `/app/landing-pages/${created.id}`;
          },
        },
      });
    } catch (err) {
      // The most common create failure is a duplicate slug (409). Route it to
      // the slug field inline and keep the form open with the entered values
      // instead of dumping a page-level banner (LAND-009).
      if (
        err instanceof ApiError &&
        (err.status === 409 || err.code === "slug_conflict")
      ) {
        setSlugError(
          "A landing page with this slug already exists. Choose another.",
        );
        slugInputRef.current?.focus();
      } else {
        toast.error(err instanceof Error ? err.message : "Create failed.");
      }
    } finally {
      setCreating(false);
      releaseWrites(["create"]);
    }
  }

  // --- mutations -----------------------------------------------------------
  async function setStatusFor(
    p: LandingPage,
    next: LandingPageStatus,
    verb: string,
  ) {
    const intent = { id: p.id, name: p.name, status: next, verb } as const;
    const keys = [`page:${intent.id}`];
    if (!reserveWrites(keys)) return;
    setPageBusy(intent.id, true);
    try {
      await verifyAdmin();
      await (
        await loadLandingPagesApi()
      ).update(intent.id, { status: intent.status });
      invalidate();
      toast.success(`${intent.name} ${intent.verb}.`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Could not ${verb} page.`,
      );
    } finally {
      setPageBusy(intent.id, false);
      releaseWrites(keys);
    }
  }

  async function archivePage(p: LandingPage) {
    const intent = { id: p.id, name: p.name } as const;
    const keys = [`page:${intent.id}`];
    if (!reserveWrites(keys)) return;
    setPageBusy(intent.id, true);
    try {
      await verifyAdmin();
      await (await loadLandingPagesApi()).archive(intent.id);
      setSelected((s) => {
        const n = new Set(s);
        n.delete(intent.id);
        return n;
      });
      invalidate();
      // Undo restores the page to draft (server allows the transition).
      toast.success(`Archived "${intent.name}".`, {
        action: {
          label: "Undo",
          onClick: () =>
            void setStatusFor(
              { ...p, id: intent.id, name: intent.name },
              "draft",
              "restored",
            ),
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Archive failed.");
    } finally {
      setPageBusy(intent.id, false);
      releaseWrites(keys);
    }
  }

  async function duplicatePage(p: LandingPage) {
    const intent = {
      id: p.id,
      slug: uniqueSlug(p.slug, existingSlugs),
    } as const;
    const keys = [`page:${intent.id}`];
    if (!reserveWrites(keys)) return;
    setPageBusy(intent.id, true);
    try {
      // Fetch the full record so blocks/seo/tracking come along (the list may
      // be a lean projection); create a fresh draft copy with a new slug.
      const full = structuredClone(
        await (await loadLandingPagesApi()).get(intent.id),
      );
      const createIntent: LandingPageCreateInput = {
        slug: intent.slug,
        name: `${full.name} (copy)`,
        template: full.template,
        blocks: structuredClone(full.blocks),
        seo: structuredClone(full.seo),
        tracking: structuredClone(full.tracking),
      };
      await verifyAdmin();
      const created = await (await loadLandingPagesApi()).create(createIntent);
      invalidate();
      toast.success(`Duplicated as "${created.name}".`, {
        action: {
          label: "Edit",
          onClick: () => {
            window.location.href = `/app/landing-pages/${created.id}`;
          },
        },
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not duplicate page.",
      );
    } finally {
      setPageBusy(intent.id, false);
      releaseWrites(keys);
    }
  }

  async function copyUrl(p: LandingPage) {
    const result = await copyToClipboard(publicLandingUrl(origin, p.slug));
    if (result === "copied") toast.success("Public URL copied.");
    else if (result === "unavailable")
      toast.error("Clipboard unavailable — copy the URL manually.");
    else toast.error("Could not copy the URL.");
  }

  // --- bulk ----------------------------------------------------------------
  async function runBulk(
    targets: LandingPage[],
    next: LandingPageStatus,
    verb: string,
  ) {
    const intents = targets.map((p) => ({
      id: p.id,
      status: next,
    }));
    const keys = intents.map((intent) => `page:${intent.id}`);
    if (bulkBusy || busyIds.size > 0 || intents.length === 0) return;
    if (!reserveWrites(keys)) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        intents.map(async (intent) => {
          await verifyAdmin();
          return (await loadLandingPagesApi()).update(intent.id, {
            status: intent.status,
          });
        }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      setSelected((current) => {
        const remaining = new Set(current);
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            remaining.delete(intents[index].id);
          }
        });
        return remaining;
      });
      invalidate();
      if (ok > 0) toast.success(`${verb} ${ok} page${ok === 1 ? "" : "s"}.`);
      if (ok < intents.length)
        toast.error(`${intents.length - ok} could not be updated.`);
    } finally {
      setBulkBusy(false);
      releaseWrites(keys);
    }
  }

  async function bulkArchive(targets: LandingPage[]) {
    const intents = targets.map((p) => ({ id: p.id }));
    const keys = intents.map((intent) => `page:${intent.id}`);
    if (bulkBusy || busyIds.size > 0 || intents.length === 0) return;
    if (!reserveWrites(keys)) return;
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(
        intents.map(async (intent) => {
          await verifyAdmin();
          return (await loadLandingPagesApi()).archive(intent.id);
        }),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      setSelected((current) => {
        const remaining = new Set(current);
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            remaining.delete(intents[index].id);
          }
        });
        return remaining;
      });
      invalidate();
      if (ok > 0) toast.success(`Archived ${ok} page${ok === 1 ? "" : "s"}.`);
      if (ok < intents.length)
        toast.error(`${intents.length - ok} could not be archived.`);
    } finally {
      setBulkBusy(false);
      releaseWrites(keys);
    }
  }

  // --- selection -----------------------------------------------------------
  const allOnPageSelected =
    rows.length > 0 && rows.every((p) => selected.has(p.id));
  function toggleRow(id: string) {
    if (!canAdmin) return;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }
  function toggleAllOnPage() {
    if (!canAdmin) return;
    setSelected((current) => {
      const next = new Set(current);
      for (const row of rows) {
        if (allOnPageSelected) next.delete(row.id);
        else next.add(row.id);
      }
      return next;
    });
  }

  function handleSort(key: LandingSortKey) {
    const n = nextSort({ sort, order }, key);
    setState({ sort: n.sort, order: n.order as SortOrder, page: 1 });
  }

  const previewUrl = publicLandingUrl(origin, draftSlug || "your-slug");

  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-6 px-4 py-5 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Landing pages
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {loading
              ? "Loading…"
              : `${formatCount(counts.total)} page${counts.total === 1 ? "" : "s"} · ${formatCount(counts.published)} published`}
            {" · hosted at "}
            <code className="break-all text-foreground">
              {origin ? `${origin}/landing/` : "/landing/"}
              &lt;slug&gt;
            </code>
          </p>
        </div>
        <Button
          type="button"
          onClick={() => (showNew ? closeCreate() : openCreate())}
          disabled={!canAdmin}
          title={
            meQuery.isSuccess && !canAdmin
              ? LANDING_PAGE_ADMIN_ONLY_MESSAGE
              : undefined
          }
          aria-expanded={showNew}
          aria-controls="new-landing-page-form"
          className="w-full sm:w-auto"
        >
          {showNew ? (
            <>
              <X className="h-4 w-4" />
              Cancel
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              New page
            </>
          )}
        </Button>
      </header>

      {meQuery.isSuccess && !canAdmin ? (
        <p
          role="status"
          className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
        >
          {LANDING_PAGE_ADMIN_ONLY_MESSAGE} You can still inspect pages, copy
          public URLs, view previews, and review conversion metrics.
        </p>
      ) : null}

      {showNew && canAdmin && (
        <form
          id="new-landing-page-form"
          onSubmit={onCreate}
          noValidate
          className="rounded-md border border-border bg-card p-4 space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label
                htmlFor="lp-name"
                className="mb-1 block text-muted-foreground"
              >
                Name
              </Label>
              <Input
                ref={nameInputRef}
                id="lp-name"
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value);
                  if (nameError) setNameError(null);
                }}
                placeholder="Welcome page"
                maxLength={NAME_MAX}
                aria-invalid={nameError ? true : undefined}
                aria-describedby={nameError ? "lp-name-error" : undefined}
                required
              />
              {nameError && (
                <p
                  id="lp-name-error"
                  role="alert"
                  className="mt-1 text-xs text-destructive"
                >
                  {nameError}
                </p>
              )}
            </div>
            <div>
              <Label
                htmlFor="lp-slug"
                className="mb-1 block text-muted-foreground"
              >
                Slug
              </Label>
              <Input
                ref={slugInputRef}
                id="lp-slug"
                value={draftSlug}
                // Sanitize keystrokes into a URL-safe slug (mirrors forms).
                onChange={(e) => {
                  setDraftSlug(slugify(e.target.value).slice(0, 64));
                  if (slugError) setSlugError(null);
                }}
                placeholder="welcome"
                maxLength={64}
                aria-invalid={slugError ? true : undefined}
                aria-describedby={
                  slugError ? "lp-slug-help lp-slug-error" : "lp-slug-help"
                }
                required
              />
              <p
                id="lp-slug-help"
                className="mt-1 text-xs text-muted-foreground"
              >
                Public URL:{" "}
                <span className="font-mono text-foreground">{previewUrl}</span>
              </p>
              {slugError && (
                <p
                  id="lp-slug-error"
                  role="alert"
                  className="mt-1 text-xs text-destructive"
                >
                  {slugError}
                </p>
              )}
            </div>
            <div>
              <Label
                htmlFor="lp-template"
                className="mb-1 block text-muted-foreground"
              >
                Template
              </Label>
              <Select
                id="lp-template"
                value={draftTemplate}
                onChange={(e) => setDraftTemplate(e.target.value)}
              >
                {TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1).replace(/-/g, " ")}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label
                htmlFor="lp-domain"
                className="mb-1 block text-muted-foreground"
              >
                Custom domain <span className="text-xs">(optional)</span>
              </Label>
              <Input
                id="lp-domain"
                value={draftDomain}
                onChange={(e) => setDraftDomain(e.target.value)}
                placeholder="pages.example.com"
                inputMode="url"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create page"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={closeCreate}
              disabled={creating}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}

      {loadError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-center text-sm text-foreground sm:p-8"
        >
          <p>Landing pages could not be loaded: {loadError}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              void meQuery.refetch();
              void listQuery.refetch();
            }}
          >
            Retry
          </Button>
        </div>
      ) : loading ? (
        <TableSkeleton
          rows={6}
          columns={["w-40", "w-32", "w-12", "w-12", "w-12", "w-20", "w-24"]}
        />
      ) : pages.length === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title="No landing pages yet"
          description="Build a hosted page to capture signups from ads, social, or a campaign — then publish it to a public URL and wire the leads straight into your subscriber list."
          action={
            canAdmin ? (
              <Button type="button" onClick={openCreate}>
                <Plus className="h-4 w-4" />
                Create your first landing page
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-4">
          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2">
            <form
              className="relative min-w-0 flex-1"
              onSubmit={(e) => {
                e.preventDefault();
                setState({ q: queryInput.trim(), page: 1 });
              }}
            >
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9 pr-9"
                aria-label="Search landing pages"
                placeholder="Search by name or slug"
                value={queryInput}
                onChange={(e) => setQueryInput(e.target.value)}
              />
              {queryInput ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setQueryInput("");
                    setState({ q: "", page: 1 });
                  }}
                  className="absolute right-1 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </form>
            <div className="w-44">
              <label htmlFor="lp-status" className="sr-only">
                Filter by status
              </label>
              <Select
                id="lp-status"
                value={status}
                onChange={(e) =>
                  setState({
                    status: e.target.value as LandingStatusFilter,
                    page: 1,
                  })
                }
              >
                <option value="all">All statuses</option>
                <option value="draft">Draft</option>
                <option value="published">Published</option>
                <option value="archived">Archived</option>
              </Select>
            </div>
          </div>

          {canAdmin && selected.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border bg-accent/40 px-3 py-2 text-sm">
              <span className="font-medium">{selected.size} selected</span>
              <div className="ml-auto flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !canAdmin ||
                    bulkBusy ||
                    busyIds.size > 0 ||
                    selectedDrafts.length === 0
                  }
                  title={
                    selectedDrafts.length === 0
                      ? "Select at least one draft to publish"
                      : undefined
                  }
                  onClick={() =>
                    void runBulk(selectedDrafts, "published", "Published")
                  }
                >
                  Publish
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !canAdmin ||
                    bulkBusy ||
                    busyIds.size > 0 ||
                    selectedPublished.length === 0
                  }
                  title={
                    selectedPublished.length === 0
                      ? "Select at least one published page to unpublish"
                      : undefined
                  }
                  onClick={() =>
                    void runBulk(selectedPublished, "draft", "Unpublished")
                  }
                >
                  Unpublish
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    !canAdmin ||
                    bulkBusy ||
                    busyIds.size > 0 ||
                    selectedArchived.length === 0
                  }
                  title={
                    selectedArchived.length === 0
                      ? "Select at least one archived page to restore"
                      : undefined
                  }
                  onClick={() =>
                    void runBulk(selectedArchived, "draft", "Restored")
                  }
                >
                  Restore
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={
                    !canAdmin ||
                    bulkBusy ||
                    busyIds.size > 0 ||
                    selectedArchivable.length === 0
                  }
                  title={
                    selectedArchivable.length === 0
                      ? "Select at least one page that is not already archived"
                      : undefined
                  }
                  onClick={() =>
                    setConfirm({
                      kind: "bulk-archive",
                      pages: selectedArchivable.map((page) => ({ ...page })),
                    })
                  }
                >
                  Archive
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={bulkBusy || busyIds.size > 0}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
              </div>
            </div>
          ) : null}

          {sorted.length === 0 ? (
            <div className="rounded-md border bg-card p-10 text-center text-sm text-muted-foreground">
              <p>No landing pages match your filters.</p>
              {isFiltered ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setQueryInput("");
                    reset();
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </div>
          ) : (
            <div
              role="region"
              aria-label="Landing pages"
              tabIndex={0}
              className="rounded-md border bg-card overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <table className="w-full text-sm">
                <caption className="sr-only">Landing pages</caption>
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th scope="col" className="w-10 px-4 py-2">
                      <input
                        type="checkbox"
                        aria-label="Select all landing pages on this page"
                        className="h-6 w-6 cursor-pointer rounded border-input accent-primary align-middle"
                        checked={allOnPageSelected}
                        disabled={!canAdmin || bulkBusy}
                        onChange={toggleAllOnPage}
                      />
                    </th>
                    <SortHeader
                      label="Name"
                      col="name"
                      sort={sort}
                      order={order}
                      onSort={handleSort}
                    />
                    <th scope="col" className="text-left px-4 py-2 font-medium">
                      Slug
                    </th>
                    <SortHeader
                      label="Views"
                      col="views"
                      sort={sort}
                      order={order}
                      onSort={handleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Conversions"
                      col="conversions"
                      sort={sort}
                      order={order}
                      onSort={handleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Conv. rate"
                      col="conversionRate"
                      sort={sort}
                      order={order}
                      onSort={handleSort}
                      align="right"
                    />
                    <SortHeader
                      label="Status"
                      col="status"
                      sort={sort}
                      order={order}
                      onSort={handleSort}
                    />
                    <SortHeader
                      label="Updated"
                      col="updatedAt"
                      sort={sort}
                      order={order}
                      onSort={handleSort}
                    />
                    <th scope="col" className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((p) => {
                    const m = landingMetrics(p);
                    const url = publicLandingUrl(origin, p.slug);
                    const busy = bulkBusy || busyIds.has(p.id);
                    const menuItems: ActionMenuItem[] = [
                      {
                        label: canAdmin ? "Edit" : "View details",
                        icon: <Pencil className="h-4 w-4" />,
                        disabled: busy,
                        onSelect: () => {
                          window.location.href = `/app/landing-pages/${p.id}`;
                        },
                      },
                      p.status === "published"
                        ? {
                            label: "View public page",
                            icon: <ExternalLink className="h-4 w-4" />,
                            onSelect: () =>
                              window.open(url, "_blank", "noopener"),
                          }
                        : {
                            label: "Preview",
                            icon: <ExternalLink className="h-4 w-4" />,
                            onSelect: () => {
                              window.location.href = `/app/landing-pages/${p.id}?tab=preview`;
                            },
                          },
                      {
                        label: "Copy public URL",
                        icon: <Copy className="h-4 w-4" />,
                        onSelect: () => void copyUrl(p),
                      },
                      {
                        label: "Duplicate",
                        icon: <Copy className="h-4 w-4" />,
                        disabled: !canAdmin || busy,
                        onSelect: () => void duplicatePage(p),
                      },
                      ...(p.status === "published"
                        ? [
                            {
                              label: "Unpublish",
                              disabled: !canAdmin || busy,
                              onSelect: () =>
                                void setStatusFor(p, "draft", "unpublished"),
                            },
                          ]
                        : p.status === "draft"
                          ? [
                              {
                                label: "Publish",
                                disabled: !canAdmin || busy,
                                onSelect: () =>
                                  void setStatusFor(
                                    p,
                                    "published",
                                    "published",
                                  ),
                              },
                            ]
                          : [
                              // Archived pages can be restored to draft (LAND-001).
                              {
                                label: "Restore to draft",
                                icon: <ArchiveRestore className="h-4 w-4" />,
                                disabled: !canAdmin || busy,
                                onSelect: () =>
                                  void setStatusFor(p, "draft", "restored"),
                              },
                            ]),
                      ...(p.status !== "archived"
                        ? [
                            {
                              label: "Archive",
                              icon: <Archive className="h-4 w-4" />,
                              destructive: true,
                              disabled: !canAdmin || busy,
                              onSelect: () =>
                                setConfirm({
                                  kind: "archive",
                                  page: structuredClone(p),
                                }),
                            },
                          ]
                        : []),
                    ];
                    return (
                      <tr
                        key={p.id}
                        className={cn(
                          "hover:bg-muted/30",
                          selected.has(p.id) && "bg-primary/5",
                          busy && "opacity-60",
                        )}
                      >
                        <td className="w-10 px-4 py-3">
                          <input
                            type="checkbox"
                            aria-label={`Select ${p.name}`}
                            className="h-6 w-6 cursor-pointer rounded border-input accent-primary align-middle"
                            checked={selected.has(p.id)}
                            disabled={!canAdmin || busy}
                            onChange={() => toggleRow(p.id)}
                          />
                        </td>
                        <td className="px-4 py-3 max-w-[240px]">
                          <Link
                            href={`/app/landing-pages/${p.id}`}
                            className="flex min-h-6 items-center truncate font-medium underline-offset-4 hover:underline"
                            title={p.name}
                          >
                            {p.name}
                          </Link>
                          <div className="text-xs text-muted-foreground capitalize">
                            {p.template}
                          </div>
                        </td>
                        <td className="px-4 py-3 max-w-[200px]">
                          <div className="flex items-center gap-1">
                            <span
                              className="truncate font-mono text-xs text-muted-foreground"
                              title={url}
                            >
                              /landing/{p.slug}
                            </span>
                            <IconButton
                              aria-label={`Copy public URL for ${p.name}`}
                              size="sm"
                              onClick={() => void copyUrl(p)}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </IconButton>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {m.views === null ? "—" : formatCount(m.views)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {m.conversions === null
                            ? "—"
                            : formatCount(m.conversions)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">
                          {m.conversionRate === null
                            ? "—"
                            : `${m.conversionRate}%`}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            variant={
                              p.status === "published"
                                ? "success"
                                : p.status === "draft"
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            {statusLabel(p.status)}
                          </Badge>
                          {/* LAND-038: scheduled publish / auto-unpublish. */}
                          {p.status === "draft" && p.publish_at ? (
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              Publishes <RelativeTime iso={p.publish_at} />
                            </div>
                          ) : p.status === "published" && p.unpublish_at ? (
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              Unpublishes <RelativeTime iso={p.unpublish_at} />
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">
                          <RelativeTime iso={p.updated_at} />
                        </td>
                        <td className="px-4 py-3 text-right">
                          <ActionMenu
                            items={menuItems}
                            label={`Actions for ${p.name}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {pageCount > 1 ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {clampedPage} of {pageCount} · {formatCount(sorted.length)}{" "}
                page
                {sorted.length === 1 ? "" : "s"}
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={clampedPage <= 1}
                  onClick={() => setState({ page: clampedPage - 1 })}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={clampedPage >= pageCount}
                  onClick={() => setState({ page: clampedPage + 1 })}
                >
                  Next
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* Multi-channel ops panel demoted below the list (LAND-002). */}
      <details
        className="group rounded-md border bg-card/50"
        onToggle={(event) => setOpsOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer select-none list-none px-4 py-3 text-sm font-medium marker:hidden">
          <span className="inline-flex items-center gap-2">
            <span className="text-muted-foreground transition-transform group-open:rotate-90">
              ▸
            </span>
            Multi-channel &amp; provider setup
          </span>
        </summary>
        {opsOpen ? (
          <div className="border-t p-4">
            <LazyMultiChannelOpsPanel />
          </div>
        ) : null}
      </details>

      {/* Destructive confirmations (LAND-010 / LAND-035) */}
      <ConfirmDialog
        open={confirm?.kind === "archive"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Archive landing page?"
        description={
          confirm?.kind === "archive"
            ? `"${confirm.page.name}" will be unpublished and hidden from the public URL. You can restore it to draft afterwards.`
            : ""
        }
        confirmLabel="Archive"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (confirm?.kind === "archive") await archivePage(confirm.page);
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "bulk-archive"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Archive ${confirm?.kind === "bulk-archive" ? confirm.pages.length : 0} page${confirm?.kind === "bulk-archive" && confirm.pages.length === 1 ? "" : "s"}?`}
        description="The selected pages will be unpublished and hidden from their public URLs. You can restore each to draft afterwards."
        confirmLabel="Archive"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (confirm?.kind === "bulk-archive") {
            await bulkArchive(confirm.pages);
          }
          setConfirm(null);
        }}
      />
    </div>
  );
}

function SortHeader({
  label,
  col,
  sort,
  order,
  onSort,
  align = "left",
}: {
  label: string;
  col: LandingSortKey;
  sort: LandingSortKey;
  order: SortOrder;
  onSort: (key: LandingSortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort === col;
  return (
    <th
      scope="col"
      className={cn(
        "px-4 py-2 font-medium",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={cn(
          "inline-flex min-h-8 items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          align === "right" && "flex-row-reverse",
          active && "text-foreground",
        )}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <ArrowUpDown
          className={cn("h-3 w-3", active ? "opacity-100" : "opacity-40")}
        />
        {active ? (
          <span className="sr-only">
            {order === "asc" ? "ascending" : "descending"}
          </span>
        ) : null}
      </button>
    </th>
  );
}
