/**
 * AuditFilters — extracted filter row + action category presets.
 * Refined Audit PR 1.
 *
 * Reuses the existing native form controls (select / input / chips)
 * so the page footprint stays small. Adds:
 *   - Resource type select (the backend already supports this filter
 *     and never had a UI surface — common asks like "all subscriber
 *     events" now take one click).
 *   - Resource ID input (free-text ILIKE — answers "what happened to
 *     <this id>?").
 *   - Action shortcut chips: each maps to one explicit server-side action
 *     substring. The description states that exact predicate.
 */

import { useId, type ReactElement } from "react";

/** Canonical values written by the audit middleware. `human` is deliberately
 * not called `user`: the persisted actor_type column and every server-side
 * filter use `human`, so a friendlier wire alias would silently return an
 * empty result set. */
export type ActorType =
  | "any"
  | "human"
  | "agent"
  | "system"
  | "platform_operator";
export type DayRange = 7 | 30 | 90 | 0; // 0 = all
export type ActionCategory =
  | "all"
  | "destructive"
  | "auth"
  | "export"
  | "one_click"
  // rbac-meta-audit: surfaces audit.read.* meta-rows so an auditor
  // can answer "who has been reading the audit log lately?".
  | "meta_audit";

/** ueba-baselines (AI/Anomaly, P1): optional anomaly-type chip
 *  filter. "any" disables the filter (default); the four detector
 *  types narrow the audit list to rows with that dominant anomaly
 *  type. Filtering is best-effort client-side — the page combines
 *  the chip with the recent-anomalies metadata to mark matching
 *  rows. */
export type AnomalyType =
  | "any"
  | "impossible_travel"
  | "off_hours"
  | "peer_group"
  | "escalation_chain";

const RESOURCE_TYPES = [
  "",
  "subscriber",
  "campaign",
  "list",
  "tag",
  "automation",
  "webhook",
  "api_key",
  "user",
  "tenant",
  "sender",
  "domain",
  "suppression",
  "sms_subscription",
  "audit_sink",
] as const;

interface Props {
  actorType: ActorType;
  actorLabel: string;
  actionQuery: string;
  resourceType: string;
  resourceId: string;
  days: DayRange;
  category: ActionCategory;
  onActorTypeChange: (v: ActorType) => void;
  onActorLabelChange: (v: string) => void;
  onActionQueryChange: (v: string) => void;
  onResourceTypeChange: (v: string) => void;
  onResourceIdChange: (v: string) => void;
  onDaysChange: (v: DayRange) => void;
  onCategoryChange: (v: ActionCategory) => void;
  /** ueba-baselines (AI/Anomaly, P1): optional anomaly-type chip
   *  filter. Both props optional so non-Audit callers don't have to
   *  wire UEBA filtering when they reuse AuditFilters. */
  anomalyType?: AnomalyType;
  onAnomalyTypeChange?: (v: AnomalyType) => void;
}

const ANOMALY_CHIPS: Array<{
  id: AnomalyType;
  label: string;
  description: string;
}> = [
  {
    id: "impossible_travel",
    label: "Impossible travel",
    description: "geo-distance and time-delta violations",
  },
  {
    id: "off_hours",
    label: "Off-hours",
    description: "activity outside the actor's working-hours window",
  },
  {
    id: "peer_group",
    label: "Peer-group",
    description: "activity outside the actor's cluster norm",
  },
  {
    id: "escalation_chain",
    label: "Escalation chain",
    description: "role-assume, grant, then access chains",
  },
];

const DAY_CHIPS: Array<[DayRange, string]> = [
  [7, "7d"],
  [30, "30d"],
  [90, "90d"],
  [0, "All"],
];

const CATEGORY_CHIPS: Array<{
  id: ActionCategory;
  label: string;
  description: string;
}> = [
  { id: "all", label: "All", description: "No action substring filter" },
  {
    id: "destructive",
    label: "Destructive",
    description: "Action contains “delete”",
  },
  {
    id: "auth",
    label: "Auth",
    description: "Action contains “login”",
  },
  {
    id: "export",
    label: "Export",
    description: "Action contains “export”",
  },
  {
    // One-click unsubscribe (RFC 8058) revocations recorded by the
    // preferences package — the consent ledger writes 'revoked' with
    // source='one_click' and the suppression repo emits a matching
    // audit row tagged 'unsubscribe_via_oneclick' / 'one_click'.
    id: "one_click",
    label: "One-click",
    description: "Action contains “one_click”",
  },
  {
    // rbac-meta-audit: meta-audit rows written by AuditMetaMiddleware.
    // The chip ILIKE-matches "audit.read" so list / export / stream
    // / stats / saved-views / retention reads all surface together.
    id: "meta_audit",
    label: "Audit reads",
    description: "Action contains “audit.read”",
  },
];

export function AuditFilters({
  actorType,
  actorLabel,
  actionQuery,
  resourceType,
  resourceId,
  days,
  category,
  onActorTypeChange,
  onActorLabelChange,
  onActionQueryChange,
  onResourceTypeChange,
  onResourceIdChange,
  onDaysChange,
  onCategoryChange,
  anomalyType = "any",
  onAnomalyTypeChange,
}: Props): ReactElement {
  const actorTypeId = useId();
  const actorLabelId = useId();
  const actionQueryId = useId();
  const resourceTypeId = useId();
  const resourceIdId = useId();
  const resourceHelpId = useId();
  const aiHelpId = useId();
  const categoryHelpId = useId();
  const anomalyHelpId = useId();
  const selectedCategory =
    CATEGORY_CHIPS.find((choice) => choice.id === category) ??
    CATEGORY_CHIPS[0];
  const selectedAnomaly = ANOMALY_CHIPS.find(
    (choice) => choice.id === anomalyType,
  );

  return (
    <div className="audit-filters">
      <div className="audit-filters-row">
        <label className="audit-filter-field" htmlFor={actorTypeId}>
          <span className="label">Actor type</span>
          <select
            id={actorTypeId}
            className="input"
            value={actorType}
            onChange={(event) =>
              onActorTypeChange(event.target.value as ActorType)
            }
          >
            <option value="any">Any actor</option>
            <option value="human">Human</option>
            <option value="agent">Agent</option>
            <option value="system">System</option>
            <option value="platform_operator">Platform operator</option>
          </select>
        </label>
        <label className="audit-filter-field" htmlFor={actorLabelId}>
          <span className="label">Actor label</span>
          <input
            id={actorLabelId}
            className="input"
            placeholder="Name or identifier"
            maxLength={256}
            value={actorLabel}
            onChange={(event) => onActorLabelChange(event.target.value)}
          />
        </label>
        <label className="audit-filter-field" htmlFor={actionQueryId}>
          <span className="label">Action contains</span>
          <input
            id={actionQueryId}
            className="input"
            placeholder="For example, campaign.updated"
            maxLength={256}
            value={actionQuery}
            onChange={(event) => onActionQueryChange(event.target.value)}
          />
        </label>
        <label className="audit-filter-field" htmlFor={resourceTypeId}>
          <span className="label">Resource type</span>
          <select
            id={resourceTypeId}
            className="input"
            value={resourceType}
            onChange={(event) => onResourceTypeChange(event.target.value)}
            aria-describedby={resourceHelpId}
          >
            {RESOURCE_TYPES.map((resource) => (
              <option key={resource || "any"} value={resource}>
                {resource || "Any resource type"}
              </option>
            ))}
          </select>
        </label>
        <label className="audit-filter-field" htmlFor={resourceIdId}>
          <span className="label">Resource ID contains</span>
          <input
            id={resourceIdId}
            className="input"
            placeholder="Full or partial identifier"
            maxLength={256}
            value={resourceId}
            onChange={(event) => onResourceIdChange(event.target.value)}
            aria-describedby={resourceHelpId}
          />
        </label>
      </div>
      <p id={resourceHelpId} className="audit-filter-help">
        Resource type identifies what the event touched. Combine it with a
        resource ID to scope the trail to one record.
      </p>
      <div className="audit-filters-row">
        {/* aivs-bundles (Compliance, P2): one-click "AI Activity" chip
            that pivots the actor filter to agent. Surfaces every
            agent-actor event (claude-code / postwave-ai / etc.) so an
            EU AI Act Article 50 reviewer can scope to AI-only activity
            without remembering the dropdown. */}
        <fieldset className="audit-filter-choice-group">
          <legend>Actor shortcut</legend>
          <button
            type="button"
            className={`chip${actorType === "agent" ? " is-active" : ""}`}
            aria-pressed={actorType === "agent"}
            aria-describedby={aiHelpId}
            onClick={() =>
              onActorTypeChange(actorType === "agent" ? "any" : "agent")
            }
            data-testid="audit-filters-ai-activity-chip"
          >
            AI activity
            {actorType === "agent" ? (
              <span
                className="muted"
                style={{ marginLeft: 6, fontSize: 11 }}
                aria-hidden="true"
              >
                ×
              </span>
            ) : null}
          </button>
          <p id={aiHelpId} className="audit-filter-help">
            Selects Agent activity for focused review in this evidence window.
          </p>
        </fieldset>
        <fieldset className="audit-filter-choice-group">
          <legend>Date range</legend>
          <div className="chips">
            {DAY_CHIPS.map(([dayRange, label]) => (
              <button
                key={label}
                type="button"
                className={`chip${days === dayRange ? " is-active" : ""}`}
                aria-pressed={days === dayRange}
                onClick={() => onDaysChange(dayRange)}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="audit-filter-choice-group">
          <legend>Action category</legend>
          <div className="chips" style={{ alignItems: "center" }}>
            {CATEGORY_CHIPS.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className={`chip${category === choice.id ? " is-active" : ""}`}
                aria-pressed={category === choice.id}
                aria-describedby={categoryHelpId}
                onClick={() => onCategoryChange(choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <p id={categoryHelpId} className="audit-filter-help">
            <strong>{selectedCategory?.label}:</strong>{" "}
            {selectedCategory?.description}.
          </p>
        </fieldset>
        {onAnomalyTypeChange ? (
          <fieldset
            className="audit-filter-choice-group"
            data-testid="audit-filters-anomaly-chips"
          >
            <legend>UEBA anomaly type</legend>
            <div className="chips" style={{ alignItems: "center" }}>
              {ANOMALY_CHIPS.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className={`chip${anomalyType === choice.id ? " is-active" : ""}`}
                  aria-pressed={anomalyType === choice.id}
                  aria-describedby={anomalyHelpId}
                  onClick={() =>
                    onAnomalyTypeChange(
                      anomalyType === choice.id ? "any" : choice.id,
                    )
                  }
                >
                  {choice.label}
                  {anomalyType === choice.id ? (
                    <span
                      className="muted"
                      style={{ marginLeft: 6, fontSize: 11 }}
                      aria-hidden="true"
                    >
                      ×
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <p id={anomalyHelpId} className="audit-filter-help">
              {selectedAnomaly ? (
                <>
                  <strong>{selectedAnomaly.label}:</strong>{" "}
                  {selectedAnomaly.description}. Select it again to clear.
                </>
              ) : (
                "No anomaly filter. Choose a UEBA detector to show only events it scored."
              )}
            </p>
          </fieldset>
        ) : null}
      </div>
    </div>
  );
}
