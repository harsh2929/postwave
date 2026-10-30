import type { ReactElement } from "react";

import type { DmarcSuggestion } from "../../lib/api-client";

interface Props {
  suggestions: DmarcSuggestion[];
}

function severityLabel(severity: DmarcSuggestion["severity"]): string {
  if (severity === "action") return "Investigate now";
  if (severity === "warning") return "Review";
  return "Context";
}

export function DmarcSuggestionsBanner({ suggestions }: Props): ReactElement {
  return (
    <section
      className="dmarc-recommendations"
      aria-labelledby="dmarc-recommendations-title"
    >
      <header>
        <div>
          <p className="dmarc-kicker">Evidence-led triage</p>
          <h2 id="dmarc-recommendations-title">Recommended investigations</h2>
        </div>
        <span className="dmarc-evidence-pill">
          {suggestions.length.toLocaleString()} item
          {suggestions.length === 1 ? "" : "s"}
        </span>
      </header>
      {suggestions.length === 0 ? (
        <div className="dmarc-recommendations__empty">
          <strong>No investigation was generated for this snapshot.</strong>
          <span>
            Keep monitoring. An absent recommendation is not a guarantee of
            authentication health or inbox placement.
          </span>
        </div>
      ) : (
        <ol>
          {suggestions.map((suggestion) => (
            <li key={suggestion.code} data-severity={suggestion.severity}>
              <span
                className="dmarc-recommendation-marker"
                aria-hidden="true"
              />
              <div>
                <span className="dmarc-recommendation-label">
                  {severityLabel(suggestion.severity)}
                </span>
                <strong>{suggestion.action}</strong>
                {suggestion.reason ? <p>{suggestion.reason}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="dmarc-recommendations__footnote">
        Recommendations are derived from aggregate observations. Confirm source
        ownership and configuration outside this view before taking action.
      </p>
    </section>
  );
}
