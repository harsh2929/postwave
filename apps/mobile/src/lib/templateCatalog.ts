/**
 * lib/templateCatalog.ts — the wire shapes of the campaign-template library,
 * parsed without a single react-native import so the whole thing is testable in
 * the node vitest environment (the pattern documented in lib/reviewQueue.ts).
 *
 * Every shape below was read off the Go source, not off openapi.json:
 * `apps/api/internal/campaigntemplates/catalog.go` (the catalogue read),
 * `campaigntemplates.go` (the `Template` struct + the goal CHECK), and
 * `extras.go` (the `/goals` rollup). Five of those facts shape this module and
 * every one of them is easy to get wrong from the docs alone:
 *
 *  1. THE CATALOGUE BLANKS THE BODY. `Repo.Search` selects
 *     `'' AS body_html, '' AS body_mjml` (catalog.go:182). So a list row can
 *     never say whether a design actually HAS an email in it; only
 *     `GET /campaign-templates/{id}` can. `bodyState` makes "not loaded"
 *     ("unknown") a different answer from "loaded, and empty", instead of
 *     letting a blank string masquerade as a missing design.
 *  2. `/goals` CAN RETURN A BLANK GOAL. `Repo.GoalCounts` groups on
 *     `COALESCE(goal, '')` and does NOT filter the empty bucket out
 *     (extras.go:146) — unlike the search facets, which do (`WHERE value <> ''`,
 *     catalog.go:298). Templates with no goal therefore arrive as
 *     `{"goal":"","count":N}`. There is no query that filters FOR them (an empty
 *     `goal=` means "no filter"), so offering it as a chip would be a filter
 *     that silently does nothing.
 *  3. AN UNKNOWN GOAL IS A 400, NOT A BROADER SEARCH. `canonicalGoal`
 *     (campaigntemplates.go:590) rejects anything outside the seven CHECK
 *     values, and `Deps.Search` maps that to a validation error. So the filter
 *     rail may only ever be built from `TEMPLATE_GOALS` — echoing back a value
 *     the server invented would turn the whole screen into an error state.
 *  4. ABSENT MEANS ZERO HERE — BUT ONLY BECAUSE THE COLUMNS ARE NOT NULL.
 *     `usage_count`, `is_featured` and `quality_score` all carry `omitempty`,
 *     so Go drops them at the zero value, and all three are
 *     `NOT NULL DEFAULT …` columns (migrations 0187:38-41 and 1748:25, the
 *     latter with `CHECK (quality_score >= 0 AND quality_score <= 1)`,
 *     1748:36-37). A row therefore cannot be "unscored": an absent
 *     `quality_score` is unambiguously 0.000 and is reported as such.
 *     `last_used_at` is the opposite — a nullable timestamptz — so its absence
 *     means "never used" and is reported as null for the UI to render as words,
 *     not as a date.
 *
 *     `total` on the CATALOGUE PAGE is the one place the rule cuts the other
 *     way: `SearchResponse.Total` has NO `omitempty` (catalog.go:69), so a
 *     response that carries no `total` at all is a drifted envelope, not a
 *     library of zero designs — it parses to null so the header can stay silent
 *     instead of announcing "0 designs" over a list that has rows in it.
 *  5. `tenant_id` IS OMITTED FOR PLATFORM TEMPLATES. That absence is the only
 *     signal distinguishing the shared Moosewave gallery from the workspace's
 *     own designs, so it is parsed into an explicit `isPlatform` flag.
 */

/**
 * The goal taxonomy, mirroring `validGoal` (campaigntemplates.go:581) and the
 * migration-0187 CHECK constraint. Ordered as a person reads a lifecycle, not
 * by popularity: the server sorts `/goals` by count, which reshuffles the
 * filter rail under the user's thumb every time the catalogue changes.
 */
export const TEMPLATE_GOALS = [
  "welcome",
  "newsletter",
  "announcement",
  "promotional",
  "re_engagement",
  "transactional",
  "automation",
] as const;

export type TemplateGoal = (typeof TEMPLATE_GOALS)[number];

/** "All" is a UI concept — it maps to sending no `goal` param at all. */
export type TemplateGoalFilter = TemplateGoal | "all";

const GOAL_LABELS: Record<TemplateGoal, string> = {
  welcome: "Welcome",
  newsletter: "Newsletter",
  announcement: "Announcement",
  promotional: "Promotional",
  re_engagement: "Win-back",
  transactional: "Transactional",
  automation: "Automation",
};

export function isTemplateGoal(value: unknown): value is TemplateGoal {
  return (
    typeof value === "string" &&
    (TEMPLATE_GOALS as readonly string[]).includes(value)
  );
}

/** Human label for a goal. Unknown goals are shown verbatim, never dropped. */
export function templateGoalLabel(goal: string): string {
  const key = goal.trim().toLowerCase();
  return isTemplateGoal(key) ? GOAL_LABELS[key] : goal.trim() || "No goal";
}

/** Which endpoint a parsed record came from. See `parseTemplate`. */
export type TemplateSource = "catalog" | "detail";

export interface MobileTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  subject: string;
  previewText: string;
  goal: string;
  tags: readonly string[];
  /** `variables[].name` — the placeholders a draft will be built with. */
  variableNames: readonly string[];
  /** `tenant_id` omitted ⇒ a platform-shared gallery template. */
  isPlatform: boolean;
  isFeatured: boolean;
  isFavorited: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  /** "" | "editable" | "reference"; "" is treated as editable server-side. */
  templateKind: string;
  reviewStatus: string;
  licenseStatus: string;
  sourceProvider: string;
  sourceBrand: string;
  industry: string;
  style: string;
  /**
   * 0–1. Absent on the wire means 0.000 (the column is NOT NULL), so this is
   * only null when the payload carried something that is not a number in
   * range — in which case the UI shows an em-dash rather than a made-up score.
   */
  qualityScore: number | null;
  updatedAt: string | null;
  /**
   * Strong entity tag (`Template.ETag`, campaigntemplates.go:97), sent
   * verbatim as `If-Match` by archive/restore; "" ⇒ the verbs stay unoffered.
   */
  etag: string;
  /** Non-null ⇒ archived (recoverable via PATCH /{id}/restore). */
  archivedAt: string | null;
  /** Always "" on a catalogue row; only the single read populates these. */
  bodyHTML: string;
  bodyMJML: string;
  /**
   * Whether this record came from the SINGLE read (which returns the real
   * body) or from the catalogue list (which does not).
   *
   * It cannot be inferred from the payload. The list query selects
   * `'' AS body_html, '' AS body_mjml` literally — see
   * apps/api/internal/campaigntemplates/catalog.go:182 — so a catalogue row and
   * a design that genuinely has no body are byte-identical on the wire. Only
   * the call site knows which it fetched.
   *
   * Without this the sheet must either tell the user "a draft made from this
   * arrives blank" about a design it has never read, or stay silent about one
   * it has. Absence of a measurement is not a measurement of zero.
   */
  bodyLoaded: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** ISO timestamp or null. Go's zero time serialises as "0001-01-01T…". */
function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw || raw.startsWith("0001-01-01")) return null;
  return Number.isNaN(Date.parse(raw)) ? null : raw;
}

function count(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * A count that is allowed to be genuinely absent. `count()` above collapses
 * "missing" into 0, which is right for the NOT NULL template columns and wrong
 * for the catalogue's `total`: 0 there is a claim about the workspace's whole
 * library, and it must only ever be made because the server made it.
 */
function optionalCount(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(str).filter((entry) => entry !== "");
}

function variableNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    const name = str(record(entry)["name"]);
    if (name) seen.add(name);
  }
  return [...seen];
}

/**
 * Parse one template record.
 *
 * `source` says which endpoint produced it, because the wire cannot: pass
 * "detail" only from the single-template read (GET /{id}), which is the only
 * response whose body fields mean anything. The default is "catalog" so a new
 * call site is honest by omission rather than by accident.
 */
export function parseTemplate(
  value: unknown,
  source: TemplateSource = "catalog",
): MobileTemplate | null {
  const row = record(value);
  const id = str(row["id"]);
  if (!id) return null;
  const rawQuality = row["quality_score"];
  // omitempty drops 0.000; the column is NOT NULL, so absent === 0.
  const quality =
    rawQuality === undefined
      ? 0
      : typeof rawQuality === "number"
        ? rawQuality
        : Number.NaN;
  return {
    id,
    slug: str(row["slug"]),
    name: str(row["name"]) || "Untitled template",
    description: str(row["description"]),
    category: str(row["category"]),
    subject: str(row["subject"]),
    previewText: str(row["preview_text"]),
    goal: str(row["goal"]).toLowerCase(),
    tags: stringList(row["tags"]),
    variableNames: variableNames(row["variables"]),
    isPlatform: str(row["tenant_id"]) === "",
    isFeatured: row["is_featured"] === true,
    isFavorited: row["is_favorited"] === true,
    usageCount: count(row["usage_count"]),
    lastUsedAt: timestamp(row["last_used_at"]),
    templateKind: str(row["template_kind"]).toLowerCase(),
    reviewStatus: str(row["review_status"]).toLowerCase(),
    licenseStatus: str(row["source_license_status"]).toLowerCase(),
    sourceProvider: str(row["source_provider"]),
    sourceBrand: str(row["source_brand"]),
    industry: str(row["industry"]),
    style: str(row["style"]),
    qualityScore:
      Number.isFinite(quality) && quality >= 0 && quality <= 1 ? quality : null,
    updatedAt: timestamp(row["updated_at"]),
    // Outer whitespace only: the server TrimSpaces If-Match the same way.
    etag: typeof row["etag"] === "string" ? row["etag"].trim() : "",
    archivedAt: timestamp(row["archived_at"]),
    bodyHTML: typeof row["body_html"] === "string" ? row["body_html"] : "",
    bodyMJML: typeof row["body_mjml"] === "string" ? row["body_mjml"] : "",
    bodyLoaded: source === "detail",
  };
}

export interface TemplateCatalogPage {
  items: MobileTemplate[];
  page: number;
  perPage: number;
  /**
   * How many designs match across the WHOLE library, not just this page.
   * `null` when the response carried no `total` — see note 4: the field has no
   * `omitempty`, so its absence is envelope drift and never a library of zero.
   */
  total: number | null;
  /** The server's `next_cursor` is a stringified page number, or absent. */
  nextPage: number | null;
}

/**
 * `SearchResponse` (catalog.go:65). A bare array is accepted too so an envelope
 * change cannot silently empty the catalogue — the exact failure class the
 * mobile logic audit names as dominant (SDK/envelope drift → blank screens).
 */
export function parseTemplateCatalogPage(payload: unknown): TemplateCatalogPage {
  const body = record(payload);
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(body["items"])
      ? (body["items"] as unknown[])
      : [];
  const items = rawItems
    // Explicit arity: `.map(parseTemplate)` would pass the array INDEX as
    // `source`, silently marking row 0 a catalogue row and every other row
    // something else entirely.
    .map((row) => parseTemplate(row, "catalog"))
    .filter((item): item is MobileTemplate => item !== null);
  const page = count(body["page"]) || 1;
  const perPage = count(body["per_page"]) || items.length;
  // `record()` of an array is `{}`, so a bare-array response lands here as an
  // absent `total` — unknown, not "the server said zero".
  const total = optionalCount(body["total"]);
  const cursor = count(body["next_cursor"]);
  // `next_cursor` is an OPAQUE base64 envelope at HEAD (catalog_cursor.go),
  // not the page number this parser was written against — so a numeric parse
  // of it can no longer drive paging. The page-mode client still pages by
  // `page`, so derive the next page from the server's own `total`: a full
  // page with more rows reported beyond it means page+1 exists. A bare-array
  // response (no total, no page) still claims nothing.
  const derivedNext =
    total !== null && perPage > 0 && page * perPage < total ? page + 1 : null;
  return {
    items,
    page,
    perPage,
    total,
    nextPage: cursor > page ? cursor : derivedNext,
  };
}

export interface TemplateGoalCount {
  goal: TemplateGoal;
  count: number;
}

/**
 * `GET /campaign-templates/goals` answers a BARE ARRAY of `{goal, count}`
 * (extras.go:265 → `writeJSON(w, 200, out)` on a `[]GoalCount`).
 *
 * Two rows are dropped rather than shown: the blank-goal bucket (note 2) and
 * anything outside the CHECK taxonomy (note 3). Both would render a chip that
 * either does nothing or 400s the list.
 */
export function parseGoalCounts(payload: unknown): TemplateGoalCount[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(record(payload)["items"])
      ? (record(payload)["items"] as unknown[])
      : [];
  const out: TemplateGoalCount[] = [];
  for (const entry of source) {
    const row = record(entry);
    const goal = str(row["goal"]).toLowerCase();
    if (!isTemplateGoal(goal)) continue;
    out.push({ goal, count: count(row["count"]) });
  }
  return out;
}

export interface TemplateGoalOption {
  value: TemplateGoalFilter;
  label: string;
  badge: number | undefined;
  /**
   * What a screen reader hears. The badge renders as a bare numeral beside the
   * label, and a chip's accessibilityLabel replaces its children — so without
   * this the count is a number only sighted users receive, and "7" alone would
   * be meaningless anyway.
   */
  accessibilityLabel: string;
}

/**
 * The filter rail. "All" always leads and carries the total across the goals
 * the server reported. Goals with a zero count are omitted — a chip that can
 * only ever return "nothing matches" is a dead end, not a filter.
 *
 * Order is `TEMPLATE_GOALS`, not the server's count-descending order, so the
 * rail does not rearrange itself under the user's thumb between refreshes.
 */
export function templateGoalOptions(
  counts: readonly TemplateGoalCount[],
): TemplateGoalOption[] {
  const byGoal = new Map<TemplateGoal, number>();
  for (const row of counts) {
    byGoal.set(row.goal, (byGoal.get(row.goal) ?? 0) + row.count);
  }
  let total = 0;
  const options: TemplateGoalOption[] = [];
  for (const goal of TEMPLATE_GOALS) {
    const n = byGoal.get(goal) ?? 0;
    if (n <= 0) continue;
    total += n;
    options.push({
      value: goal,
      label: GOAL_LABELS[goal],
      badge: n,
      accessibilityLabel: `${GOAL_LABELS[goal]}, ${n} designs`,
    });
  }
  return [
    {
      value: "all",
      label: "All",
      badge: total > 0 ? total : undefined,
      accessibilityLabel:
        total > 0 ? `All goals, ${total} designs` : "All goals",
    },
    ...options,
  ];
}

/** Only a canonical goal may reach the server; "all" means "omit the param". */
export function goalQueryValue(filter: TemplateGoalFilter): string | null {
  return filter === "all" ? null : filter;
}

export type TemplateBodyState = "unknown" | "present" | "empty";

/**
 * Whether this design actually contains an email.
 *
 * `unknown` is the honest answer for a catalogue row: `Repo.Search` replaces
 * both body columns with `''`, so absence there is a projection artefact and
 * not a fact about the template. Only a single-template read can settle it.
 */
export function templateBodyState(
  detail: MobileTemplate | null | undefined,
): TemplateBodyState {
  if (!detail) return "unknown";
  // A catalogue row carries no body fields at all, so nothing is known about
  // its body yet — reporting "empty" there would claim a draft made from it
  // arrives blank, about a design we have not read.
  if (!detail.bodyLoaded) return "unknown";
  return detail.bodyHTML.trim() || detail.bodyMJML.trim() ? "present" : "empty";
}

/** One line under the row title: what the recipient would see in their inbox. */
export function templatePreviewLine(template: MobileTemplate, max = 120): string {
  const source = template.subject || template.description || template.previewText;
  const flat = source.replace(/\s+/gu, " ").trim();
  if (!flat) return "No subject line yet";
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Where this design came from, in one phrase. Provenance matters here because
 * the same list mixes the shared Moosewave gallery, designs imported from other
 * brands, and the workspace's own work — and only the last of those is
 * unambiguously the tenant's to send.
 */
export function templateOrigin(template: MobileTemplate): string {
  if (template.sourceBrand) return `Captured from ${template.sourceBrand}`;
  if (template.isPlatform) return "Moosewave gallery";
  const provider = template.sourceProvider.toLowerCase();
  if (provider && provider !== "postwave") return `Imported from ${provider}`;
  return "Built in this workspace";
}
