/**
 * bulk-blocked — pure parsing of the bulk-delete `blocked` wire lines.
 * Lives in a .ts module (not BulkActionsMenu.tsx) so the
 * node-environment vitest suite can import it without a JSX transform.
 */

/** One force-releasable `blocked` line, parsed. */
export interface ForceableBlockedRow {
  /** Raw wire line — displayed verbatim in the report modal. */
  line: string;
  /**
   * The row identifier before the first ": " — the X1 row uuid (or an
   * email, should the server ever address rows that way). This is what
   * the force pass re-sends, so "Force remove N blocked" targets
   * exactly the N rows the server reported, never the whole original
   * selection.
   */
  identifier: string;
}

/**
 * Split the server's `blocked` lines into force-releasable rows vs
 * permanently blocked ones. The wire format is
 * "<row-id>: <reason> requires force=true" / "<row-id>: <reason> is
 * permanent" (apps/api/internal/suppressions/bulk.go bulkDeleteCore).
 * Unknown formats — including a force=true line whose identifier can't
 * be parsed — are treated as NOT forceable: the safe default is to
 * never offer a force-release we can't honor (or can't target).
 */
export function splitBlocked(blocked: readonly string[]): {
  forceable: ForceableBlockedRow[];
  permanent: string[];
} {
  const forceable: ForceableBlockedRow[] = [];
  const permanent: string[] = [];
  for (const line of blocked) {
    const identifier = line.endsWith("requires force=true")
      ? parseBlockedIdentifier(line)
      : null;
    if (identifier) forceable.push({ line, identifier });
    else permanent.push(line);
  }
  return { forceable, permanent };
}

/**
 * Extract the row identifier from one `blocked` line
 * ("<identifier>: <detail>"). Returns null when the line doesn't carry
 * a parseable identifier.
 */
export function parseBlockedIdentifier(line: string): string | null {
  const sep = line.indexOf(": ");
  if (sep <= 0) return null;
  const identifier = line.slice(0, sep).trim();
  return identifier.length > 0 ? identifier : null;
}

/**
 * Build the bulk-delete selector for the force pass from the parsed
 * forceable rows. Identifiers containing "@" are emails; everything
 * else is treated as a row id — the bulk endpoints accept both keys
 * and resolve them to the same X1 rows.
 */
export function forceSelector(rows: readonly ForceableBlockedRow[]): {
  ids?: string[];
  emails?: string[];
} {
  const ids: string[] = [];
  const emails: string[] = [];
  for (const row of rows) {
    if (row.identifier.includes("@")) emails.push(row.identifier);
    else ids.push(row.identifier);
  }
  return {
    ...(ids.length > 0 ? { ids } : {}),
    ...(emails.length > 0 ? { emails } : {}),
  };
}
