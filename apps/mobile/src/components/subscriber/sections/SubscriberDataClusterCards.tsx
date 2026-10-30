/**
 * SubscriberDataClusterCards — the read-mostly Data cluster: what the
 * workspace KNOWS about this person beyond the profile fields — inferred
 * demographics, custom fields, linked custom-object records (SUB-011),
 * segment-decision explanations (SUB-070), and federated identity links
 * (SUB-023). One component so the Overview's composition stays inside its
 * budgets as the cluster grows.
 */
import { SubscriberCustomObjectsCard } from "@/components/subscriber/sections/SubscriberCustomObjectsCard";
import { SubscriberDemographicsCard } from "@/components/subscriber/sections/SubscriberDemographicsCard";
import { SubscriberFederatedLinksCard } from "@/components/subscriber/sections/SubscriberFederatedLinksCard";
import { SubscriberSegmentDecisionsCard } from "@/components/subscriber/sections/SubscriberSegmentDecisionsCard";
import { SubscriberCustomFieldsCard } from "@/components/subscriber/sections/SubscriberTagsCard";

export function SubscriberDataClusterCards({
  subscriberId,
  customFields,
  canMutate,
}: {
  subscriberId: string;
  customFields: Record<string, unknown> | undefined;
  canMutate: boolean;
}) {
  return (
    <>
      {/* Model-inferred demographics (SUB-063), confidence always attached.
          Viewer-scoped read, lazy like the rest of the Data cluster. */}
      <SubscriberDemographicsCard subscriberId={subscriberId} />
      <SubscriberCustomFieldsCard customFields={customFields} />

      {/* Non-person records linked to this profile (SUB-011) + catalog
          computed-traits — read-only Data cluster. */}
      <SubscriberCustomObjectsCard subscriberId={subscriberId} />

      {/* "Why is this person (not) in that segment" (SUB-070) — the
          right-to-explanation view, near the record history it complements. */}
      <SubscriberSegmentDecisionsCard subscriberId={subscriberId} />

      {/* SUB-023: cross-workspace identity links — Data cluster. */}
      <SubscriberFederatedLinksCard
        subscriberId={subscriberId}
        canMutate={canMutate}
      />
    </>
  );
}
