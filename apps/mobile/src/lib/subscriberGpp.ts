/**
 * subscriberGpp — SUB-120 IAB Global Privacy Platform sections on a phone
 * profile.
 *
 * Desktop's GppSectionsPanel translated, read-only exactly like it: a CMP
 * emits per-jurisdiction GPP strings; Moosewave stores them VERBATIM (no
 * decoding) plus an audit ledger of who set what, when, from where. The
 * phone shows the stored truth; edits stay on the admin-only PATCH path out
 * of band (desktop offers no write here either).
 *
 * sourceLabel mirrors desktop verbatim — unknown provenance passes through.
 * Import-free so every rule runs in the node vitest suite.
 */

export interface GppSectionRow {
  jurisdiction: string;
  /** The raw GPP string, verbatim — never decoded, never summarized. */
  value: string;
}

export interface GppAuditRow {
  jurisdiction: string;
  source: string;
  createdAt: string;
}

export interface GppView {
  sections: GppSectionRow[];
  audit: GppAuditRow[];
}

/** Desktop's sourceLabel, verbatim. */
export function gppSourceLabel(source: string): string {
  switch (source) {
    case "cmp_webhook":
      return "CMP webhook";
    case "manual_override":
      return "Admin";
    case "import":
      return "Import";
    case "api":
      return "API";
    default:
      return source;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** The GppResponse body, defensively. Junk → empty view (honest empty state). */
export function parseGpp(payload: unknown): GppView {
  const rec =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const sections: GppSectionRow[] = [];
  if (rec.sections && typeof rec.sections === "object") {
    for (const [jurisdiction, value] of Object.entries(
      rec.sections as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value) {
        sections.push({ jurisdiction, value });
      }
    }
  }
  sections.sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction));
  const audit: GppAuditRow[] = Array.isArray(rec.audit)
    ? rec.audit.flatMap((row): GppAuditRow[] => {
        if (!row || typeof row !== "object") return [];
        const r = row as Record<string, unknown>;
        const jurisdiction = str(r.jurisdiction);
        if (!jurisdiction) return [];
        return [
          {
            jurisdiction,
            source: str(r.source),
            createdAt: str(r.created_at),
          },
        ];
      })
    : [];
  return { sections, audit };
}
