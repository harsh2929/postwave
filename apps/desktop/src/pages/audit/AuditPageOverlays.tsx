import type { ReactElement } from "react";

import { AuditEventSlideover } from "../../components/AuditEventSlideover";
import type { AuditPageController } from "./useAuditPageController";

export function AuditPageOverlays({
  controller,
}: {
  controller: AuditPageController;
}): ReactElement {
  return (
    <>
      {controller.selected ? (
        <AuditEventSlideover
          row={controller.selected}
          releaseContained
          returnFocusRef={controller.eventReturnFocusRef}
          onClose={() => controller.setSelected(null)}
          onFilterActor={controller.filterToActor}
          onFilterResourceId={controller.filterToResource}
        />
      ) : null}
    </>
  );
}
