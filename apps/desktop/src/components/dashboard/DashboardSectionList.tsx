/**
 * DashboardSectionList — renders the Dashboard's main card sections in
 * the user's saved order, plus the "Edit layout" chrome.
 *
 * Normal mode: sections render bare, in resolved order (see
 * dashboard-sections.ts for the resolution contract and the list of
 * participating sections).
 *
 * Edit mode: every section — including ones whose component currently
 * renders nothing (e.g. AnomalyHistoryCard on a healthy workspace) —
 * gets a labelled frame with Move up / Move down buttons, so users can
 * position cards that only appear conditionally. Buttons instead of
 * drag: keyboard-accessible, no new dependencies, and the stat grid
 * above already owns the drag interaction for its tiles.
 *
 * Persistence bubbles up: onReorder receives the NEW section-key order;
 * the page merges it with the stat-card order and PUTs the combined
 * layout.
 */

import {
  Fragment,
  type ReactElement,
  type ReactNode,
  useId,
  useState,
} from "react";

import { moveKey, resolveSectionOrder } from "./dashboard-sections";
import { Icon } from "../Icon";

export interface DashboardSection {
  key: string;
  label: string;
  node: ReactNode;
}

interface Props {
  sections: readonly DashboardSection[];
  /** Full saved layout order (mixed stat + section keys is fine). */
  order: readonly string[] | null;
  editing: boolean;
  onReorder: (nextSectionKeys: string[]) => void;
}

export function DashboardSectionList({
  sections,
  order,
  editing,
  onReorder,
}: Props): ReactElement {
  const [announcement, setAnnouncement] = useState("");
  const instructionsId = useId();
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const resolved = resolveSectionOrder(order).filter((k) => byKey.has(k));

  if (!editing) {
    return (
      <>
        {resolved.map((k) => (
          <Fragment key={k}>{byKey.get(k)!.node}</Fragment>
        ))}
      </>
    );
  }

  return (
    <div className="dash-layout-editor">
      <p id={instructionsId} className="visually-hidden">
        Use Move up and Move down to reorder sections. Focus stays on the
        selected section control.
      </p>
      <div className="dash-layout-editor-intro" role="status">
        <div>
          <strong>Layout editing is on</strong>
          <span>Move sections into the order that supports your workflow.</span>
        </div>
        <span className="dash-layout-editor-count tabular">
          {resolved.length} sections
        </span>
      </div>
      <div
        role="list"
        aria-label="Dashboard sections — reorder"
        aria-describedby={instructionsId}
      >
        {resolved.map((k, i) => {
          const s = byKey.get(k)!;
          return (
            <div key={k} role="listitem" className="dash-layout-section">
              <div className="dash-layout-section-header">
                <span className="dash-layout-section-index tabular">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="dash-layout-section-label">{s.label}</span>
                <span className="spacer" />
                <div className="dash-layout-section-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={i === 0}
                    aria-label={`Move ${s.label} up`}
                    onClick={() => {
                      const next = moveKey(resolved, k, -1);
                      if (next) {
                        onReorder(next);
                        setAnnouncement(
                          `Moved ${s.label} to position ${i} of ${next.length}.`,
                        );
                      }
                    }}
                  >
                    <Icon name="chevron-up" size={12} /> Up
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={i === resolved.length - 1}
                    aria-label={`Move ${s.label} down`}
                    onClick={() => {
                      const next = moveKey(resolved, k, 1);
                      if (next) {
                        onReorder(next);
                        setAnnouncement(
                          `Moved ${s.label} to position ${i + 2} of ${next.length}.`,
                        );
                      }
                    }}
                  >
                    <Icon name="chevron-down" size={12} /> Down
                  </button>
                </div>
              </div>
              <div className="dash-layout-section-preview">
                {s.node ?? null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </div>
  );
}
