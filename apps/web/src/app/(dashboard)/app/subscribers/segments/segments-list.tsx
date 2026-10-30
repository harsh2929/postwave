// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsUpDown,
  Copy,
  Folder,
  FolderPlus,
  Megaphone,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DeferredConfirmDialog } from "@/components/ui/deferred-confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { TableSkeleton } from "@/components/dashboard/skeletons";
import { absoluteTime, timeAgo } from "@/lib/relative-time";
import { base, qk, STALE } from "@/lib/query-keys";
import { enumParam, intParam, stringParam } from "@/lib/table-url-state";
import { useTableUrlState } from "@/lib/use-table-url-state";
import { effectiveAuthRole, whoami } from "@/lib/auth-api";
import { createCampaign } from "@/lib/campaigns-api";
import {
  createSegment,
  createSegmentFolder,
  deleteSegment,
  deleteSegmentFolder,
  listSegmentFolders,
  listSegments,
  recomputeSegment,
  updateSegment,
  type Segment,
  type SegmentFolder,
} from "@/lib/segments-api";
import {
  BULK_DELETE_DESCRIPTION,
  duplicateSegmentInput,
  restoreSegmentInput,
  segmentRowDeleteDescription,
} from "@/components/segments/segment-logic";
import {
  filterByFolder,
  filterSegments,
  FOLDER_ALL,
  FOLDER_UNFILED,
  paginate,
  pinnedFirst,
  SEGMENT_SORT_KEYS,
  sortSegments,
  totalPages as computeTotalPages,
  type SegmentSortKey,
  type SortOrder,
} from "./segments-list-helpers";

const PER_PAGE = 25;

function SegmentSecondaryLoading({ label }: { label: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-sm text-muted-foreground"
    >
      Loading {label}…
    </p>
  );
}

// The saved-segment table is the primary surface. Intelligence, parity tools,
// and AI suggestions are independent secondary panels and can hydrate without
// forcing their API and dialog graphs into the route's first payload. The
// delete confirmations (DeferredConfirmDialog) likewise load when first
// opened.
const LazyAudienceIntelligencePanel = dynamic(
  () =>
    import("@/components/mailchimp-parity/audience-intelligence-panel").then(
      (module) => module.AudienceIntelligencePanel,
    ),
  {
    ssr: false,
    loading: () => <SegmentSecondaryLoading label="audience intelligence" />,
  },
);
const LazySegmentParitySuite = dynamic(
  () =>
    import("@/components/segments/segment-parity-suite").then(
      (module) => module.SegmentParitySuite,
    ),
  {
    ssr: false,
    loading: () => <SegmentSecondaryLoading label="segment tools" />,
  },
);
const LazyAiSuggestionsPanel = dynamic(
  () =>
    import("@/components/segments/ai-suggestions-panel").then(
      (module) => module.AiSuggestionsPanel,
    ),
  {
    ssr: false,
    loading: () => <SegmentSecondaryLoading label="segment suggestions" />,
  },
);

/** localStorage-backed pin set, scoped per tenant (SEG-052). */
function usePinnedSegments(tenantId: string) {
  const storageKey = `postwave:segment-pins:${tenantId}`;
  const [pinned, setPinned] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setPinned(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch {
      setPinned(new Set());
    }
  }, [storageKey]);
  const toggle = React.useCallback(
    (id: string) => {
      // Persist outside the updater. React may invoke an updater more than
      // once per update, and a render it then discards would leave the write
      // committed — storage saying pinned while state says otherwise.
      const next = new Set(pinned);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setPinned(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...next]));
      } catch {
        /* storage unavailable — pins stay in-memory this session */
      }
    },
    [pinned, storageKey],
  );
  return { pinned, toggle };
}

const listSchema = {
  page: intParam(1),
  q: stringParam(""),
  sort: enumParam(SEGMENT_SORT_KEYS, "name"),
  order: enumParam(["asc", "desc"] as const, "asc"),
  // Folder filter (SEG-038): "all" | "unfiled" | <folderId>.
  folder: stringParam(FOLDER_ALL),
} as const;

export function SegmentsList({
  initialSegments,
}: {
  initialSegments: Segment[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const deleteFallbackFocusRef = React.useRef<HTMLAnchorElement>(null);
  const { state, setState, reset } = useTableUrlState(listSchema);
  const { page, q: appliedQuery, sort, order, folder } = state;

  const me = useQuery({
    queryKey: qk.authMe(),
    queryFn: whoami,
    staleTime: STALE.authMe,
  });
  const tenantId = me.data?.tenant_id ?? "anon";
  const role = me.data ? effectiveAuthRole(me.data) : null;
  // Effective role, so an owner previewing in View-as-Viewer is gated the same
  // way a real viewer is. Every write control on this surface — create, the
  // bulk bar, recompute, the row menu, folders — hangs off this one flag:
  // rendering a Delete confirmation for a role whose request can only 403
  // makes the dialog lie about what is about to happen.
  const canMutate =
    me.isSuccess && me.data.viewer_mode !== true && role !== "viewer";

  const segmentsKey = React.useMemo(
    () => qk.segments(tenantId, role, null),
    [tenantId, role],
  );
  const segmentsBaseKey = React.useMemo(
    () => base("segments", tenantId, role),
    [tenantId, role],
  );

  const segmentsQuery = useQuery({
    queryKey: segmentsKey,
    queryFn: listSegments,
    initialData: initialSegments,
    staleTime: STALE.list,
  });
  // `??` only guards null/undefined. A response that is a 200 but not an array
  // (an older API shape, an error envelope, a proxy that wrapped the body) made
  // `for (const s of segments)` throw "segments is not iterable" and took the
  // page down. Coerce instead, the way the team roster already does, so a wrong
  // shape degrades to an empty list rather than a blank screen.
  const segments = React.useMemo(
    () =>
      Array.isArray(segmentsQuery.data)
        ? segmentsQuery.data
        : Array.isArray(initialSegments)
          ? initialSegments
          : [],
    [initialSegments, segmentsQuery.data],
  );

  // Folders (SEG-038). Its own query so a folder-list failure never blanks the
  // segment table (the bar just renders empty and the filter falls back to All).
  const foldersKey = React.useMemo(
    () => base("segment-folders", tenantId, role),
    [tenantId, role],
  );
  const foldersQuery = useQuery({
    queryKey: foldersKey,
    queryFn: listSegmentFolders,
    staleTime: STALE.list,
  });
  const folders = React.useMemo(
    () => (Array.isArray(foldersQuery.data) ? foldersQuery.data : []),
    [foldersQuery.data],
  );
  // Per-folder counts (+ the unfiled bucket) from the full set, so the bar
  // shows sizes independent of the text search / current page.
  const folderCounts = React.useMemo(() => {
    const counts = new Map<string, number>();
    let unfiled = 0;
    for (const s of segments) {
      if (s.folderId) counts.set(s.folderId, (counts.get(s.folderId) ?? 0) + 1);
      else unfiled += 1;
    }
    return { counts, unfiled };
  }, [segments]);

  const [query, setQuery] = React.useState(appliedQuery);
  React.useEffect(() => setQuery(appliedQuery), [appliedQuery]);

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [recomputing, setRecomputing] = React.useState<Set<string>>(new Set());

  // If the active folder filter points at a folder that no longer exists
  // (deleted elsewhere), fall back to All so the table isn't stuck empty.
  React.useEffect(() => {
    if (
      folder !== FOLDER_ALL &&
      folder !== FOLDER_UNFILED &&
      foldersQuery.isSuccess &&
      !folders.some((f) => f.id === folder)
    ) {
      setState({ folder: FOLDER_ALL, page: 1 });
    }
  }, [folder, folders, foldersQuery.isSuccess, setState]);

  const filtered = React.useMemo(
    () => filterSegments(filterByFolder(segments, folder), appliedQuery),
    [segments, folder, appliedQuery],
  );
  const { pinned, toggle: togglePin } = usePinnedSegments(tenantId);
  const sorted = React.useMemo(
    () => pinnedFirst(sortSegments(filtered, sort, order), pinned),
    [filtered, sort, order, pinned],
  );
  const total = sorted.length;
  const totalPages = computeTotalPages(total, PER_PAGE);
  const clampedPage = Math.min(page, totalPages);
  const pageRows = React.useMemo(
    () => paginate(sorted, clampedPage, PER_PAGE),
    [sorted, clampedPage],
  );

  // Clear selection whenever the visible result set changes underneath it.
  React.useEffect(() => {
    setSelected(new Set());
  }, [appliedQuery, sort, order, clampedPage, folder]);

  const updateCache = (updater: (rows: Segment[]) => Segment[]) => {
    queryClient.setQueryData<Segment[]>(segmentsKey, (cur) =>
      cur ? updater(cur) : cur,
    );
  };
  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: segmentsBaseKey,
      exact: false,
    });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setState({ q: query.trim(), page: 1 });
  };
  const clearSearch = () => {
    setQuery("");
    setState({ q: "", page: 1 });
  };
  const onSort = (key: SegmentSortKey) => {
    const nextOrder: SortOrder =
      sort === key && order === "asc" ? "desc" : "asc";
    setState({ sort: key, order: nextOrder, page: 1 });
  };
  const goToPage = (p: number) =>
    setState({ page: Math.min(Math.max(1, p), totalPages) });

  // --- Recompute (SEG-006) ------------------------------------------------
  const recompute = async (seg: Segment) => {
    setRecomputing((s) => new Set(s).add(seg.id));
    try {
      const res = await recomputeSegment(seg.id);
      updateCache((rows) =>
        rows.map((r) =>
          r.id === seg.id
            ? {
                ...r,
                lastCount: res.count,
                lastEvaluatedAt: res.scheduled_at,
              }
            : r,
        ),
      );
      toast.success(
        `Recalculated "${seg.name}" — ${res.count.toLocaleString()} subscribers.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Recalculate failed.");
    } finally {
      setRecomputing((s) => {
        const next = new Set(s);
        next.delete(seg.id);
        return next;
      });
    }
  };

  // --- Delete (with undo) -------------------------------------------------
  const removeSegment = async (seg: Segment) => {
    // Via the shared builder: this dropped `includeArchived`, so Undo restored
    // a segment whose archive scope — and therefore whose audience — differed
    // from the one that was deleted.
    const snapshot = restoreSegmentInput(seg);
    try {
      await deleteSegment(seg.id);
      updateCache((rows) => rows.filter((r) => r.id !== seg.id));
      toast.success(`Deleted "${seg.name}".`, {
        action: {
          label: "Undo",
          onClick: () => {
            void createSegment(snapshot)
              .then(() => {
                invalidate();
                toast.success("Segment restored.");
              })
              .catch(() => toast.error("Could not restore."));
          },
        },
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed.");
    }
  };

  const duplicate = async (seg: Segment) => {
    try {
      const copy = await createSegment(
        duplicateSegmentInput(
          seg,
          { description: seg.description, queryAst: seg.queryAst },
          segments.map((s) => s.name),
        ),
      );
      invalidate();
      toast.success("Segment duplicated.");
      router.push(`/app/subscribers/segments/${copy.id}/edit`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not duplicate.");
    }
  };

  const useInCampaign = async (seg: Segment) => {
    try {
      const campaign = await createCampaign({
        name: `Campaign for ${seg.name}`,
        subject: `Message to ${seg.name}`,
        segment_id: seg.id,
      });
      toast.success("Draft campaign created.");
      router.push(`/app/campaigns/${campaign.id}`);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create campaign.",
      );
    }
  };

  // --- Folders (SEG-038) --------------------------------------------------
  const invalidateFolders = () =>
    void queryClient.invalidateQueries({ queryKey: foldersKey, exact: false });

  // Move a single segment into a folder (folderId) or unfile it (null). The
  // API treats "" as unfile; nil would leave it unchanged, so pass "".
  const moveToFolder = async (seg: Segment, folderId: string | null) => {
    try {
      const updated = await updateSegment(seg.id, { folderId: folderId ?? "" });
      updateCache((rows) =>
        rows.map((r) =>
          r.id === seg.id ? { ...r, folderId: updated.folderId ?? null } : r,
        ),
      );
      const name = folderId
        ? (folders.find((f) => f.id === folderId)?.name ?? "folder")
        : null;
      toast.success(
        name
          ? `Moved "${seg.name}" to ${name}.`
          : `Removed "${seg.name}" from its folder.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not move segment.",
      );
    }
  };

  const handleCreateFolder = async (
    name: string,
  ): Promise<SegmentFolder | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    try {
      const created = await createSegmentFolder(trimmed);
      // Seed the cache synchronously so the new folder id is present BEFORE the
      // caller selects it — otherwise the stale-folder-fallback effect would
      // bounce the selection back to All while the background refetch is still
      // in flight.
      queryClient.setQueryData<SegmentFolder[]>(foldersKey, (cur) =>
        cur ? [...cur, created] : [created],
      );
      invalidateFolders();
      toast.success(`Folder "${created.name}" created.`);
      return created;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not create folder.",
      );
      return null;
    }
  };

  const handleDeleteFolder = async (f: SegmentFolder) => {
    try {
      await deleteSegmentFolder(f.id);
      // Segments in the folder are unfiled server-side (ON DELETE SET NULL);
      // refetch both lists so counts + folderId reflect it.
      invalidateFolders();
      invalidate();
      if (folder === f.id) setState({ folder: FOLDER_ALL, page: 1 });
      toast.success(
        `Folder "${f.name}" deleted. Its segments moved to Unfiled.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not delete folder.",
      );
    }
  };

  // --- Bulk ---------------------------------------------------------------
  const selectedRows = pageRows.filter((r) => selected.has(r.id));
  const toggleRow = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOnPageSelected =
    pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));
  const toggleAllOnPage = () =>
    setSelected(
      allOnPageSelected ? new Set() : new Set(pageRows.map((r) => r.id)),
    );

  const bulkRecompute = async () => {
    const targets = [...selectedRows];
    // Consume this action's selection before any request can settle. Clearing
    // it after the awaits lets that stale completion erase a newer selection
    // (and can unmount a bulk-delete dialog the user opened in the meantime).
    setSelected(new Set());
    for (const seg of targets) {
      // Sequential on purpose: recompute is server-expensive, and firing the
      // whole selection at once would stampede the segment evaluator.
      await recompute(seg);
    }
  };
  const bulkDelete = async () => {
    const targets = [...selectedRows];
    // Only drop rows that actually deleted — a failed delete must NOT vanish
    // from the list while it still exists server-side (audit MUST-FIX).
    const deletedIds: string[] = [];
    // Why the first refusal happened, in the server's words (it names the
    // campaigns holding a segment), so "the rest still exist" has a reason.
    let firstFailure: { name: string; reason: string } | null = null;
    for (const seg of targets) {
      try {
        // Sequential on purpose: each delete is independently reported, and a
        // parallel burst would make partial-failure attribution ambiguous.
        await deleteSegment(seg.id);
        deletedIds.push(seg.id);
      } catch (err) {
        /* left in the list; reported below */
        firstFailure ??= {
          name: seg.name,
          reason: err instanceof Error && err.message ? err.message : "",
        };
      }
    }
    if (deletedIds.length) {
      updateCache((rows) => rows.filter((r) => !deletedIds.includes(r.id)));
    }
    // Keep any that failed selected so the user can retry.
    setSelected(
      new Set(
        targets.filter((t) => !deletedIds.includes(t.id)).map((t) => t.id),
      ),
    );
    const ok = deletedIds.length;
    if (ok === targets.length)
      toast.success(`Deleted ${ok} segment${ok === 1 ? "" : "s"}.`);
    else {
      const kept = targets.length - ok;
      toast.warning(
        `Deleted ${ok} of ${targets.length}. ${kept === 1 ? "1 segment was" : `${kept} segments were`} kept and ${kept === 1 ? "is" : "are"} still selected.`,
        firstFailure?.reason
          ? { description: `"${firstFailure.name}": ${firstFailure.reason}` }
          : undefined,
      );
    }
  };

  const loading = segmentsQuery.isLoading && segments.length === 0;
  const isFiltered = appliedQuery.trim().length > 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">
            Segments{" "}
            <span className="text-base font-normal tabular-nums text-muted-foreground">
              ({segments.length.toLocaleString()})
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Saved subscriber filters. Reuse them as campaign audiences or
            automation entry conditions.
          </p>
          {me.isSuccess && !canMutate ? (
            <p className="mt-1 text-xs text-muted-foreground">
              You can review segments, but changing them requires an editor role
              or higher.
            </p>
          ) : null}
        </div>
        {canMutate ? (
          <Button asChild>
            <Link
              ref={deleteFallbackFocusRef}
              href="/app/subscribers/segments/new"
            >
              <Plus className="h-4 w-4" />
              New segment
            </Link>
          </Button>
        ) : null}
      </div>

      <LazyAudienceIntelligencePanel collapsible />

      <LazySegmentParitySuite
        segments={segments}
        tenantId={tenantId}
        role={role}
        identityReady={me.isSuccess}
        identityLoading={me.isLoading}
        identityError={me.isError}
        onRetryIdentity={() => void me.refetch()}
        canMutate={canMutate}
      />

      {segments.length > 0 ? <LazyAiSuggestionsPanel /> : null}

      {segments.length === 0 && !loading ? (
        <div className="rounded-lg border bg-card">
          <EmptyState
            icon={Users}
            title="No segments yet"
            description="Segments are saved filters over your audience — 'opened in the last 30 days', 'VIP customers', 'never purchased'. Build one to reuse as a campaign audience or automation trigger."
            action={
              canMutate ? (
                <Button asChild>
                  <Link href="/app/subscribers/segments/new">
                    <Plus className="h-4 w-4" />
                    Create your first segment
                  </Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <>
          <form className="flex gap-2" onSubmit={handleSearch}>
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9 pr-9"
                aria-label="Search segments"
                placeholder="Search by name or description"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={clearSearch}
                  className="absolute right-0 top-1/2 inline-flex size-11 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:right-1 sm:size-8"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>

          <FolderBar
            folders={folders}
            active={folder}
            counts={folderCounts}
            totalCount={segments.length}
            onSelect={(f) => setState({ folder: f, page: 1 })}
            onCreateFolder={handleCreateFolder}
            onDeleteFolder={handleDeleteFolder}
            canMutate={canMutate}
          />

          {selected.size > 0 && canMutate ? (
            <div
              role="group"
              aria-label="Bulk segment actions"
              className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-md border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm shadow-sm backdrop-blur"
            >
              <span className="font-medium tabular-nums">
                {selected.size} selected
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => void bulkRecompute()}
                >
                  <RefreshCw className="h-4 w-4" />
                  Recalculate
                </Button>
                <DeferredConfirmDialog
                  title={`Delete ${selected.size} segment${selected.size === 1 ? "" : "s"}?`}
                  description={BULK_DELETE_DESCRIPTION}
                  confirmLabel="Delete"
                  onConfirm={bulkDelete}
                  trigger={
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  }
                />
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </Button>
              </div>
            </div>
          ) : null}

          {loading ? (
            <TableSkeleton
              rows={6}
              columns={["w-10", "w-48", "w-16", "w-28", "w-20"]}
            />
          ) : (
            <SegmentsTable
              rows={pageRows}
              isFiltered={isFiltered}
              folderFiltered={folder !== FOLDER_ALL}
              onClearFilters={() => {
                setQuery("");
                reset();
              }}
              selected={selected}
              allOnPageSelected={allOnPageSelected}
              onToggleRow={toggleRow}
              onToggleAllOnPage={toggleAllOnPage}
              sort={sort}
              order={order}
              onSort={onSort}
              recomputing={recomputing}
              onRecompute={recompute}
              onDelete={removeSegment}
              onDuplicate={duplicate}
              onUseInCampaign={useInCampaign}
              pinned={pinned}
              onTogglePin={togglePin}
              folders={folders}
              onMoveToFolder={moveToFolder}
              deleteFallbackFocusRef={deleteFallbackFocusRef}
              canMutate={canMutate}
            />
          )}

          <Pagination
            page={clampedPage}
            totalPages={totalPages}
            total={total}
            perPage={PER_PAGE}
            rowsOnPage={pageRows.length}
            onPrev={() => goToPage(clampedPage - 1)}
            onNext={() => goToPage(clampedPage + 1)}
          />
        </>
      )}
    </div>
  );
}

// --- Table ----------------------------------------------------------------

function SortHeader({
  label,
  sortKey,
  sort,
  order,
  onSort,
  align = "left",
}: {
  label: string;
  sortKey: SegmentSortKey;
  sort: SegmentSortKey;
  order: SortOrder;
  onSort: (key: SegmentSortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort === sortKey;
  return (
    <th
      scope="col"
      className={`px-4 py-2 font-medium ${align === "right" ? "text-right" : "text-left"}`}
      aria-sort={
        active ? (order === "asc" ? "ascending" : "descending") : "none"
      }
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${align === "right" ? "flex-row-reverse" : ""}`}
        aria-label={`Sort by ${label}`}
      >
        {label}
        {active ? (
          order === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </th>
  );
}

function SegmentsTable({
  rows,
  isFiltered,
  folderFiltered,
  onClearFilters,
  selected,
  allOnPageSelected,
  onToggleRow,
  onToggleAllOnPage,
  sort,
  order,
  onSort,
  recomputing,
  onRecompute,
  onDelete,
  onDuplicate,
  onUseInCampaign,
  pinned,
  onTogglePin,
  folders,
  onMoveToFolder,
  deleteFallbackFocusRef,
  canMutate,
}: {
  rows: Segment[];
  isFiltered: boolean;
  folderFiltered: boolean;
  onClearFilters: () => void;
  selected: Set<string>;
  allOnPageSelected: boolean;
  onToggleRow: (id: string) => void;
  onToggleAllOnPage: () => void;
  sort: SegmentSortKey;
  order: SortOrder;
  onSort: (key: SegmentSortKey) => void;
  recomputing: Set<string>;
  onRecompute: (seg: Segment) => void;
  onDelete: (seg: Segment) => void | Promise<void>;
  onDuplicate: (seg: Segment) => void;
  onUseInCampaign: (seg: Segment) => void;
  pinned: ReadonlySet<string>;
  onTogglePin: (id: string) => void;
  folders: SegmentFolder[];
  onMoveToFolder: (seg: Segment, folderId: string | null) => void;
  deleteFallbackFocusRef: React.RefObject<HTMLElement | null>;
  canMutate: boolean;
}) {
  const headerCbRef = React.useRef<HTMLInputElement>(null);
  const someSelected = selected.size > 0 && !allOnPageSelected;
  React.useEffect(() => {
    if (headerCbRef.current) headerCbRef.current.indeterminate = someSelected;
  }, [someSelected]);

  if (rows.length === 0) {
    // Folder-aware copy: a folder with no segments isn't a failed search.
    const emptyMsg = isFiltered
      ? "No segments match your search."
      : folderFiltered
        ? "No segments in this folder yet. Use a row's “Move to folder” action to file one here."
        : "No segments match your filter.";
    return (
      <div className="rounded-md border bg-card py-8 text-center">
        <p className="text-sm text-muted-foreground">{emptyMsg}</p>
        {isFiltered ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={onClearFilters}
          >
            Clear search
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {/* Mobile cards (SEG-018) */}
      <div className="space-y-3 md:hidden">
        {rows.map((s) => (
          <SegmentCard
            key={s.id}
            segment={s}
            selected={selected.has(s.id)}
            onToggle={() => onToggleRow(s.id)}
            recomputing={recomputing.has(s.id)}
            onRecompute={() => onRecompute(s)}
            onDelete={() => onDelete(s)}
            onDuplicate={() => onDuplicate(s)}
            onUseInCampaign={() => onUseInCampaign(s)}
            pinned={pinned.has(s.id)}
            onTogglePin={() => onTogglePin(s.id)}
            folders={folders}
            onMoveToFolder={onMoveToFolder}
            deleteFallbackFocusRef={deleteFallbackFocusRef}
            canMutate={canMutate}
          />
        ))}
      </div>

      {/* Desktop table */}
      <div
        role="region"
        aria-label="Saved segments"
        data-tour="dashboard-segment-library"
        tabIndex={0}
        className="hidden overflow-x-auto rounded-md border bg-card md:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <table className="w-full text-sm">
          <caption className="sr-only">Saved segments</caption>
          <thead className="sticky top-0 z-10 bg-muted/70 text-xs uppercase tracking-wide text-muted-foreground backdrop-blur">
            <tr>
              {/* Selection exists only to drive the bulk bar, so a role that
                  cannot bulk-recalculate or bulk-delete gets no checkboxes
                  rather than a column that selects into nothing. */}
              {canMutate ? (
                <th scope="col" className="w-10 px-4 py-2">
                  <input
                    ref={headerCbRef}
                    type="checkbox"
                    aria-label="Select all segments on this page"
                    className="h-4 w-4 cursor-pointer rounded border-input accent-primary align-middle"
                    checked={allOnPageSelected}
                    onChange={onToggleAllOnPage}
                  />
                </th>
              ) : null}
              <SortHeader
                label="Name"
                sortKey="name"
                sort={sort}
                order={order}
                onSort={onSort}
              />
              <SortHeader
                label="Count"
                sortKey="count"
                sort={sort}
                order={order}
                onSort={onSort}
                align="right"
              />
              <SortHeader
                label="Last evaluated"
                sortKey="evaluated"
                sort={sort}
                order={order}
                onSort={onSort}
              />
              <th scope="col" className="px-4 py-2 text-right font-medium">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((s) => (
              <tr
                key={s.id}
                className={`hover:bg-muted/30 ${selected.has(s.id) ? "bg-primary/5" : ""}`}
              >
                {canMutate ? (
                  <td className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${s.name}`}
                      className="h-4 w-4 cursor-pointer rounded border-input accent-primary align-middle"
                      checked={selected.has(s.id)}
                      onChange={() => onToggleRow(s.id)}
                    />
                  </td>
                ) : null}
                <td className="px-4 py-3">
                  <Link
                    href={`/app/subscribers/segments/${s.id}`}
                    className="block max-w-md truncate font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {s.name}
                  </Link>
                  {s.description ? (
                    <div className="line-clamp-1 max-w-md text-xs text-muted-foreground">
                      {s.description}
                    </div>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {typeof s.lastCount === "number" ? (
                    s.lastCount.toLocaleString()
                  ) : (
                    <NotCounted />
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">
                  {s.lastEvaluatedAt ? (
                    <span title={absoluteTime(s.lastEvaluatedAt)}>
                      {timeAgo(s.lastEvaluatedAt) || "—"}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Not yet</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {/* Pins are a local per-viewer preference, so they stay.
                        Recompute POSTs and every row-menu entry writes, so
                        both are withheld from a read-only role. */}
                    <PinButton
                      pinned={pinned.has(s.id)}
                      onClick={() => onTogglePin(s.id)}
                    />
                    {canMutate ? (
                      <>
                        <RecomputeButton
                          busy={recomputing.has(s.id)}
                          onClick={() => onRecompute(s)}
                        />
                        <RowMenu
                          segment={s}
                          onDelete={() => onDelete(s)}
                          onDuplicate={() => onDuplicate(s)}
                          onUseInCampaign={() => onUseInCampaign(s)}
                          folders={folders}
                          onMoveToFolder={onMoveToFolder}
                          deleteFallbackFocusRef={deleteFallbackFocusRef}
                        />
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PinButton({
  pinned,
  onClick,
}: {
  pinned: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin segment" : "Pin segment to top"}
      title={pinned ? "Unpin" : "Pin to top"}
      onClick={onClick}
    >
      {pinned ? (
        <Pin className="h-4 w-4 fill-current text-primary" />
      ) : (
        <PinOff className="h-4 w-4 text-muted-foreground" />
      )}
    </Button>
  );
}

function RecomputeButton({
  busy,
  onClick,
}: {
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Recalculate count"
      title="Recalculate count"
      disabled={busy}
      onClick={onClick}
    >
      <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
    </Button>
  );
}

export function RowMenu({
  segment,
  onDelete,
  onDuplicate,
  onUseInCampaign,
  folders,
  onMoveToFolder,
  deleteFallbackFocusRef,
}: {
  segment: Segment;
  onDelete: () => void | Promise<void>;
  onDuplicate: () => void;
  onUseInCampaign: () => void;
  folders: SegmentFolder[];
  onMoveToFolder: (seg: Segment, folderId: string | null) => void;
  deleteFallbackFocusRef?: React.RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const [folderOpen, setFolderOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  // Collapse the folder sub-list whenever the menu closes.
  React.useEffect(() => {
    if (!open) setFolderOpen(false);
  }, [open]);

  const itemClass =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none";

  const confirmDelete = async () => {
    const rowTrigger = triggerRef.current;
    const safeFallback = deleteFallbackFocusRef?.current;
    await onDelete();
    // A successful delete normally removes this entire row (and therefore the
    // dialog) before ConfirmDialog can run its own close-focus callback. Move
    // focus to the stable header action only in that disconnected-trigger case.
    requestAnimationFrame(() => {
      if (!rowTrigger?.isConnected && safeFallback?.isConnected) {
        safeFallback.focus();
      }
    });
  };

  return (
    <div className="relative" ref={ref}>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${segment.name}`}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal className="h-4 w-4" />
      </Button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-52 overflow-hidden rounded-md border bg-popover py-1 shadow-md"
        >
          <Link
            role="menuitem"
            href={`/app/subscribers/segments/${segment.id}`}
            className={itemClass}
            onClick={() => setOpen(false)}
          >
            <Users className="h-4 w-4" /> Overview
          </Link>
          <Link
            role="menuitem"
            href={`/app/subscribers/segments/${segment.id}/edit`}
            className={itemClass}
            onClick={() => setOpen(false)}
          >
            <Pencil className="h-4 w-4" /> Edit
          </Link>
          <button
            role="menuitem"
            type="button"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              onDuplicate();
            }}
          >
            <Copy className="h-4 w-4" /> Duplicate
          </button>
          <button
            role="menuitem"
            type="button"
            className={itemClass}
            onClick={() => {
              setOpen(false);
              onUseInCampaign();
            }}
          >
            <Megaphone className="h-4 w-4" /> Use in a campaign
          </button>

          {/* Move to folder (SEG-038). Expands an in-menu list of the tenant's
              folders + an "unfile" option; the check marks the current one. */}
          <button
            role="menuitem"
            type="button"
            aria-expanded={folderOpen}
            className={`${itemClass} justify-between`}
            onClick={() => setFolderOpen((v) => !v)}
          >
            <span className="flex items-center gap-2">
              <Folder className="h-4 w-4" /> Move to folder
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
          </button>
          {folderOpen ? (
            <div className="max-h-48 overflow-auto border-y bg-muted/30 py-1">
              <button
                role="menuitem"
                type="button"
                className={`${itemClass} text-xs`}
                onClick={() => {
                  setOpen(false);
                  onMoveToFolder(segment, null);
                }}
              >
                <Check
                  className={`h-3.5 w-3.5 ${segment.folderId ? "opacity-0" : ""}`}
                  aria-hidden
                />
                None (unfiled)
              </button>
              {folders.length === 0 ? (
                <p className="px-3 py-1.5 text-xs text-muted-foreground">
                  No folders yet — create one from the bar above.
                </p>
              ) : (
                folders.map((f) => (
                  <button
                    key={f.id}
                    role="menuitem"
                    type="button"
                    className={`${itemClass} text-xs`}
                    onClick={() => {
                      setOpen(false);
                      onMoveToFolder(segment, f.id);
                    }}
                  >
                    <Check
                      className={`h-3.5 w-3.5 ${segment.folderId === f.id ? "" : "opacity-0"}`}
                      aria-hidden
                    />
                    <span className="truncate">{f.name}</span>
                  </button>
                ))
              )}
            </div>
          ) : null}

          <div className="my-1 h-px bg-border" />
          <button
            role="menuitem"
            type="button"
            className={`${itemClass} text-destructive`}
            onClick={() => {
              setOpen(false);
              setDeleteOpen(true);
            }}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </button>
        </div>
      ) : null}
      {/* The portal is controlled from the stable RowMenu root, never from the
          conditional menu subtree. Pointer-down inside the portal can close
          the menu without unmounting its own confirmation before click. */}
      <DeferredConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete segment?"
        description={segmentRowDeleteDescription(segment.name)}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        fallbackFocusRef={triggerRef}
      />
    </div>
  );
}

/**
 * A segment whose size has not been recorded. New segments are counted when
 * they are saved; this remains only when that count could not finish in time.
 */
function NotCounted() {
  return (
    <span
      className="text-muted-foreground"
      title="Not counted yet. Recalculate counts it now."
    >
      <span aria-hidden>—</span>
      <span className="sr-only">Not counted yet</span>
    </span>
  );
}

function SegmentCard({
  segment,
  selected,
  onToggle,
  recomputing,
  onRecompute,
  onDelete,
  onDuplicate,
  onUseInCampaign,
  pinned,
  onTogglePin,
  folders,
  onMoveToFolder,
  deleteFallbackFocusRef,
  canMutate,
}: {
  segment: Segment;
  selected: boolean;
  onToggle: () => void;
  recomputing: boolean;
  onRecompute: () => void;
  onDelete: () => void | Promise<void>;
  onDuplicate: () => void;
  onUseInCampaign: () => void;
  pinned: boolean;
  onTogglePin: () => void;
  folders: SegmentFolder[];
  onMoveToFolder: (seg: Segment, folderId: string | null) => void;
  deleteFallbackFocusRef: React.RefObject<HTMLElement | null>;
  canMutate: boolean;
}) {
  return (
    <article
      className={`rounded-md border bg-card p-4 text-sm shadow-sm ${selected ? "ring-1 ring-primary/40" : ""}`}
    >
      <div className="flex items-start gap-3">
        {canMutate ? (
          <label className="-m-3 inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-sm focus-within:ring-2 focus-within:ring-ring">
            <input
              type="checkbox"
              aria-label={`Select ${segment.name}`}
              className="h-4 w-4 cursor-pointer rounded border-input accent-primary"
              checked={selected}
              onChange={onToggle}
            />
          </label>
        ) : null}
        <div className="min-w-0 flex-1">
          <Link
            href={`/app/subscribers/segments/${segment.id}`}
            className="flex min-h-11 items-center rounded-sm font-medium leading-snug hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
          >
            {segment.name}
          </Link>
          {segment.description ? (
            <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
              {segment.description}
            </div>
          ) : null}
        </div>
        <PinButton pinned={pinned} onClick={onTogglePin} />
        {canMutate ? (
          <RowMenu
            segment={segment}
            onDelete={onDelete}
            onDuplicate={onDuplicate}
            onUseInCampaign={onUseInCampaign}
            folders={folders}
            onMoveToFolder={onMoveToFolder}
            deleteFallbackFocusRef={deleteFallbackFocusRef}
          />
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="font-medium uppercase text-muted-foreground">
            Count
          </div>
          <div className="mt-1 tabular-nums">
            {typeof segment.lastCount === "number" ? (
              segment.lastCount.toLocaleString()
            ) : (
              <NotCounted />
            )}
          </div>
        </div>
        <div>
          <div className="font-medium uppercase text-muted-foreground">
            Last evaluated
          </div>
          <div
            className="mt-1"
            title={
              segment.lastEvaluatedAt
                ? absoluteTime(segment.lastEvaluatedAt)
                : undefined
            }
          >
            {segment.lastEvaluatedAt
              ? timeAgo(segment.lastEvaluatedAt) || "—"
              : "Not yet"}
          </div>
        </div>
      </div>
      {canMutate ? (
        <div className="mt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRecompute}
            disabled={recomputing}
          >
            <RefreshCw
              className={`h-4 w-4 ${recomputing ? "animate-spin" : ""}`}
            />
            Recalculate
          </Button>
        </div>
      ) : null}
    </article>
  );
}

// --- Folder bar (SEG-038) -------------------------------------------------
// Chips to group/filter the list by folder (All / Unfiled / each folder), an
// inline "New folder" creator, and a delete affordance for the active folder.
function FolderBar({
  folders,
  active,
  counts,
  totalCount,
  onSelect,
  onCreateFolder,
  onDeleteFolder,
  canMutate,
}: {
  folders: SegmentFolder[];
  active: string;
  counts: { counts: Map<string, number>; unfiled: number };
  totalCount: number;
  onSelect: (folder: string) => void;
  onCreateFolder: (name: string) => Promise<SegmentFolder | null>;
  onDeleteFolder: (folder: SegmentFolder) => void | Promise<void>;
  canMutate: boolean;
}) {
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const created = await onCreateFolder(name);
    setBusy(false);
    if (created) {
      setName("");
      setCreating(false);
      onSelect(created.id); // jump to the new (empty) folder.
    }
  };

  const chip = (key: string, label: string, count: number) => (
    <button
      key={key}
      type="button"
      aria-pressed={active === key}
      onClick={() => onSelect(key)}
      className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors sm:min-h-8 ${
        active === key
          ? "border-primary bg-primary/10 text-primary"
          : "border-border text-muted-foreground hover:bg-muted"
      }`}
    >
      <span>{label}</span>
      <span className="tabular-nums opacity-70">{count.toLocaleString()}</span>
    </button>
  );

  const activeFolder =
    active !== FOLDER_ALL && active !== FOLDER_UNFILED
      ? folders.find((f) => f.id === active)
      : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chip(FOLDER_ALL, "All", totalCount)}
      {chip(FOLDER_UNFILED, "Unfiled", counts.unfiled)}
      {folders.map((f) => chip(f.id, f.name, counts.counts.get(f.id) ?? 0))}

      {/* The chips above are a read-only filter, so they stay for every role;
          creating and deleting folders are writes and do not. */}
      {!canMutate ? null : creating ? (
        <form onSubmit={submit} className="flex items-center gap-1">
          <Input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setCreating(false);
                setName("");
              }
            }}
            placeholder="Folder name"
            aria-label="New folder name"
            className="h-11 w-36 text-xs sm:h-8"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busy || !name.trim()}
            className="min-h-11 sm:min-h-8"
          >
            Add
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            className="min-h-11 sm:min-h-8"
            onClick={() => {
              setCreating(false);
              setName("");
            }}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8"
        >
          <FolderPlus className="h-3.5 w-3.5" /> New folder
        </button>
      )}

      {activeFolder && canMutate ? (
        <DeferredConfirmDialog
          title={`Delete folder "${activeFolder.name}"?`}
          description="The folder is removed. Segments filed under it are moved to Unfiled, not deleted."
          confirmLabel="Delete folder"
          onConfirm={() => onDeleteFolder(activeFolder)}
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-1 text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete folder
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  total,
  perPage,
  rowsOnPage,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  total: number;
  perPage: number;
  rowsOnPage: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  if (total <= perPage && page === 1) return null;
  const start = total === 0 ? 0 : (page - 1) * perPage + 1;
  const end = (page - 1) * perPage + rowsOnPage;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
      <span className="tabular-nums">
        Showing{" "}
        <span className="font-medium text-foreground">
          {start.toLocaleString()}
        </span>
        -
        <span className="font-medium text-foreground">
          {end.toLocaleString()}
        </span>{" "}
        of{" "}
        <span className="font-medium text-foreground">
          {total.toLocaleString()}
        </span>
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={onPrev}
          disabled={page <= 1}
        >
          Previous
        </Button>
        <span className="tabular-nums">
          Page {page} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          type="button"
          onClick={onNext}
          disabled={page >= totalPages}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
