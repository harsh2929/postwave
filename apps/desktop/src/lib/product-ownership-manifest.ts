import type { DesktopRoute } from "./desktop-router";

export type ProductOwnershipConcept =
  | "subject-lab"
  | "webhook-administration"
  | "mcp-agent-connection"
  | "commerce-store-administration";

export type ProductSurfaceRelationship =
  | "canonical-owner"
  | "contextual-workspace"
  | "status-handoff"
  | "diagnostic"
  | "discovery"
  | "recent-confirmation";

export interface ProductOwnershipSurface {
  source: string;
  relationship: ProductSurfaceRelationship;
  responsibilities: readonly string[];
  forbiddenResponsibilities?: readonly string[];
}

export interface ProductOwnershipDefinition {
  concept: ProductOwnershipConcept;
  canonicalOwner: ProductOwnershipSurface & {
    relationship: "canonical-owner";
    route: DesktopRoute;
  };
  supportingSurfaces: readonly ProductOwnershipSurface[];
}

/**
 * DUX-039 wave A/B ownership contract.
 *
 * This intentionally contains only the concepts converged in these waves.
 * Privacy, delivery, inbox and sending-settings ownership remain outside this
 * manifest until their source work is done.
 */
export const PRODUCT_OWNERSHIP_MANIFEST = [
  {
    concept: "subject-lab",
    canonicalOwner: {
      source: "components/SubjectLab.tsx",
      relationship: "canonical-owner",
      route: { section: "campaigns" },
      responsibilities: [
        "axis-conditioned variant generation",
        "tenant-baseline confidence scoring",
        "subject analyzer evidence",
        "campaign draft and A/B candidate callbacks",
      ],
    },
    supportingSurfaces: [
      {
        source: "components/SubjectLabWorkspace.tsx",
        relationship: "contextual-workspace",
        responsibilities: [
          "Moosewave AI seed and body draft",
          "explicit campaign handoff",
        ],
        forbiddenResponsibilities: [
          "independent subject scoring",
          "campaign creation",
          "campaign send",
        ],
      },
      {
        source: "components/composer/CopilotRail.tsx",
        relationship: "contextual-workspace",
        responsibilities: ["composer-context launch and result callback"],
      },
    ],
  },
  {
    concept: "webhook-administration",
    canonicalOwner: {
      source: "pages/WebhooksHome.tsx",
      relationship: "canonical-owner",
      route: { section: "webhooks" },
      responsibilities: [
        "inbound endpoint CRUD and secret rotation",
        "outbound subscription CRUD and delivery operations",
        "event catalog",
      ],
    },
    supportingSurfaces: [
      {
        source: "components/settings/WebhookAdministrationSummary.tsx",
        relationship: "status-handoff",
        responsibilities: ["read-only configuration health and owner handoff"],
        forbiddenResponsibilities: [
          "endpoint creation",
          "subscription mutation",
          "delivery test",
          "secret reveal",
        ],
      },
      {
        source: "pages/WebhookSimulator.tsx",
        relationship: "diagnostic",
        responsibilities: ["explicit synthetic delivery diagnostics"],
        forbiddenResponsibilities: ["endpoint or subscription CRUD"],
      },
      {
        source: "pages/Integrations.tsx",
        relationship: "discovery",
        responsibilities: ["integration recipe discovery"],
        forbiddenResponsibilities: ["endpoint or subscription CRUD"],
      },
      {
        source: "components/webhooks/AlertPrefsSection.tsx",
        relationship: "status-handoff",
        responsibilities: ["Settings-owned webhook alert preferences"],
        forbiddenResponsibilities: ["endpoint or subscription CRUD"],
      },
      {
        source: "components/lists/tabs/WebhooksTab.tsx",
        relationship: "contextual-workspace",
        responsibilities: [
          "list-bound subscriber-event subscription association",
        ],
        forbiddenResponsibilities: [
          "tenant-wide endpoint administration",
          "inbound endpoint administration",
          "general event subscription administration",
        ],
      },
    ],
  },
  {
    concept: "mcp-agent-connection",
    canonicalOwner: {
      source: "pages/MCP.tsx",
      relationship: "canonical-owner",
      route: { section: "mcp" },
      responsibilities: [
        "client setup and configuration",
        "API-key setup entry and shown-once secret lifecycle",
        "tool catalog",
        "execution history, quotas and observability",
      ],
    },
    supportingSurfaces: [
      {
        source: "components/ai/McpAgentSummary.tsx",
        relationship: "status-handoff",
        responsibilities: [
          "Moosewave AI contextual explanation and owner handoff",
        ],
        forbiddenResponsibilities: [
          "client installation",
          "API-key minting",
          "tool catalog administration",
        ],
      },
      {
        source: "components/ai/RecentExecutionsStrip.tsx",
        relationship: "recent-confirmation",
        responsibilities: ["bounded recent connection confirmation"],
        forbiddenResponsibilities: ["full execution administration"],
      },
    ],
  },
  {
    concept: "commerce-store-administration",
    canonicalOwner: {
      source: "pages/Commerce.tsx",
      relationship: "canonical-owner",
      route: { section: "commerce", tab: "integrations" },
      responsibilities: [
        "commerce provider registry and credential lifecycle",
        "store connection creation and OAuth launch",
        "store sync, backfill, pause and disconnect operations",
        "store health, sync state and canonical commerce data browsing",
      ],
    },
    supportingSurfaces: [
      {
        source: "pages/Integrations.tsx",
        relationship: "discovery",
        responsibilities: [
          "cross-product catalog and recipe discovery",
          "read-only readiness and connection summary",
          "typed provider/action handoff to Commerce",
        ],
        forbiddenResponsibilities: [
          "commerce credential collection",
          "commerce connection mutation",
          "commerce sync or backfill execution",
          "commerce operational detail and data browsing",
        ],
      },
    ],
  },
] as const satisfies readonly ProductOwnershipDefinition[];

export function productOwnershipFor(
  concept: ProductOwnershipConcept,
): ProductOwnershipDefinition {
  const definition = PRODUCT_OWNERSHIP_MANIFEST.find(
    (candidate) => candidate.concept === concept,
  );
  if (!definition) throw new Error(`Unknown product concept: ${concept}`);
  return definition;
}
