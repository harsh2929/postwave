import { Suspense, lazy, type ReactElement } from "react";

import { ReplyMailboxCard } from "../../components/deliverability/ReplyMailboxCard";
import { ControlGroupsCard } from "../../components/experiments/ControlGroupsCard";
import { FeedSourcesSection } from "../../components/feedsources/FeedSourcesSection";
import { RepliesOverviewCard } from "../../components/replies/RepliesOverviewCard";
import {
  CampaignConfirmationOverlays,
  CampaignDetailAndFolderOverlays,
} from "./CampaignActionOverlays";
import { CampaignListView } from "./CampaignListView";
import { CampaignsTopPanels } from "./CampaignsTopPanels";
import type { CampaignsControllerProps } from "./campaigns-page-types";

const CampaignCreateOverlays = lazy(() =>
  import("./CampaignCreateOverlays").then((module) => ({
    default: module.CampaignCreateOverlays,
  })),
);

export function CampaignsPresentation({
  controller,
}: CampaignsControllerProps): ReactElement {
  return (
    <>
      <CampaignsTopPanels controller={controller} />
      <CampaignListView controller={controller} />
      <FeedSourcesSection
        onOpenCampaign={(campaignId) =>
          void controller.rowActions.openCampaignById(campaignId)
        }
      />
      <ControlGroupsCard />
      <RepliesOverviewCard campaigns={controller.state.rows} />
      <ReplyMailboxCard />
      <CampaignConfirmationOverlays controller={controller} />
      {controller.state.createOpen || controller.state.labOpen ? (
        <Suspense fallback={null}>
          <CampaignCreateOverlays controller={controller} />
        </Suspense>
      ) : null}
      <CampaignDetailAndFolderOverlays controller={controller} />
    </>
  );
}
