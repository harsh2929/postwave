/**
 * LibraryToolbar — top row of the Library page.
 *
 *   [search]           sort▾   [grid|list]   [S|M|L]   [Upload]
 *
 * Search input is uncontrolled from the user's POV (you type and it
 * fires onSearchChange every keystroke); the page-level debounce
 * decides when to refetch. Disabling Upload for viewers is the
 * page's job — we accept `canUpload` as a prop and tooltip when off.
 */

import { type ReactElement, useEffect, useId, useRef, useState } from "react";

import { type AssetSort } from "../../lib/api-client";

import { type Density } from "./LibraryGrid";

export type ViewMode = "grid" | "list";

interface Props {
  query: string;
  sort: AssetSort;
  viewMode: ViewMode;
  density: Density;
  canUpload: boolean;
  onSearchChange: (q: string) => void;
  onSortChange: (s: AssetSort) => void;
  onViewModeChange: (v: ViewMode) => void;
  onDensityChange: (d: Density) => void;
  onUpload: () => void;
}

const SORT_OPTIONS: { value: AssetSort; label: string }[] = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "largest", label: "Largest" },
  { value: "name", label: "Name" },
  { value: "most-used", label: "Most used" },
];

export function LibraryToolbar({
  query,
  sort,
  viewMode,
  density,
  canUpload,
  onSearchChange,
  onSortChange,
  onViewModeChange,
  onDensityChange,
  onUpload,
}: Props): ReactElement {
  const uploadReasonId = useId();
  const composingSearchRef = useRef(false);
  const compositionCommitRef = useRef<string | null>(null);
  const [searchDraft, setSearchDraft] = useState(query);
  useEffect(() => {
    if (!composingSearchRef.current) setSearchDraft(query);
  }, [query]);
  return (
    <div className="lib-toolbar">
      <input
        type="search"
        className="input lib-search"
        placeholder="Search images by filename…"
        value={searchDraft}
        onCompositionStart={() => {
          composingSearchRef.current = true;
          compositionCommitRef.current = null;
        }}
        onCompositionEnd={(event) => {
          const value = event.currentTarget.value;
          composingSearchRef.current = false;
          compositionCommitRef.current = value;
          setSearchDraft(value);
          onSearchChange(value);
          queueMicrotask(() => {
            if (compositionCommitRef.current === value) {
              compositionCommitRef.current = null;
            }
          });
        }}
        onChange={(event) => {
          const value = event.target.value;
          setSearchDraft(value);
          if (composingSearchRef.current) return;
          if (compositionCommitRef.current === value) {
            compositionCommitRef.current = null;
            return;
          }
          compositionCommitRef.current = null;
          onSearchChange(value);
        }}
        aria-label="Search assets"
      />

      <span className="lib-spacer" />

      <select
        className="input"
        value={sort}
        onChange={(e) => onSortChange(e.target.value as AssetSort)}
        aria-label="Sort"
        style={{ width: "auto" }}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <div className="lib-segmented" role="group" aria-label="View mode">
        <button
          type="button"
          className={viewMode === "grid" ? "is-active" : ""}
          onClick={() => onViewModeChange("grid")}
          aria-pressed={viewMode === "grid"}
        >
          Grid
        </button>
        <button
          type="button"
          className={viewMode === "list" ? "is-active" : ""}
          onClick={() => onViewModeChange("list")}
          aria-pressed={viewMode === "list"}
        >
          List
        </button>
      </div>

      {viewMode === "grid" ? (
        /* P2 fix (audit 2026-06-02): the S/M/L segmented control was hard
         * to scan (teal-on-teal active state, density rarely changed). Folded
         * into a select — keeps the same three options but reclaims ~80px
         * of toolbar real-estate for the upload + sort controls. */
        <select
          className="input lib-density-select"
          value={density}
          onChange={(e) => onDensityChange(e.target.value as Density)}
          aria-label="Tile size"
          style={{
            width: "auto",
            height: 28,
            padding: "0 24px 0 8px",
            fontSize: 12,
          }}
        >
          <option value="compact">Compact</option>
          <option value="cozy">Default</option>
          <option value="comfortable">Comfortable</option>
        </select>
      ) : null}

      <span className="lib-toolbar-action">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            if (canUpload) onUpload();
          }}
          aria-disabled={!canUpload || undefined}
          aria-describedby={!canUpload ? uploadReasonId : undefined}
        >
          Upload
        </button>
        {!canUpload ? (
          <span id={uploadReasonId} className="lib-toolbar-action-reason">
            Viewer access can browse assets but cannot upload them.
          </span>
        ) : null}
      </span>
    </div>
  );
}
