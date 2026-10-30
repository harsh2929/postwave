/**
 * api/segmentsCompare.ts — transport for the two comparison reads. Parsers
 * live in lib/segmentCompareRows.ts. Envelope-unwrapping per the house rule:
 * `rawRequest` resolves to `{data, error}` and a failed read THROWS.
 */
import { rawRequest } from "@/api/request";
import {
  parseSegmentOverlap,
  parseSegmentPnlCompare,
  type SegmentOverlap,
  type SegmentPnlRow,
} from "@/lib/segmentCompareRows";

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

export async function fetchSegmentOverlap(
  a: string,
  b: string,
): Promise<SegmentOverlap> {
  const qs = new URLSearchParams();
  qs.set("a", a);
  qs.set("b", b);
  return read(
    `/api/v1/segments/overlap?${qs.toString()}`,
    parseSegmentOverlap,
    "Couldn't compute the overlap.",
  );
}

export async function fetchSegmentPnlCompare(
  ids: readonly string[],
  days = 30,
): Promise<SegmentPnlRow[]> {
  const qs = new URLSearchParams();
  qs.set("ids", ids.join(","));
  qs.set("days", String(days));
  return read(
    `/api/v1/segments/pnl/compare?${qs.toString()}`,
    parseSegmentPnlCompare,
    "Couldn't load the revenue comparison.",
  );
}
