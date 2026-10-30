/**
 * SavedSegmentsManager — organizer boundary for saved-segment bookmarks.
 *
 * The controller owns lifecycle-safe reads, serialized writes, count
 * hydration, and pin ordering. The view owns accessible folder and row
 * presentation.
 */

import { type ReactElement } from "react";

import { SavedSegmentsManagerView } from "./SavedSegmentsManagerView";
import { useSavedSegmentsController } from "./useSavedSegmentsController";

interface Props {
  /** Viewer role can't mutate — disables every write affordance. */
  canMutate: boolean;
}

export function SavedSegmentsManager({ canMutate }: Props): ReactElement {
  const controller = useSavedSegmentsController(canMutate);
  return <SavedSegmentsManagerView controller={controller} />;
}
