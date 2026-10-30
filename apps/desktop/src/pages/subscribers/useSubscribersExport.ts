import { useRef, useState } from "react";

import { uiStatusToEngine } from "../../components/subscribers/subscriber-status";
import { toast } from "../../components/Toast";
import { api } from "../../lib/api-client";
import { saveFile } from "../../lib/file-transfer";
import { resolveSubscribersExportSort } from "./subscribers-page-utils";
import type { SubscribersData } from "./useSubscribersData";
import type { SubscribersPageState } from "./useSubscribersPageState";

export type SubscribersExportOutcome =
  | "saved"
  | "started"
  | "partial"
  | "cancelled"
  | "blocked"
  | "busy"
  | "failed";

export interface SubscribersExportManifest {
  generatedAt: string;
  query?: string;
  status?: string;
  includeArchived: boolean;
  sort: string;
  order: "asc" | "desc";
  expectedRows: number | null;
  cap: 10_000;
  scope: "applied_view";
  classification: "personal";
  source: "server_complete";
}

export function buildSubscribersExportManifest(
  state: Pick<
    SubscribersPageState,
    "debouncedQuery" | "filter" | "showArchived" | "sortColumn" | "sortOrder"
  >,
  expectedRows: number | null,
  generatedAt = new Date(),
): SubscribersExportManifest | null {
  const sort = resolveSubscribersExportSort(state.sortColumn);
  if (!sort) return null;
  const status =
    state.filter === "all" ? undefined : uiStatusToEngine(state.filter);
  if (state.filter !== "all" && !status) return null;
  const query = state.debouncedQuery.trim();
  return {
    generatedAt: generatedAt.toISOString(),
    ...(query ? { query } : {}),
    ...(status ? { status } : {}),
    includeArchived: state.showArchived,
    sort,
    order: state.sortOrder,
    expectedRows,
    cap: 10_000,
    scope: "applied_view",
    classification: "personal",
    source: "server_complete",
  };
}

function visibleManifestValue(value: string): string {
  const bounded = value.slice(0, 120);
  const escaped = bounded.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu,
    (character) => {
      const point = character.codePointAt(0) ?? 0;
      return `\\u${point.toString(16).toUpperCase().padStart(4, "0")}`;
    },
  );
  return value.length > bounded.length ? `${escaped}…` : escaped;
}

export function subscribersExportManifestDetail(
  manifest: SubscribersExportManifest,
): string {
  const query = manifest.query
    ? `“${visibleManifestValue(manifest.query)}”`
    : "none";
  const status = manifest.status ?? "all";
  const archiveScope = manifest.includeArchived
    ? "active + archived"
    : "active only";
  const total =
    manifest.expectedRows == null
      ? "total pending server receipt"
      : `${manifest.expectedRows.toLocaleString()} matching`;
  return `Applied query ${query} · status ${status} · ${archiveScope} · ${manifest.sort} ${manifest.order} · ${total} · cap ${manifest.cap.toLocaleString()} · personal data · server-complete path · generated ${manifest.generatedAt}`;
}

function savedRowsLabel(rows: number | null): string {
  if (rows == null) return "matching rows";
  return `${rows.toLocaleString()} row${rows === 1 ? "" : "s"}`;
}

export function useSubscribersExport(
  state: SubscribersPageState,
  data: SubscribersData,
) {
  const [exporting, setExporting] = useState(false);
  const inFlightRef = useRef(false);

  const exportVisible = async (): Promise<SubscribersExportOutcome> => {
    if (inFlightRef.current) return "busy";
    if (
      state.query.trim() !== state.debouncedQuery.trim() ||
      data.loading ||
      data.lastLoadedQueryRef.current !== state.debouncedQuery
    ) {
      toast.info("Wait for the applied subscriber view to finish updating.");
      return "blocked";
    }

    const manifest = buildSubscribersExportManifest(state, data.matchTotal);
    if (!manifest) {
      toast.info(
        "This page-only sort can't produce a complete ordered export. Choose a server-backed column and try again.",
      );
      return "blocked";
    }

    inFlightRef.current = true;
    setExporting(true);
    toast.info({
      message: "Preparing the frozen subscriber export",
      detail: subscribersExportManifestDetail(manifest),
      duration: 8_000,
    });
    const fallbackName = `postwave-subscribers-${manifest.generatedAt.slice(0, 10)}.csv`;
    try {
      const response = await api.exportSubscribersCSV({
        ...(manifest.status ? { status: manifest.status } : {}),
        ...(manifest.query ? { q: manifest.query } : {}),
        includeArchived: manifest.includeArchived,
        sort: manifest.sort,
        order: manifest.order,
      });
      if (response.error) {
        toast.error(
          "Couldn't prepare the complete applied subscriber export. No page-only fallback was saved.",
        );
        return "failed";
      }

      const { blob, filename, truncated, exportedRows } = response.data;
      if (
        exportedRows == null ||
        exportedRows > manifest.cap ||
        (truncated && exportedRows !== manifest.cap)
      ) {
        toast.error(
          "The server didn't return a consistent export row receipt. No unverifiable file was saved.",
        );
        return "failed";
      }
      const saved = await saveFile({
        data: blob,
        suggestedName: filename || fallbackName,
        label: "Subscribers export",
        privacy: "personal",
        mimeType: "text/csv;charset=utf-8",
      });
      if (
        (!saved.ok && saved.code === "cancelled") ||
        (saved.ok && saved.status === "cancelled")
      ) {
        return "cancelled";
      }
      if (!saved.ok) {
        toast.error(saved.message);
        return "failed";
      }

      const archiveScope = manifest.includeArchived
        ? "including archived records"
        : "active records only";
      if (truncated) {
        toast.info(
          `Partial export ${saved.status === "download_started" ? "download started" : "saved"}: ${savedRowsLabel(exportedRows)} from the applied view (${archiveScope}). Refine the view to export the remainder.`,
        );
        return "partial";
      }
      if (saved.status === "download_started") {
        toast.info(
          `Download started for ${savedRowsLabel(exportedRows)} from the complete applied view (${archiveScope}). Check your browser's downloads for completion.`,
        );
        return "started";
      }
      toast.success(
        `Saved ${savedRowsLabel(exportedRows)} from the complete applied view (${archiveScope}).`,
      );
      return "saved";
    } catch {
      toast.error(
        "Couldn't complete the subscriber export. No success was recorded; retry when the connection is stable.",
      );
      return "failed";
    } finally {
      inFlightRef.current = false;
      setExporting(false);
    }
  };

  return { exporting, exportVisible };
}

export type SubscribersExport = ReturnType<typeof useSubscribersExport>;
