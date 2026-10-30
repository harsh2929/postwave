/**
 * NewBadge — brand-teal pill used next to nav items / page titles to
 * announce features < 30 days old. Source of truth: lib/newFeatures.ts.
 *
 * Two call sites:
 *   <NewBadge section="compliance" />   // auto-decides from registry
 *   <NewBadge force />                  // unconditional — for page titles
 *                                       // where the wrapper component
 *                                       // already decided to render
 */

import type { ReactElement } from "react";

import { isFeatureNew } from "../lib/newFeatures";
import type { Section } from "../lib/store";

interface NewBadgeProps {
  section?: Section;
  force?: boolean;
}

export function NewBadge({ section, force }: NewBadgeProps): ReactElement | null {
  if (!force && (!section || !isFeatureNew(section))) return null;
  return (
    <span className="new-badge" aria-label="New feature">
      New
    </span>
  );
}
