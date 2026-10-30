import type { Section } from "./store";

export type CapabilityObservationImpact = "destination" | "partial";

export interface CapabilityObservationOwner {
  section: Section;
  owner: string;
  source: string;
  impact: CapabilityObservationImpact;
  evidence: string;
}

/**
 * Auditable runtime-evidence owners. This is intentionally not a list of every
 * static readiness disclosure: entries exist only where a mounted feature has
 * an authoritative endpoint capable of confirming availability, setup absence
 * or plan eligibility for its named scope.
 */
export const CAPABILITY_OBSERVATION_OWNERS = [
  {
    section: "commerce",
    owner: "commerce-suite",
    source: "pages/Commerce.tsx",
    impact: "destination",
    evidence: "Commerce integrations suite-root endpoint",
  },
  {
    section: "helpdesk",
    owner: "service-suite",
    source: "pages/Helpdesk.tsx",
    impact: "destination",
    evidence: "Service-suite catalog endpoint",
  },
  {
    section: "audienceSyncs",
    owner: "webhook-sync",
    source: "pages/AudienceSyncs.tsx",
    impact: "partial",
    evidence: "Webhook audience-sync list endpoint",
  },
  {
    section: "audienceSyncs",
    owner: "ad-platforms",
    source: "components/AudienceDestinationsSection.tsx",
    impact: "partial",
    evidence: "Ad-platform audience destination list endpoint",
  },
  {
    section: "agency",
    owner: "subaccounts",
    source: "pages/Agency.tsx",
    impact: "partial",
    evidence: "Agency child-workspace endpoint and explicit not_agency code",
  },
  {
    section: "dataPlatform",
    owner: "warehouse-catalog",
    source: "components/dataplatform/WarehouseSection.tsx",
    impact: "partial",
    evidence: "Warehouse provider and object catalog endpoint",
  },
  {
    section: "dataPlatform",
    owner: "warehouse-connections",
    source: "components/dataplatform/WarehouseSection.tsx",
    impact: "partial",
    evidence: "Warehouse connection list endpoint",
  },
  {
    section: "dataPlatform",
    owner: "reverse-etl",
    source: "components/dataplatform/ReverseETLSection.tsx",
    impact: "partial",
    evidence: "Reverse-ETL connection and mapping endpoints",
  },
] as const satisfies readonly CapabilityObservationOwner[];
