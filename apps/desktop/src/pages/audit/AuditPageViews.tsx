import type { ReactElement } from "react";

import { AuditListView } from "./AuditListView";
import type { AuditPageController } from "./useAuditPageController";

export function AuditPageViews({
  controller,
}: {
  controller: AuditPageController;
}): ReactElement {
  return <AuditListView controller={controller} />;
}
