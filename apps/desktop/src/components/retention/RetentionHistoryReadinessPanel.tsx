import type { ReactElement } from "react";

import type { RetentionWinbackSettings } from "../../lib/retention-offers-contract";
import type { RetentionReadinessFact } from "../../lib/retention-offers-view-model";
import {
  RETENTION_WINBACK_RELEASE_HOLD_CODE,
  RETENTION_WINBACK_RELEASE_VERDICT,
} from "../../lib/retention-winback-release-status";
import { Icon } from "../Icon";

function ReadinessState({
  state,
}: {
  state: RetentionReadinessFact["state"];
}): ReactElement {
  const label = {
    observed: "Observed",
    attention: "Needs review",
    unknown: "Not verified",
    blocked: "Release-gated",
    "not-applicable": "Not applicable",
  }[state];
  return (
    <span className={`rhs-readiness-state is-${state}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

export function RetentionHistoryReadinessPanel({
  facts,
  winback,
  winbackUnavailable,
  onRetryWinback,
}: {
  facts: readonly RetentionReadinessFact[];
  winback: RetentionWinbackSettings | null;
  winbackUnavailable: boolean;
  onRetryWinback: () => void;
}): ReactElement {
  return (
    <div className="rhs-panel-stack">
      <section
        className="rhs-readiness-grid"
        aria-labelledby="rhs-readiness-title"
      >
        <div className="rhs-section-heading">
          <div>
            <span>Release truth</span>
            <h2 id="rhs-readiness-title">
              Stored facts do not become runtime promises.
            </h2>
          </div>
          <p>
            Response observations and source-level release boundaries remain
            visibly distinct.
          </p>
        </div>
        <div className="rhs-readiness-facts">
          {facts.map((fact, index) => (
            <article key={fact.id}>
              <span className="rhs-readiness-index">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <span>
                  {fact.basis === "response" ? "Response" : "Release contract"}
                </span>
                <h3>{fact.label}</h3>
                <p>{fact.detail}</p>
              </div>
              <ReadinessState state={fact.state} />
            </article>
          ))}
        </div>
      </section>

      <section className="rhs-winback" aria-labelledby="rhs-winback-title">
        <div className="rhs-winback-copy">
          <span className="rhs-winback-icon" aria-hidden="true">
            <Icon name="git-branch" size={19} />
          </span>
          <div>
            <span>Stored configuration</span>
            <h2 id="rhs-winback-title">Win-back setting observation</h2>
            <p>
              This card reads configuration only. It does not prove a worker is
              running, a person is eligible, consent is satisfied, or a message
              can be delivered. Automated delivery is{" "}
              {RETENTION_WINBACK_RELEASE_VERDICT} (
              {RETENTION_WINBACK_RELEASE_HOLD_CODE}).
            </p>
          </div>
        </div>
        {winback ? (
          <dl>
            <div>
              <dt>Stored switch</dt>
              <dd>{winback.enabled ? "Enabled" : "Disabled"}</dd>
            </div>
            <div>
              <dt>Stored threshold</dt>
              <dd>{(winback.churnThreshold * 100).toFixed(0)}%</dd>
            </div>
            <div>
              <dt>Profiles scored</dt>
              <dd>{winback.churnProfilesScored.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Runtime delivery</dt>
              <dd>Unavailable (rollout-held)</dd>
            </div>
          </dl>
        ) : (
          <div
            className="rhs-winback-unknown"
            role={winbackUnavailable ? "alert" : "status"}
          >
            <div>
              <strong>
                {winbackUnavailable
                  ? "Stored settings could not be verified."
                  : "Reading stored settings…"}
              </strong>
              <p>
                No default state is inferred while this resource is unknown.
              </p>
            </div>
            {winbackUnavailable ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onRetryWinback}
              >
                Retry settings
              </button>
            ) : null}
          </div>
        )}
      </section>

      <section
        className="rhs-release-map"
        aria-labelledby="rhs-release-map-title"
      >
        <div className="rhs-section-heading">
          <div>
            <span>Capability map</span>
            <h2 id="rhs-release-map-title">
              What this release actually mounts
            </h2>
          </div>
        </div>
        <div className="rhs-release-map-grid">
          <article className="is-available">
            <Icon name="eye" size={18} />
            <span>Available here</span>
            <h3>Three admin retention endpoints</h3>
            <p>
              Offers, funnel counters, and stored win-back settings. Tier names
              come from a separate shared read.
            </p>
          </article>
          <article className="is-blocked">
            <Icon name="lock" size={18} />
            <span>Unavailable</span>
            <h3>Offer authoring</h3>
            <p>
              No create, edit, activate, pause, or delete control is mounted.
            </p>
          </article>
          <article className="is-blocked">
            <Icon name="lock" size={18} />
            <span>Unavailable</span>
            <h3>Portal acceptance</h3>
            <p>
              No subscriber cancel-flow or provider application is certified.
            </p>
          </article>
          <article className="is-blocked">
            <Icon name="lock" size={18} />
            <span>Unavailable</span>
            <h3>Automated win-backs</h3>
            <p>
              A stored switch is not proof of worker startup or safe delivery.
            </p>
          </article>
        </div>
      </section>
    </div>
  );
}
