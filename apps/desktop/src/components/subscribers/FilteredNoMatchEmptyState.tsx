/**
 * FilteredNoMatchEmptyState (SUB-085)
 *
 * Replaces the bare "No matches for …" empty state in the Subscribers
 * list with a recovery-oriented panel. When a search returns zero rows we
 * help the operator get unstuck instead of dead-ending them:
 *
 *   1. Recent searches — a bounded identity-scoped process-memory ring via
 *      `recent-searches.ts`, click to re-run.
 *   2. Try different operators — the supported `key:value` search syntax
 *      with concrete examples, click to seed the search box.
 *   3. Did you mean — a single best-guess operator query derived from the
 *      current bare term (e.g. typing "acme" suggests `email:acme`), shown
 *      only when the raw query has no operator/`@` already.
 *
 * Pure presentational: the parent owns the query state and passes
 * `onApplyQuery` (set the search box + re-run) and `onClear`. No backend,
 * no API calls.
 */

import { type ReactElement } from "react";

import { getRecentSubscriberSearches } from "./recent-searches";

interface Props {
  /** Opaque signed-in user + workspace scope. */
  recentSearchScope: string | null;
  /** The current (non-empty) search query that produced zero matches. */
  query: string;
  /** Set the search box to `q` and re-run the search. */
  onApplyQuery: (q: string) => void;
  /** Clear the search entirely (back to the full list). */
  onClear: () => void;
}

interface OperatorExample {
  /** The example query string, e.g. "tag:vip". */
  example: string;
  /** A short human description of what the operator matches. */
  hint: string;
}

const OPERATOR_EXAMPLES: readonly OperatorExample[] = [
  { example: "tag:vip", hint: "subscribers carrying a tag" },
  { example: "@acme.com", hint: "everyone at a domain" },
  { example: "email:jane", hint: "email contains a substring" },
  { example: "name:smith", hint: "name contains a substring" },
  { example: "status:unsubscribed", hint: "filter by status" },
  { example: "source:import", hint: "filter by acquisition source" },
];

/** True when the query already uses an operator or domain syntax. */
function hasOperator(q: string): boolean {
  return /[:@]/.test(q);
}

/**
 * Build a single "did you mean" suggestion for a bare term. If the term
 * looks like an email local-part/domain we lean toward `email:`; an
 * all-letters word leans toward `name:`. Returns null when the query
 * already carries an operator (nothing to upgrade).
 */
function didYouMean(query: string): string | null {
  const q = query.trim();
  if (!q || hasOperator(q)) return null;
  // A single word of letters reads more like a name than an address.
  const looksLikeName = /^[a-z]+$/i.test(q) && q.length >= 3;
  return looksLikeName ? `name:${q}` : `email:${q}`;
}

export function FilteredNoMatchEmptyState({
  recentSearchScope,
  query,
  onApplyQuery,
  onClear,
}: Props): ReactElement {
  const recent = getRecentSubscriberSearches(recentSearchScope).filter(
    (q) => q.toLowerCase() !== query.trim().toLowerCase(),
  );
  const suggestion = didYouMean(query);

  return (
    <div className="list-empty">
      <div className="empty-state sub-nomatch">
        <div className="empty-state-icon" aria-hidden="true">
          ·
        </div>
        <h3>No matches for &ldquo;{query}&rdquo;</h3>
        <p>Try a different query, or use a search operator to narrow in.</p>

        {suggestion ? (
          <div className="sub-nomatch-didyoumean">
            Did you mean{" "}
            <button
              type="button"
              className="btn btn-xs btn-ghost sub-nomatch-chip"
              onClick={() => onApplyQuery(suggestion)}
            >
              {suggestion}
            </button>
            ?
          </div>
        ) : null}

        {recent.length > 0 ? (
          <div className="sub-nomatch-section">
            <div className="sub-nomatch-label">Recent searches</div>
            <div className="sub-nomatch-chips">
              {recent.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="btn btn-xs btn-ghost sub-nomatch-chip"
                  onClick={() => onApplyQuery(q)}
                  aria-label={`Search again for ${q}`}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="sub-nomatch-section">
          <div className="sub-nomatch-label">Try different operators</div>
          <div className="sub-nomatch-ops">
            {OPERATOR_EXAMPLES.map((op) => (
              <button
                key={op.example}
                type="button"
                className="sub-nomatch-op"
                onClick={() => onApplyQuery(op.example)}
              >
                <code className="sub-nomatch-op-code">{op.example}</code>
                <span className="sub-nomatch-op-hint">{op.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={onClear}
        >
          Clear search
        </button>
      </div>
    </div>
  );
}
