/**
 * api/segmentsAdvanced.ts — transport for the segment-detail evidence panels
 * (snapshots / definition history / usage / growth report). Parsers live in
 * lib/segmentAdvancedRows.ts.
 *
 * POST /segments/{id}/snapshot is the one WRITE: editor floor
 * (write:subscribers), ONLINE-ONLY and press-driven — a snapshot is evidence
 * of "the segment as of NOW", so a queued snapshot replayed later would be
 * evidence of a moment nobody chose. Reads are viewer.
 */
import { rawRequest } from "@/api/request";
import {
  parseDefinitionHistory,
  parseSegmentGrowthReport,
  parseSegmentSnapshot,
  parseSegmentSnapshots,
  parseSegmentUsage,
  type DefinitionHistoryRow,
  type SegmentGrowthReport,
  type SegmentSnapshotRow,
  type SegmentUsageRow,
} from "@/lib/segmentAdvancedRows";

async function read<T>(
  path: string,
  parse: (raw: unknown) => T,
  label: string,
): Promise<T> {
  const res = await rawRequest<unknown>("GET", path);
  if (res.error) {
    throw Object.assign(new Error(res.error.message || label), res.error);
  }
  return parse(res.data);
}

const base = (id: string): string => `/api/v1/segments/${encodeURIComponent(id)}`;

export async function fetchSegmentSnapshots(
  id: string,
): Promise<SegmentSnapshotRow[]> {
  return read(
    `${base(id)}/snapshots`,
    parseSegmentSnapshots,
    "Couldn't load the snapshots.",
  );
}

export async function createSegmentSnapshot(
  id: string,
): Promise<SegmentSnapshotRow | null> {
  const res = await rawRequest<unknown>("POST", `${base(id)}/snapshot`);
  if (res.error) {
    throw Object.assign(
      new Error(res.error.message || "Couldn't take a snapshot."),
      res.error,
    );
  }
  return parseSegmentSnapshot(res.data);
}

export async function fetchSegmentDefinitionHistory(
  id: string,
): Promise<DefinitionHistoryRow[]> {
  return read(
    `${base(id)}/definition-history`,
    parseDefinitionHistory,
    "Couldn't load the definition history.",
  );
}

export async function fetchSegmentUsage(id: string): Promise<SegmentUsageRow[]> {
  return read(
    `${base(id)}/usage`,
    parseSegmentUsage,
    "Couldn't load where this segment is used.",
  );
}

export async function fetchSegmentGrowthReport(
  id: string,
  days = 30,
): Promise<SegmentGrowthReport> {
  return read(
    `${base(id)}/growth/report?days=${days}`,
    parseSegmentGrowthReport,
    "Couldn't load the growth report.",
  );
}
