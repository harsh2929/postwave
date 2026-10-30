/**
 * SectionHeader — in-page divider for a content section.
 *
 * Replaces ad-hoc `<h3>Title</h3>` markup with a consistent pair of
 * title + optional description + optional right-aligned actions slot.
 */

import type { ReactElement, ReactNode } from "react";

import { InlineHelp } from "./InlineHelp";

interface Props {
  title: string;
  description?: string;
  helpText?: string;
  actions?: ReactNode;
}

export function SectionHeader({
  title,
  description,
  helpText,
  actions,
}: Props): ReactElement {
  return (
    <div className="section-header-v2">
      <div className="section-header-v2-text">
        <div className="section-header-v2-title-row">
          <h3 className="section-header-v2-title">{title}</h3>
          {helpText ? <InlineHelp text={helpText} /> : null}
        </div>
        {description ? (
          <div className="section-header-v2-description">{description}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="section-header-v2-actions">{actions}</div>
      ) : null}
    </div>
  );
}
