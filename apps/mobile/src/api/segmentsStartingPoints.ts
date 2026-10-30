/**
 * api/segmentsStartingPoints.ts — transport for the three starting-point
 * catalogues (parsers + merge policy in lib/segmentStartingPoints.ts).
 *
 * The three GETs are fetched together and merged BEST-EFFORT: one failed
 * source is reported by name (lib mergeStartingPoints.failedSources) instead
 * of collapsing the whole section — but when EVERY source fails the fetch
 * throws, because "no starting points exist" and "nothing could be loaded"
 * are different sentences.
 */
import { rawRequest } from "@/api/request";
import {
  mergeStartingPoints,
  parseAiStartingPoints,
  parsePresetStartingPoints,
  parseTemplateStartingPoints,
  type StartingPointsCatalogue,
} from "@/lib/segmentStartingPoints";

async function tryRead<T>(
  path: string,
  parse: (raw: unknown) => T,
): Promise<T | null> {
  const res = await rawRequest<unknown>("GET", path);
  if (res.error) return null;
  return parse(res.data);
}

export async function fetchSegmentStartingPoints(): Promise<StartingPointsCatalogue> {
  const [presets, templates, ai] = await Promise.all([
    tryRead("/api/v1/preset-segments", parsePresetStartingPoints),
    tryRead("/api/v1/segments/templates", parseTemplateStartingPoints),
    tryRead("/api/v1/segments/ai-suggestions", parseAiStartingPoints),
  ]);
  if (presets === null && templates === null && ai === null) {
    throw new Error("Couldn't load segment starting points.");
  }
  return mergeStartingPoints({ presets, templates, ai });
}
