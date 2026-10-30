/**
 * Configure screen — shown when no candidate dashboard URL responds.
 *
 * Lets the operator type a URL (or pick one of the common candidates),
 * persists it to localStorage, then re-probes. This is the polite
 * alternative to letting the webview hang on DNS for 30s.
 */
import { type ReactElement, useState } from "react";

import {
  getCandidateDashboardUrls,
  setDashboardUrlOverride,
} from "../lib/dashboard-url";

interface Props {
  /** URLs we already tried (failed). Greyed out in the suggestion list. */
  triedUrls: string[];
  /** Called with the URL the user picked / typed; parent re-probes. */
  onSubmit: (url: string) => void;
}

export function ConfigureScreen({ triedUrls, onSubmit }: Props): ReactElement {
  const [value, setValue] = useState<string>("");

  const candidates = getCandidateDashboardUrls();
  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setDashboardUrlOverride(trimmed);
    onSubmit(trimmed);
  };

  const useCandidate = (url: string): void => {
    setDashboardUrlOverride(url);
    onSubmit(url);
  };

  return (
    <div className="screen configure">
      <div className="configure-card">
        <div className="configure-eyebrow">Moosewave Desktop</div>
        <h1 className="configure-title">Where is your Moosewave?</h1>
        <p className="configure-body">
          The desktop app couldn&apos;t reach any of the URLs it tried. Point it
          at a Moosewave instance you own and we&apos;ll remember your choice.
        </p>

        <form onSubmit={handleSubmit} className="configure-form">
          <label className="configure-label" htmlFor="pw-url">
            Dashboard URL
          </label>
          <input
            id="pw-url"
            className="configure-input"
            type="url"
            placeholder="https://app.your-domain.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button type="submit" className="configure-button">
            Connect
          </button>
        </form>

        {candidates.length > 0 && (
          <div className="configure-suggestions">
            <div className="configure-suggestions-title">
              Or pick one of these:
            </div>
            <ul className="configure-suggestions-list">
              {candidates.map((url) => {
                const tried = triedUrls.includes(url);
                return (
                  <li key={url}>
                    <button
                      type="button"
                      className={`configure-suggestion${tried ? " is-tried" : ""}`}
                      // eslint-disable-next-line react-hooks/rules-of-hooks -- false positive: useCandidate is a callback parameter, not a React Hook
                      onClick={() => useCandidate(url)}
                      aria-label={`${tried ? "Retry" : "Try"} API URL ${url}`}
                    >
                      <span className="configure-suggestion-url">{url}</span>
                      {tried && (
                        <span className="configure-suggestion-tag">tried</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <p className="configure-footnote">
          Your choice is stored locally only. Clear it anytime in Settings.
        </p>
      </div>
    </div>
  );
}
