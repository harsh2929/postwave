/**
 * segmentStartingPoints — pure parsing for the three "don't start from a
 * blank box" catalogues the desktop segments page ships as galleries
 * (PresetSegmentGallery / SegmentTemplateGallery / AISuggestionsSection):
 *
 *   GET /api/v1/preset-segments        → {items:[{key,label,description,count}]}
 *       (internal/preset_segments — live counts per preset)
 *   GET /api/v1/segments/templates     → {items:[{key,label,description,
 *       icon_hint,category,suggested_name,...}]} (templates.go)
 *   GET /api/v1/segments/ai-suggestions → {items:[{key,name,description,
 *       predicate_json,estimated_size,rationale,category}], generated, notice}
 *       (ai_suggester.go — a DETERMINISTIC heuristic the server itself
 *       labels; its `notice` is the disclosure and must ride along)
 *
 * All three are viewer reads. The fourth gallery on desktop — RFM predictive
 * segments — already reaches mobile via useAnalytics (GET
 * /api/v1/predictive/rfm/segments, DASHBOARD#31), so it is deliberately NOT
 * re-fetched here.
 *
 * Mobile folds the three into ONE "starting points" vocabulary: each entry
 * carries a `seedText` that feeds DescribeAudienceSheet's compile→preview→
 * save path, so a tapped starting point still shows its rule and live size
 * before anything is saved — the same honesty gates as a typed description.
 */

export type StartingPointSource = "preset" | "template" | "ai";

export interface SegmentStartingPoint {
  key: string;
  source: StartingPointSource;
  name: string;
  description: string;
  /** Live/estimated audience size when the source provided one. */
  size: number | null;
  /** Why the server surfaced it (AI suggestions only). */
  rationale: string;
  /** Seeds the describe sheet's text box. */
  seedText: string;
  /** Seeds the segment-name field. */
  seedName: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function items(res: unknown): Record<string, unknown>[] {
  const rows = (res as { items?: unknown[] } | null | undefined)?.items;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === "object",
  );
}

export function parsePresetStartingPoints(res: unknown): SegmentStartingPoint[] {
  return items(res)
    .filter((r) => str(r.key))
    .map((r) => ({
      key: `preset:${str(r.key)}`,
      source: "preset" as const,
      name: str(r.label) || str(r.key),
      description: str(r.description),
      size:
        typeof r.count === "number" && Number.isFinite(r.count) ? r.count : null,
      rationale: "",
      seedText: str(r.description) || str(r.label),
      seedName: str(r.label) || str(r.key),
    }));
}

export function parseTemplateStartingPoints(
  res: unknown,
): SegmentStartingPoint[] {
  return items(res)
    .filter((r) => str(r.key))
    .map((r) => ({
      key: `template:${str(r.key)}`,
      source: "template" as const,
      name: str(r.label) || str(r.key),
      description: str(r.description),
      size: null,
      rationale: "",
      seedText: str(r.description) || str(r.label),
      seedName: str(r.suggested_name) || str(r.label),
    }));
}

export interface AiStartingPoints {
  items: SegmentStartingPoint[];
  /** The server's own processing disclosure — rendered verbatim. */
  notice: string;
}

export function parseAiStartingPoints(res: unknown): AiStartingPoints {
  const points = items(res)
    .filter((r) => str(r.key))
    .map((r) => ({
      key: `ai:${str(r.key)}`,
      source: "ai" as const,
      name: str(r.name) || str(r.key),
      description: str(r.description),
      size:
        typeof r.estimated_size === "number" && Number.isFinite(r.estimated_size)
          ? r.estimated_size
          : null,
      rationale: str(r.rationale),
      seedText: str(r.description) || str(r.name),
      seedName: str(r.name),
    }));
  return {
    items: points,
    notice: str((res as Record<string, unknown> | null | undefined)?.notice),
  };
}

export interface StartingPointsCatalogue {
  items: SegmentStartingPoint[];
  aiNotice: string;
  /** Sources whose fetch failed — named, so a partial catalogue says so. */
  failedSources: StartingPointSource[];
}

/**
 * Merge the three sources, AI first (they are ranked against this tenant's
 * actual data), then presets (live counts), then templates. Failed sources
 * are carried by NAME rather than collapsing the whole catalogue: two live
 * galleries plus the sentence "AI suggestions didn't load" beats an empty
 * section pretending nothing exists.
 */
export function mergeStartingPoints(parts: {
  presets: SegmentStartingPoint[] | null;
  templates: SegmentStartingPoint[] | null;
  ai: AiStartingPoints | null;
}): StartingPointsCatalogue {
  const failedSources: StartingPointSource[] = [];
  if (parts.ai === null) failedSources.push("ai");
  if (parts.presets === null) failedSources.push("preset");
  if (parts.templates === null) failedSources.push("template");
  return {
    items: [
      ...(parts.ai?.items ?? []),
      ...(parts.presets ?? []),
      ...(parts.templates ?? []),
    ],
    aiNotice: parts.ai?.notice ?? "",
    failedSources,
  };
}
