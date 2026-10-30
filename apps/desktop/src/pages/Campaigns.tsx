import type { ReactElement } from "react";

import { desktopRouteIdentityScope } from "../lib/desktop-router";
import { useMe } from "../lib/store";
import { CampaignsPresentation } from "./campaigns/CampaignsPresentation";
import { useCampaignsController } from "./campaigns/useCampaignsController";

export function Campaigns(): ReactElement {
  const me = useMe();
  const identityScope = desktopRouteIdentityScope(me?.user, me?.tenant);
  return (
    <CampaignsWorkspace
      key={identityScope ?? "campaigns-identity-unavailable"}
      identityScope={identityScope}
    />
  );
}

function CampaignsWorkspace({
  identityScope,
}: {
  identityScope: string | null;
}): ReactElement {
  const controller = useCampaignsController(identityScope);
  return <CampaignsPresentation controller={controller} />;
}
