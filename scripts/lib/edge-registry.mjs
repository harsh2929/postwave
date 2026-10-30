/**
 * Extract the formal edge-case register from the deep-integration blueprint.
 *
 * The release-evidence contract requires a manifest to disposition EVERY edge
 * case — and requires the registry to be "generated from the complete formal
 * edge register rather than manually retyped". That wording is load-bearing: a
 * retyped list drifts from the document silently, and the failure mode is a
 * milestone promoted while an edge nobody dispositioned was quietly absent from
 * the checklist.
 *
 * So the register lives in exactly one place — the `## 8. Universal edge-case
 * and failure register` tables — and this module reads it. Adding a row to the
 * document changes the registry digest, which invalidates every manifest that
 * pinned the old one, which is precisely the intended consequence.
 */

/** `IAM-01`, `A11Y-04`, `FORMAT-01` — a leading alnum token then a number. */
const EDGE_ID = /^\|\s*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+)\s*\|/;

const SECTION_HEADING = /^###\s+(8\.\d+)\s+(.+?)\s*$/;

/** The markdown header row (`| ID | Scenario | …`) and its `| --- |` rule. */
const HEADER_CELL = /^\|\s*ID\s*\|/i;
const RULE_ROW = /^\|[\s:|-]+\|?\s*$/;

/**
 * A table row carrying data, as opposed to a header, a separator rule, or
 * ordinary prose. Used to tell "this line is not a table row" (fine) from
 * "this line IS a row and its id is malformed" (a silent hole).
 */
function isDataRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  if (HEADER_CELL.test(trimmed) || RULE_ROW.test(trimmed)) return false;
  // Needs at least an id cell and one more cell to be a register entry.
  return trimmed.split("|").filter((c) => c.trim() !== "").length >= 2;
}

/**
 * Parse the register out of the blueprint markdown.
 *
 * @param {string} markdown full blueprint source
 * @returns {{ entries: Array<{id: string, section: string, sectionTitle: string, scenario: string}>, errors: string[] }}
 */
export function parseEdgeRegister(markdown) {
  const lines = markdown.split("\n");
  const entries = [];
  const errors = [];
  const seen = new Map();

  let inRegister = false;
  let section = "";
  let sectionTitle = "";

  for (const line of lines) {
    if (/^##\s+8\.\s/.test(line)) {
      inRegister = true;
      continue;
    }
    // Any other top-level heading ends the register.
    if (inRegister && /^##\s+(?!8\.)/.test(line)) break;
    if (!inRegister) continue;

    const heading = SECTION_HEADING.exec(line);
    if (heading) {
      section = heading[1];
      sectionTitle = heading[2];
      continue;
    }

    const match = EDGE_ID.exec(line);
    if (!match) {
      // A DATA row whose first cell is not a well-formed id is a silent hole:
      // the edge case never enters the registry, the digest does not change,
      // and no manifest ever has to disposition it — exactly the drift this
      // module exists to prevent. `iam-02`, `IAM 03`, `**IAM-04**` and
      // `IAM-05b` all used to vanish without a word.
      if (isDataRow(line)) {
        errors.push(
          `§${section || "?"}: table row does not begin with a well-formed ` +
            `edge id — ${line.trim().slice(0, 80)}`,
        );
      }
      continue;
    }
    const id = match[1];
    // Cells: | ID | Scenario | Required behavior |
    const cells = line.split("|").map((c) => c.trim());
    const scenario = cells[2] ?? "";

    if (seen.has(id)) {
      errors.push(
        `duplicate edge id ${id} (first in §${seen.get(id)}, again in §${section}) — ` +
          `ids must be unique across the whole register or a disposition is ambiguous`,
      );
      continue;
    }
    seen.set(id, section);
    entries.push({ id, section, sectionTitle, scenario });
  }

  if (!inRegister) {
    errors.push(
      "could not find the `## 8.` edge-case register heading in the blueprint",
    );
  }
  if (entries.length === 0 && errors.length === 0) {
    errors.push("edge register parsed to zero entries — table format changed?");
  }
  return { entries, errors };
}

/**
 * The registry document a manifest pins by digest. Deliberately minimal and
 * ORDER-STABLE (sorted by id) so the digest depends on the register's content,
 * not on the order rows happen to appear in the markdown.
 */
export function buildEdgeRegistry(entries, { sourceDocument }) {
  return {
    $schema: "moosewave://ecosystem-release-evidence/edge-registry/v1",
    source_document: sourceDocument,
    count: entries.length,
    entries: [...entries]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((e) => ({
        id: e.id,
        section: e.section,
        section_title: e.sectionTitle,
        scenario: e.scenario,
      })),
  };
}
