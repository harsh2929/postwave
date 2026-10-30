import type { ReactElement } from "react";

import { SubscribersPagePresentation } from "./subscribers/SubscribersPagePresentation";
import { useSubscribersPageController } from "./subscribers/useSubscribersPageController";

export function Subscribers(): ReactElement {
  const controller = useSubscribersPageController();
  return <SubscribersPagePresentation controller={controller} />;
}
