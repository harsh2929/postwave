/**
 * lib/migrationEvidence.ts — the FIELD-LEVEL half of a migration verification
 * report: which resources moved, which fields were remapped on the way, and
 * which ones had nowhere to land.
 *
 * WHY THIS IS SEPARATE FROM `migrationVerification.ts`. That module reduces the
 * same payload to COUNTS — "13 custom fields mapped" — which is the right
 * summary for a verdict and useless as evidence. The question this module
 * answers is the one the summary cannot: WHICH field, and what did it become?
 * `custom_fields_mapped` is `[{source, canonical, type}]`
 * (canonical/types.go:368-372), and the pair is the whole point: a client
 * asking "did my `Renewal Date` survive?" is asking for that arrow, not for a
 * number that includes it.
 *
 * VERBATIM MEANS VERBATIM. Every string here is carried across UNCHANGED — not
 * trimmed, not cased, not title-cased, not re-spelled. A source field named
 * `" Email "` with the spaces is exactly the kind of thing that explains a
 * broken import, and a parser that tidied it away would destroy the evidence it
 * exists to preserve. That is why this file has its own `verbatim()` rather
 * than reusing the `text()` helper next door, which trims.
 *
 * THE SERVER'S STATUS WORD IS NOT AN ENUM HERE. `ResourceCompleteness.Status`
 * is documented as one of six values (types.go:421-430), and desktop maps them
 * to its own badge vocabulary. This does not: a status a future server adds
 * must still reach the screen, so the word is passed through and only the
 * SHORTFALL — arithmetic on the server's own two numbers, shown beside them —
 * is derived.
 *
 * ABSENCE IS NOT ZERO, AND AN ABSENT LIST IS NOT AN EMPTY ONE. `omitempty` is
 * on most of these arrays, so a missing key means "this server said nothing
 * about it" rather than "there were none". The counts stay `number | null` and
 * `evidenceIsEmpty` is what decides whether there is anything to show at all.
 *
 * React-native-free by construction: it reaches only the pure node-safe
 * helpers (`lib/format` for the counts, `lib/direction` for the mapping
 * arrow), so node vitest covers all of it.
 */
import { forwardArrow } from "./direction";
import { num } from "./format";

/**
 * A string as the server sent it. No trim, no case change, no fallback — only
 * "is it a non-empty string?".
 */
function verbatim(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A count that may legitimately be absent. Never coerced to 0. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function verbatimList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(verbatim)
    .filter((line): line is string => line !== null);
}

function objectsOf(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      Boolean(row) && typeof row === "object" && !Array.isArray(row),
  );
}

/** One `resource_completeness` row, kept whole rather than reduced to a ratio. */
export interface ResourceEvidence {
  /** The server's machine name for the resource. */
  resource: string;
  /** The server's own label for it; falls back to the machine name. */
  label: string;
  sourceTotal: number | null;
  imported: number | null;
  /** `false` when the provider never exposed this resource at all. */
  supported: boolean | null;
  /** The server's status word, whatever it is. Never folded into an enum. */
  status: string | null;
  notes: string[];
}

/** One `custom_fields_mapped` row: the before and the after, side by side. */
export interface FieldMappingEvidence {
  source: string;
  canonical: string | null;
  type: string | null;
}

/** A `{name, warning}` / `{name, reason}` pair, whichever the array carries. */
export interface NamedWarningEvidence {
  name: string;
  detail: string | null;
}

/** A `ResourceWarning`: partial fidelity on one named row of one resource. */
export interface ResourceWarningEvidence {
  resource: string | null;
  name: string | null;
  sourceId: string | null;
  warning: string;
}

export interface MigrationEvidence {
  resources: ResourceEvidence[];
  fieldsMapped: FieldMappingEvidence[];
  fieldsUnmapped: string[];
  segmentWarnings: NamedWarningEvidence[];
  automationsUnsupported: NamedWarningEvidence[];
  resourceWarnings: ResourceWarningEvidence[];
}

function parseResource(row: Record<string, unknown>): ResourceEvidence | null {
  const resource = verbatim(row.resource);
  const label = verbatim(row.label);
  if (resource === null && label === null) return null;
  return {
    resource: resource ?? (label as string),
    label: label ?? (resource as string),
    sourceTotal: count(row.source_total),
    imported: count(row.imported),
    supported: typeof row.supported === "boolean" ? row.supported : null,
    status: verbatim(row.status),
    notes: verbatimList(row.notes),
  };
}

function parseMapping(row: Record<string, unknown>): FieldMappingEvidence | null {
  const source = verbatim(row.source);
  if (source === null) return null;
  return {
    source,
    // An empty `canonical` is meaningful: the field was seen and did not land.
    canonical: verbatim(row.canonical),
    type: verbatim(row.type),
  };
}

function parseNamed(
  row: Record<string, unknown>,
  detailKey: string,
): NamedWarningEvidence | null {
  const name = verbatim(row.name);
  if (name === null) return null;
  return { name, detail: verbatim(row[detailKey]) };
}

function parseResourceWarning(
  row: Record<string, unknown>,
): ResourceWarningEvidence | null {
  const warning = verbatim(row.warning);
  if (warning === null) return null;
  return {
    resource: verbatim(row.resource),
    name: verbatim(row.name),
    sourceId: verbatim(row.source_id),
    warning,
  };
}

/**
 * The three `ResourceWarning` arrays are read as ONE list. They differ only in
 * which resource they describe, and each row already carries its own
 * `resource`, so keeping them apart on a phone would be three headings for one
 * fact. Order is preserved within and across them — the server chose it.
 */
const RESOURCE_WARNING_KEYS = [
  "campaign_archive_warnings",
  "template_warnings",
  "source_archive_warnings",
] as const;

export function parseMigrationEvidence(value: unknown): MigrationEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const resourceWarnings: ResourceWarningEvidence[] = [];
  for (const key of RESOURCE_WARNING_KEYS) {
    for (const row of objectsOf(raw[key])) {
      const parsed = parseResourceWarning(row);
      if (parsed) resourceWarnings.push(parsed);
    }
  }
  return {
    resources: objectsOf(raw.resource_completeness)
      .map(parseResource)
      .filter((row): row is ResourceEvidence => row !== null),
    fieldsMapped: objectsOf(raw.custom_fields_mapped)
      .map(parseMapping)
      .filter((row): row is FieldMappingEvidence => row !== null),
    fieldsUnmapped: verbatimList(raw.custom_fields_unmapped),
    segmentWarnings: objectsOf(raw.segments_with_warnings)
      .map((row) => parseNamed(row, "warning"))
      .filter((row): row is NamedWarningEvidence => row !== null),
    automationsUnsupported: objectsOf(raw.automations_unsupported)
      .map((row) => parseNamed(row, "reason"))
      .filter((row): row is NamedWarningEvidence => row !== null),
    resourceWarnings,
  };
}

/** True when there is nothing field-level to show, so no section is opened. */
export function evidenceIsEmpty(evidence: MigrationEvidence | null): boolean {
  if (!evidence) return true;
  return (
    evidence.resources.length === 0 &&
    evidence.fieldsMapped.length === 0 &&
    evidence.fieldsUnmapped.length === 0 &&
    evidence.segmentWarnings.length === 0 &&
    evidence.automationsUnsupported.length === 0 &&
    evidence.resourceWarnings.length === 0
  );
}

/**
 * How many rows the source had that did not arrive.
 *
 * Only ever the server's own subtraction, and only when BOTH numbers are real:
 * a missing `source_total` is not a denominator of zero, and an import that
 * exceeded the source total (a re-run, a merge) is not a negative shortfall —
 * both answer null rather than a number nobody can defend.
 */
export function resourceShortfall(row: ResourceEvidence): number | null {
  if (row.sourceTotal === null || row.imported === null) return null;
  const gap = row.sourceTotal - row.imported;
  return gap > 0 ? gap : null;
}

/**
 * The counts line for one resource, in the server's own numbers.
 *
 * `supported === false` wins over the counts: a provider that never exposed a
 * resource did not import zero of it, and "0 of 0" would read as a clean pass.
 */
export function resourceCountsLine(row: ResourceEvidence): string {
  if (row.supported === false) {
    return "The provider did not expose this resource.";
  }
  if (row.sourceTotal === null && row.imported === null) {
    return "No counts reported.";
  }
  // `num` renders the em-dash for an absent count itself, which is the same
  // "reported nothing" mark this line has always used.
  const imported = num(row.imported);
  const total = num(row.sourceTotal);
  const gap = resourceShortfall(row);
  return gap === null
    ? `${imported} of ${total}`
    : `${imported} of ${total} · ${num(gap)} short`;
}

/**
 * One mapping row as a sentence: the source name, an arrow, what it became.
 *
 * A mapping whose `canonical` is empty is NOT rendered as an arrow to nothing
 * that could be misread as a name — it says so in words.
 */
export function fieldMappingLine(row: FieldMappingEvidence): string {
  const target =
    row.canonical === null
      ? "reported with no destination field"
      : `${forwardArrow()} ${row.canonical}`;
  return row.type === null ? `${row.source} ${target}` : `${row.source} ${target} (${row.type})`;
}

/**
 * What the evidence is, and what it is NOT, given the job's state.
 *
 * Desktop puts a "Provisional evidence" / "Final server report" badge on this
 * section for a reason: a report read while the import is still running names
 * what has landed SO FAR, and quoting it to a client as a final reconciliation
 * is how a migration gets signed off early. The second sentence is the one the
 * desktop also refuses to leave out — an absent resource is not a verified
 * empty one.
 */
export function evidenceScopeCopy(status: string | undefined): {
  badge: string;
  sentence: string;
} {
  const s = (status ?? "").toLowerCase();
  const settled = s === "completed" || s === "committed" || s === "rolled_back";
  return {
    badge: settled ? "Final server report" : "Provisional evidence",
    sentence: settled
      ? "These are the server's own before-and-after values for this job. They do not attest to resources the provider never exposed."
      : "This job has not finished, so these values describe what has landed so far — not a final reconciliation.",
  };
}
