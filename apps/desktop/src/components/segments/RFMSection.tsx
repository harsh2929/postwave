/**
 * RFMSection — the Segments page boundary for RFM scores and heuristic
 * predictions. Request lifecycles live in the controller; the view keeps
 * server provenance and limitations visible at every prediction surface.
 */

import { type ReactElement } from "react";

import { useCanAdmin } from "../../lib/store";
import { RFMSectionView } from "./RFMSectionView";
import { useRFMSectionController } from "./useRFMSectionController";

export function RFMSection(): ReactElement {
  const canAdmin = useCanAdmin();
  const controller = useRFMSectionController(canAdmin);

  return <RFMSectionView canAdmin={canAdmin} controller={controller} />;
}
