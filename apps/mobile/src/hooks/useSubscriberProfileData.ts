/**
 * useSubscriberProfileData — the three lazy Data-cluster queries: GPP
 * sections, linked custom-object records (+catalog traits), and the
 * SUB-070 segment-membership explanations.
 *
 * Each is `enabled` only while its card is OPEN (the profile's disclosure
 * idiom: a profile open must not fan out ledger reads), keys carry the
 * tenant, and the paired reads that feed ONE card travel together in one
 * queryFn so the card never renders half of its truth.
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchSubscriberCatalogAttributes,
  fetchSubscriberCustomObjectLinks,
  fetchSubscriberDecisionExplanations,
  fetchSubscriberGpp,
  fetchSubscriberSegmentMembership,
} from "@/api/subscribersProfileData";
import { useOnlineQueryGate } from "@/hooks/useOnlineQueryGate";
import { parseGpp, type GppView } from "@/lib/subscriberGpp";
import {
  parseCatalogAttributes,
  parseProfileLinks,
  type CatalogAttributeRow,
  type ProfileLinkRow,
} from "@/lib/subscriberCustomObjects";
import {
  parseDecisionExplanations,
  parseSegmentMemberships,
  type DecisionExplanationRow,
  type SegmentMembershipRow,
} from "@/lib/subscriberSegmentDecisions";

export function useSubscriberGpp(subscriberId: string, enabled: boolean) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["subscriber-gpp", gate.tenantId, subscriberId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    queryFn: async (): Promise<GppView> =>
      parseGpp(await fetchSubscriberGpp(subscriberId)),
  });
}

export interface SubscriberObjectsView {
  links: ProfileLinkRow[];
  catalog: CatalogAttributeRow[];
}

export function useSubscriberCustomObjects(
  subscriberId: string,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["subscriber-custom-objects", gate.tenantId, subscriberId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    queryFn: async (): Promise<SubscriberObjectsView> => {
      const [links, catalog] = await Promise.all([
        fetchSubscriberCustomObjectLinks(subscriberId),
        fetchSubscriberCatalogAttributes(subscriberId),
      ]);
      return {
        links: parseProfileLinks(links),
        catalog: parseCatalogAttributes(catalog),
      };
    },
  });
}

export interface SubscriberDecisionsView {
  memberships: SegmentMembershipRow[];
  stored: DecisionExplanationRow[];
}

export function useSubscriberSegmentDecisions(
  subscriberId: string,
  enabled: boolean,
) {
  const gate = useOnlineQueryGate();
  return useQuery({
    queryKey: ["subscriber-segment-decisions", gate.tenantId, subscriberId],
    enabled: enabled && gate.enabled && Boolean(gate.tenantId && subscriberId),
    queryFn: async (): Promise<SubscriberDecisionsView> => {
      const [memberships, stored] = await Promise.all([
        fetchSubscriberSegmentMembership(subscriberId),
        fetchSubscriberDecisionExplanations(subscriberId),
      ]);
      return {
        memberships: parseSegmentMemberships(memberships),
        stored: parseDecisionExplanations(stored),
      };
    },
  });
}
