/**
 * Segments — top-level audience page for saved-segment management.
 *
 * Closes GAP-LS-003: backend has the full segments package + NL compiler
 * + preview-count + recompute endpoints, but no surface ever existed.
 * Layout mirrors Lists.tsx so the two audience surfaces feel like
 * siblings rather than separate apps:
 *   1. PageHeader (eyebrow "Audience").
 *   2. Search input + Dynamic/Static/AI filter chips.
 *   3. SegmentsList table.
 *   4. NaturalLanguageBuilder modal for "New segment".
 *   5. SegmentDetailSlideover for row-click.
 *
 * Backend surfaces consumed:
 *   GET    /api/v1/segments
 *   POST   /api/v1/segments
 *   POST   /api/v1/segments/compile-from-text
 *   POST   /api/v1/segments/preview-count
 *   POST   /api/v1/segments/{id}/recompute
 *   DELETE /api/v1/segments/{id}
 *
 * Full-surface wiring 2026-06 added two sibling sections below the
 * saved-segment table:
 *   - "Recipes" (#25): GET /api/v1/preset-segments (+/{key}/list) —
 *     live preset cohorts with member preview and a "recreate via the
 *     NL builder" handoff (presets have no direct materialize API).
 *   - "RFM & predictive" (#26): /api/v1/predictive/* — R×F heat-grid,
 *     model catalog, per-email profile lookup, admin recompute.
 *   - Segment insights (R11): overlap visualizer (GET /segments/
 *     overlap?a=&b=) + per-segment growth sparkline (GET /segments/
 *     {id}/growth), composed below the table.
 */

import {
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { ConfirmModal } from "../components/ConfirmModal";
import { HeroEmptyState } from "../components/HeroEmptyState";
import { PageHeader } from "../components/PageHeader";
import { PendingSyncStatus } from "../components/PendingSyncStatus";
import { DataTablePagination } from "../components/table/DataTable";
import { HERO } from "../lib/heroAssets";
import { useCanWrite } from "../lib/store";
import { toast } from "../components/Toast";

import { LookalikeModal } from "../components/audiences/LookalikeModal";
import { AISuggestionsSection } from "../components/segments/AISuggestionsSection";
import { NaturalLanguageBuilder } from "../components/segments/NaturalLanguageBuilder";
import { PresetSegmentGallery } from "../components/segments/PresetSegmentGallery";
import { presetRecreateText } from "../components/segments/preset-segments-helpers";
import { RFMSection } from "../components/segments/RFMSection";
import { SavedSegmentsManager } from "../components/segments/SavedSegmentsManager";
import { SegmentDetailSlideover } from "../components/segments/SegmentDetailSlideover";
import { SegmentGrowthCard } from "../components/segments/SegmentGrowthCard";
import { SegmentOverlapCard } from "../components/segments/SegmentOverlapCard";
import { SegmentPerformanceComparison } from "../components/segments/SegmentPerformanceComparison";
import { SegmentsList } from "../components/segments/SegmentsList";
import { SegmentTemplateGallery } from "../components/segments/SegmentTemplateGallery";
import {
  type Segment,
  segmentsClient,
} from "../components/segments/segmentsClient";
import {
  consumePendingDeepLinkTarget,
  onPendingDeepLinkTarget,
} from "../lib/deep-link";

type Filter = "all" | "dynamic";

const PAGE_SIZE = 25;

// [D04-audience-core#9] The Static / AI-suggested chips are hidden: `kind`
// is a client-only marker the backend never sends (segmentsClient falls
// every row back to "dynamic"), so those chips could only ever render the
// "No segments match" empty state. Restore them once the segments API
// models `kind`.
const FILTER_CHIPS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "dynamic", label: "Dynamic" },
];

function pickRows(payload: unknown): Segment[] {
  if (Array.isArray(payload)) return payload as Segment[];
  if (payload && typeof payload === "object") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = payload as any;
    const list = r.items ?? r.results ?? r.data ?? [];
    return Array.isArray(list) ? (list as Segment[]) : [];
  }
  return [];
}

export function Segments(): ReactElement {
  const canMutate = useCanWrite();
  const [rows, setRows] = useState<Segment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(1);

  const [createOpen, setCreateOpen] = useState(false);
  // Seed text for the NL builder when arriving from a preset recipe's
  // "Recreate as segment" (cleared for the plain "New segment" CTA).
  const [builderSeed, setBuilderSeed] = useState<string | undefined>(undefined);
  // SUB-065 — when an AI suggestion's "Use as segment" is clicked we seed
  // the NL builder with the suggestion's pre-compiled AST + name so the
  // operator reviews the rule and saves without a recompile.
  const [builderAst, setBuilderAst] = useState<unknown>(undefined);
  const [builderName, setBuilderName] = useState<string | undefined>(undefined);
  const [openSegment, setOpenSegment] = useState<Segment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Segment | null>(null);
  const [deleting, setDeleting] = useState(false);
  // SUB-033 — lookalike-audience generation modal.
  const [lookalikeOpen, setLookalikeOpen] = useState(false);
  // SUB-036 audience performance comparison modal.
  const [compareOpen, setCompareOpen] = useState(false);
  const [pendingDeepLinkId, setPendingDeepLinkId] = useState<string | null>(
    null,
  );

  const acceptPendingTarget = useCallback(
    (t: { section: string; id: string } | null): void => {
      if (!t || t.section !== "segments" || !t.id) return;
      setPendingDeepLinkId(t.id);
      setQuery("");
      setFilter("all");
      setPage(1);
    },
    [],
  );

  const load = async (): Promise<void> => {
    setLoading(true);
    setErr(null);
    const res = await segmentsClient.list();
    if (res.error) {
      setErr(res.error.message);
      setRows([]);
    } else {
      setRows(pickRows(res.data));
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    acceptPendingTarget(consumePendingDeepLinkTarget());
    return onPendingDeepLinkTarget((t) => {
      if (t.section !== "segments") return;
      consumePendingDeepLinkTarget();
      acceptPendingTarget(t);
    });
  }, [acceptPendingTarget]);

  const filtered = useMemo<Segment[]>(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter !== "all") {
        const k = r.kind ?? "dynamic";
        if (k !== filter) return false;
      }
      if (q) {
        const name = (r.name ?? "").toLowerCase();
        const desc = (r.description ?? "").toLowerCase();
        if (!name.includes(q) && !desc.includes(q)) return false;
      }
      return true;
    });
  }, [rows, query, filter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    if (!pendingDeepLinkId || rows == null || loading) return;
    setPendingDeepLinkId(null);
    const match = rows.find(
      (r) =>
        String(r.id ?? "") === pendingDeepLinkId ||
        (r.name ?? "").toLowerCase() === pendingDeepLinkId.toLowerCase(),
    );
    if (match) {
      setOpenSegment(match);
    } else {
      toast.error("Couldn't find that segment — it may have been deleted.");
    }
  }, [pendingDeepLinkId, rows, loading]);

  const onCreated = (s: Segment): void => {
    setCreateOpen(false);
    setRows((prev) => (prev ? [s, ...prev] : [s]));
    setOpenSegment(s);
  };

  const onRecomputed = (next: Segment): void => {
    setRows((prev) =>
      prev ? prev.map((r) => (r.id === next.id ? { ...r, ...next } : r)) : prev,
    );
    setOpenSegment(next);
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleteTarget) return;
    setDeleting(true);
    const res = await segmentsClient.delete(deleteTarget.id);
    setDeleting(false);
    if (res.error) {
      toast.error({
        message: "Couldn't delete segment",
        detail: res.error.message,
      });
      return;
    }
    const removed = deleteTarget.name;
    setRows((prev) =>
      prev ? prev.filter((r) => r.id !== deleteTarget.id) : prev,
    );
    setDeleteTarget(null);
    setOpenSegment(null);
    toast.success(`Segment "${removed}" deleted`);
  };

  const totalLabel = rows
    ? `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()} segment${rows.length === 1 ? "" : "s"}`
    : "Loading…";

  return (
    <>
      <PageHeader
        eyebrow="Audience"
        title="Segments"
        subtitle={totalLabel}
        actions={[
          {
            label: loading ? "Refreshing…" : "Refresh",
            onClick: () => void load(),
            disabled: loading,
          },
          {
            label: "Create lookalike",
            onClick: () => setLookalikeOpen(true),
            disabled: !canMutate,
            title: canMutate
              ? "Generate an audience similar to a seed segment (SUB-033)"
              : "Viewer role can't create audiences",
          },
          {
            label: "Compare audiences",
            onClick: () => setCompareOpen(true),
            disabled: (rows?.length ?? 0) < 2,
            title:
              (rows?.length ?? 0) < 2
                ? "Save at least two segments to compare"
                : "Compare segments on revenue, engagement, and growth",
          },
          {
            label: "New segment",
            onClick: () => {
              setBuilderSeed(undefined);
              setBuilderAst(undefined);
              setBuilderName(undefined);
              setCreateOpen(true);
            },
            variant: "primary",
            disabled: !canMutate,
            title: canMutate ? undefined : "Viewer role can't create segments",
          },
        ]}
      />

      <PendingSyncStatus resource="segments" />

      <SegmentsResults
        rows={rows}
        loading={loading}
        error={err}
        query={query}
        filter={filter}
        page={page}
        pageRows={pageRows}
        totalPages={totalPages}
        filteredCount={filtered.length}
        canMutate={canMutate}
        onQueryChange={(nextQuery) => {
          setQuery(nextQuery);
          setPage(1);
        }}
        onFilterChange={(nextFilter) => {
          setFilter(nextFilter);
          setPage(1);
        }}
        onPageChange={setPage}
        onOpen={setOpenSegment}
        onCreate={() => {
          setBuilderSeed(undefined);
          setBuilderAst(undefined);
          setBuilderName(undefined);
          setCreateOpen(true);
        }}
      />

      {/* ----- saved-segment bookmarks organizer (SUB-040) ----- */}
      <SavedSegmentsManager canMutate={canMutate} />

      {/* ----- segment insights (R11): overlap + growth ----- */}
      <SegmentOverlapCard segments={rows ?? []} />
      <SegmentGrowthCard segments={rows ?? []} />

      {/* ----- preset recipes (#25) + RFM & predictive (#26) ----- */}
      <PresetSegmentGallery
        canMutate={canMutate}
        onRecreate={(preset) => {
          setBuilderSeed(presetRecreateText(preset));
          setBuilderAst(undefined);
          setBuilderName(undefined);
          setCreateOpen(true);
        }}
      />
      <RFMSection />

      {/* ----- AI suggestions (SUB-065 cohort discovery) ----- */}
      <AISuggestionsSection
        canMutate={canMutate}
        onUse={(s) => {
          setBuilderSeed(s.description || undefined);
          setBuilderAst(s.predicate_json);
          setBuilderName(s.name);
          setCreateOpen(true);
        }}
      />

      {/* ----- predictive templates (SUB-034) ----- */}
      <SegmentTemplateGallery
        canMutate={canMutate}
        onCreated={(s) => {
          setRows((prev) => (prev ? [s, ...prev] : [s]));
          setOpenSegment(s);
        }}
      />

      <NaturalLanguageBuilder
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={onCreated}
        initialText={builderSeed}
        initialAst={builderAst}
        initialName={builderName}
      />

      {/* SUB-033 — lookalike-audience generation. Seeds off the loaded
          segment list (filtered to >= 50 members inside the modal). */}
      {lookalikeOpen ? (
        <LookalikeModal
          segments={rows ?? []}
          canMutate={canMutate}
          onClose={() => setLookalikeOpen(false)}
        />
      ) : null}

      {openSegment ? (
        <SegmentDetailSlideover
          segment={openSegment}
          onClose={() => setOpenSegment(null)}
          onRecomputed={onRecomputed}
          onDelete={(s) => setDeleteTarget(s)}
        />
      ) : null}

      {compareOpen ? (
        <SegmentPerformanceComparison
          segments={rows ?? []}
          onClose={() => setCompareOpen(false)}
        />
      ) : null}

      <ConfirmModal
        open={deleteTarget != null}
        title="Delete segment"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.name ?? "this segment"}"? Campaigns and flows targeting this segment will need to be re-pointed. Subscriber records are not affected.`
            : ""
        }
        confirmLabel="Delete segment"
        danger
        typeToConfirm={deleteTarget?.name?.trim() || undefined}
        busy={deleting}
        onClose={() => (deleting ? undefined : setDeleteTarget(null))}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

interface SegmentsResultsProps {
  rows: Segment[] | null;
  loading: boolean;
  error: string | null;
  query: string;
  filter: Filter;
  page: number;
  pageRows: Segment[];
  totalPages: number;
  filteredCount: number;
  canMutate: boolean;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: Filter) => void;
  onPageChange: (page: number | ((current: number) => number)) => void;
  onOpen: (segment: Segment) => void;
  onCreate: () => void;
}

function SegmentsResults({
  rows,
  loading,
  error,
  query,
  filter,
  page,
  pageRows,
  totalPages,
  filteredCount,
  canMutate,
  onQueryChange,
  onFilterChange,
  onPageChange,
  onOpen,
  onCreate,
}: SegmentsResultsProps): ReactElement {
  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 12,
          flexWrap: "wrap",
        }}
      >
        <input
          className="input"
          style={{ width: 280 }}
          placeholder="Search segments…"
          aria-label="Search segments"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
        />
        <div className="chips">
          {FILTER_CHIPS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`chip${filter === item.value ? " is-active" : ""}`}
              onClick={() => onFilterChange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="notice">
          <span>Couldn&apos;t load segments: {error}</span>
        </div>
      ) : null}

      {loading ? (
        <div style={{ padding: 12 }}>
          {[0, 1, 2, 3, 4].map((item) => (
            <div key={item} className="skel-row" />
          ))}
        </div>
      ) : pageRows.length === 0 ? (
        query || filter !== "all" || (rows && rows.length > 0) ? (
          <div className="list-empty">
            <div className="empty-state">
              <div className="empty-state-icon" aria-hidden="true">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </div>
              <h3>
                {query ? `No matches for "${query}"` : "No segments match"}
              </h3>
              <p>
                {query
                  ? "Clear the search to see all segments."
                  : "Try a different filter."}
              </p>
              {query ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => onQueryChange("")}
                >
                  Clear search
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <HeroEmptyState
            tone="mint"
            eyebrow="Segments"
            title="Describe an audience. We'll find it."
            subtitle="Save dynamic groups of subscribers that update as events flow in — engagement, purchases, custom traits. Target them from campaigns and flows."
            primaryCta={
              canMutate
                ? { label: "New segment", onClick: onCreate }
                : undefined
            }
            imageSrc={HERO.lists}
            imageAlt="Three index-card stacks labelled by audience"
          />
        )
      ) : (
        <SegmentsList rows={pageRows} onOpen={onOpen} />
      )}

      <DataTablePagination
        label="Segments"
        page={page}
        pageCount={totalPages}
        hasPrevious={page > 1}
        hasNext={page < totalPages}
        onPrevious={() => onPageChange((current) => Math.max(1, current - 1))}
        onNext={() =>
          onPageChange((current) => Math.min(totalPages, current + 1))
        }
        itemSummary={
          rows
            ? `${pageRows.length.toLocaleString()} of ${filteredCount.toLocaleString()} matching segments`
            : undefined
        }
      />
    </>
  );
}
