/**
 * Static, fail-closed boundary for privacy-incident controls that do not yet
 * have end-to-end legal, identity, or evidence guarantees.
 *
 * Keep this component presentational. A release-hold surface must never mount
 * a transport, mutation, dialog, or action callback.
 */

import { type ReactElement, type ReactNode, useId } from "react";

import "../../styles-privacy-incidents.css";

import { Icon } from "../Icon";

interface PrivacyIncidentReleaseHoldProps {
  title: string;
  description: string;
  checkpoints: readonly string[];
  children?: ReactNode;
  testId: string;
}

export function PrivacyIncidentReleaseHold({
  title,
  description,
  checkpoints,
  children,
  testId,
}: PrivacyIncidentReleaseHoldProps): ReactElement {
  const titleId = useId();
  return (
    <aside
      className="privacy-incident-release-hold"
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <span className="privacy-incident-release-hold-icon" aria-hidden="true">
        <Icon name="lock" size={18} />
      </span>
      <div className="privacy-incident-release-hold-content">
        <div className="privacy-incident-release-hold-meta">
          <span className="privacy-incident-release-hold-badge">
            Release hold
          </span>
          <span>No action is available</span>
        </div>
        <h4 id={titleId}>{title}</h4>
        <p>{description}</p>
        {children}
        <ul aria-label="Requirements before release">
          {checkpoints.map((checkpoint) => (
            <li key={checkpoint}>{checkpoint}</li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
