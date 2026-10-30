import type { ReactElement } from "react";

import { ChoiceGroup } from "../../components/ChoiceGroup";
import { Icon } from "../../components/Icon";
import type { AuditViewMode } from "./audit-page-types";

const DENSITY_HOLD_REASON =
  "Unavailable in this release: the server has not verified complete-window density data, so a loaded-row summary could imply that missing activity is zero activity.";

const VIEW_MODES: ReadonlyArray<{
  value: AuditViewMode;
  label: string;
  description?: string;
  unavailable?: boolean;
}> = [
  { value: "list", label: "Event list" },
  {
    value: "timeline",
    label: "Timeline",
    description: DENSITY_HOLD_REASON,
    unavailable: true,
  },
  {
    value: "heatmap",
    label: "Heatmap",
    description: DENSITY_HOLD_REASON,
    unavailable: true,
  },
  {
    value: "calendar",
    label: "Calendar",
    description: DENSITY_HOLD_REASON,
    unavailable: true,
  },
];

export function AuditViewModeToolbar({
  viewMode,
  onChange,
}: {
  viewMode: AuditViewMode;
  onChange: (mode: AuditViewMode) => void;
}): ReactElement {
  return (
    <section
      className="audit-view-toolbar"
      aria-labelledby="audit-view-toolbar-title"
    >
      <div className="audit-view-toolbar-copy">
        <span className="audit-section-kicker">Evidence surface</span>
        <h2 id="audit-view-toolbar-title">Explore events</h2>
        <p>
          The event list is the authoritative loaded-window view in this
          checkpoint. Density views stay visible with their release reason.
        </p>
      </div>
      <ChoiceGroup
        legend="Audit evidence views"
        value={viewMode}
        onChange={onChange}
        className="audit-view-mode-group"
        optionClassName="audit-view-mode-option"
        dataTestId="audit-view-mode-toolbar"
        options={VIEW_MODES.map((mode) => ({
          value: mode.value,
          label: mode.label,
          description: mode.description,
          unavailable: mode.unavailable,
          dataTestId: `audit-view-mode-${mode.value}`,
        }))}
      />
    </section>
  );
}

export function AuditViewReleaseHold({
  viewMode,
  onUseList,
}: {
  viewMode: Exclude<AuditViewMode, "list">;
  onUseList: () => void;
}): ReactElement {
  const label = VIEW_MODES.find((mode) => mode.value === viewMode)?.label;
  return (
    <section
      className="audit-view-release-hold"
      aria-labelledby="audit-view-release-title"
      data-testid="audit-view-release-hold"
    >
      <span className="audit-view-release-icon" aria-hidden="true">
        <Icon name="lock" size={18} />
      </span>
      <div>
        <span className="audit-section-kicker">Loaded-window safeguard</span>
        <h3 id="audit-view-release-title">{label} is on release hold</h3>
        <p>{DENSITY_HOLD_REASON}</p>
      </div>
      <button type="button" className="btn" onClick={onUseList}>
        Use event list
      </button>
    </section>
  );
}
