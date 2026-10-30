/**
 * Shared Settings-surface primitives.
 *
 * Historically this file also shipped a two-level `SettingsNav` sidebar
 * (and a sibling `SettingsRail.tsx` anchor rail) that were never mounted
 * by any page — both were removed as dead code in the 2026-06 audit
 * cleanup (§8). What remains is the one export with real importers:
 * `SettingsSectionHeader`, used by sections.tsx and
 * ArchiveDomainSection.tsx.
 */

import type { ReactElement, ReactNode } from "react";

/**
 * Section header rendered at the top of every settings section. Keeps
 * the typography + spacing consistent across the page and gives the
 * "last updated" + "updated by" attribution slot a canonical home.
 */
export function SettingsSectionHeader({
  title,
  description,
  meta,
}: {
  title: string;
  description?: string;
  /** Right-aligned metadata slot (e.g. "Updated 2h ago by Sarah K."). */
  meta?: ReactNode;
}): ReactElement {
  return (
    <div className="settings-section-head">
      <div className="settings-section-head-text">
        <h2 className="settings-section-title">{title}</h2>
        {description ? (
          <div className="settings-section-sub">{description}</div>
        ) : null}
      </div>
      {meta ? <div className="settings-section-head-meta">{meta}</div> : null}
    </div>
  );
}
