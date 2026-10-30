import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PRODUCT_OWNERSHIP_MANIFEST,
  productOwnershipFor,
} from "../../lib/product-ownership-manifest";

const source = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("DUX-039 wave A/B product ownership", () => {
  it("declares the converged concepts and their canonical routes", () => {
    expect(PRODUCT_OWNERSHIP_MANIFEST.map((entry) => entry.concept)).toEqual([
      "subject-lab",
      "webhook-administration",
      "mcp-agent-connection",
      "commerce-store-administration",
    ]);
    expect(productOwnershipFor("subject-lab").canonicalOwner).toMatchObject({
      source: "components/SubjectLab.tsx",
      route: { section: "campaigns" },
    });
    expect(
      productOwnershipFor("webhook-administration").canonicalOwner,
    ).toMatchObject({
      source: "pages/WebhooksHome.tsx",
      route: { section: "webhooks" },
    });
    expect(
      productOwnershipFor("mcp-agent-connection").canonicalOwner,
    ).toMatchObject({
      source: "pages/MCP.tsx",
      route: { section: "mcp" },
    });
    expect(
      productOwnershipFor("commerce-store-administration").canonicalOwner,
    ).toMatchObject({
      source: "pages/Commerce.tsx",
      route: { section: "commerce", tab: "integrations" },
    });
  });

  it("removes the competing Subject Lab engine and keeps every live launch on the canonical workflow", () => {
    expect(
      existsSync(
        new URL("../../components/ai/SubjectLab.tsx", import.meta.url),
      ),
    ).toBe(false);
    const canonical = source("components/SubjectLab.tsx");
    const workspace = source("components/SubjectLabWorkspace.tsx");
    const postwaveAI = source("pages/PostwaveAI.tsx");
    const campaignOverlay = source(
      "pages/campaigns/CampaignCreateOverlays.tsx",
    );
    const copilot = source("components/composer/CopilotRail.tsx");

    expect(canonical).toContain("generateSubjectLabVariants");
    expect(canonical).toContain("scoreSubjectVariants");
    expect(canonical).toContain("baseline_open");
    expect(workspace).toContain('from "./SubjectLab"');
    expect(workspace).toContain("useDiscardOnlyDraftLifecycle({");
    expect(workspace).not.toContain("aiComposeVariants");
    expect(postwaveAI).toContain("<SubjectLabWorkspace");
    expect(postwaveAI).not.toContain("components/ai/SubjectLab");
    expect(postwaveAI).toContain("requestDesktopRouteNavigation({");
    expect(postwaveAI).toContain("peekPendingCampaignDraft() === pendingDraft");
    expect(campaignOverlay).toContain('import("../../components/SubjectLab")');
    expect(copilot).toContain('from "../SubjectLab"');
  });

  it("keeps Settings read-only and hands webhook administration to Webhooks", () => {
    const settings = source("pages/Settings.tsx");
    const summary = source(
      "components/settings/WebhookAdministrationSummary.tsx",
    );
    const home = source("pages/WebhooksHome.tsx");
    const listContext = source("components/lists/tabs/WebhooksTab.tsx");

    expect(settings).toContain("<WebhookAdministrationSummary />");
    expect(settings).toContain("<AlertPrefsSection />");
    expect(settings).not.toMatch(
      /createOutboundWebhook|deleteOutboundWebhook|testOutboundWebhook|WebhookCreateCard|WebhookSecretBanner/u,
    );
    expect(summary).toContain("listOutboundWebhooks({ limit: 200 })");
    expect(summary).toContain('section: "webhooks", tab: "outbound"');
    expect(summary).not.toMatch(
      /api\.(?:createWebhook|deleteWebhook|testWebhook)|signing_secret/u,
    );
    expect(home).toContain("<OutboundWebhooks />");
    expect(home).toContain("<InboundWebhooks />");
    expect(listContext).toContain("const LIST_EVENTS");
    expect(listContext).toContain("canonicalListID(list)");
    expect(listContext).toContain("list.postwave_uuid");
    expect(listContext).toContain("createListScopedWebhook(listID, input");
    expect(listContext).not.toContain("list_id:");
  });

  it("keeps MCP administration in MCP and Moosewave AI contextual", () => {
    const mcp = source("pages/MCP.tsx");
    const setup = source("components/mcp/McpConnectionSetup.tsx");
    const postwaveAI = source("pages/PostwaveAI.tsx");
    const summary = source("components/ai/McpAgentSummary.tsx");
    const recent = source("components/ai/RecentExecutionsStrip.tsx");
    const connection = source("components/ai/AgentConnectCard.tsx");

    expect(mcp).toContain(
      "<McpConnectionSetup identityScope={identityScope} />",
    );
    expect(mcp).toContain("function ToolsTab(");
    expect(mcp).toContain("function HistoryTab(");
    expect(setup).not.toContain("useShownOnceSecretLifecycle(");
    expect(setup).not.toContain("<AgentKeyCard");
    expect(setup).toContain("<AgentConnectCard");
    expect(setup).toContain('apiKey=""');
    expect(setup).toContain("transfersEnabled={false}");
    expect(setup).not.toMatch(/localStorage|sessionStorage|indexedDB/u);
    expect(postwaveAI).toContain("<McpAgentSummary />");
    expect(postwaveAI).toContain("<RecentExecutionsStrip />");
    expect(postwaveAI).toContain(
      "Review release-held MCP source candidate",
    );
    expect(postwaveAI).not.toContain(
      "Connect Claude / Cursor / ChatGPT via MCP",
    );
    expect(postwaveAI).not.toMatch(
      /AgentKeyCard|AgentConnectCard|CapabilityGallery/u,
    );
    expect(summary).not.toMatch(/listApiKeys|createApiKey|getMCPCatalog/u);
    expect(recent).toContain('section: "mcp", tab: "history"');
    expect(connection).toContain('"postwave.mcp.client.v1"');
    expect(connection).toContain('"postwave.ai.agent-client.v1"');
    expect(connection).toContain("localStorage.removeItem(LEGACY_PREF_LS_KEY)");
    expect(connection).not.toMatch(
      /localStorage\.setItem\([^,]+,\s*(?:apiKey|rendered)/u,
    );
  });

  it("keeps commerce administration in Commerce and Integrations discovery-only", () => {
    const commerce = source("pages/Commerce.tsx");
    const commerceTab = source("components/commerce/IntegrationsTab.tsx");
    const controller = source(
      "pages/integrations/useIntegrationLifecycleController.ts",
    );
    const overlays = source("pages/integrations/IntegrationOverlays.tsx");
    const providerModals = source(
      "pages/integrations/NativeProviderConnectModals.tsx",
    );

    expect(commerce).toContain(
      'useCapabilityReporter(\n    "commerce",\n    "commerce-suite",\n  )',
    );
    expect(commerce).toContain("parseCommerceAdministrationIntent(route)");
    expect(commerceTab).toContain("commerceApi.listProviders()");
    expect(commerceTab).toContain("commerceApi.createIntegration({");
    expect(commerceTab).toContain("commerceApi.syncIntegration(i.id, {})");
    expect(commerceTab).toContain("commerceApi.pauseIntegration(target.id)");
    expect(commerceTab).toContain(
      "commerceApi.disconnectIntegration(target.id)",
    );
    expect(controller).toContain("isCommerceOwnedIntegration(item)");
    expect(controller).toContain("commerceAdministrationRoute({");
    expect(controller).not.toContain("commerceApi");
    expect(providerModals).not.toMatch(
      /CommerceConnectModal|commerceApi|native-commerce/u,
    );
    expect(overlays).not.toMatch(/CommerceConnectModal|case "commerce"/u);
    expect(overlays).toContain("recipe.recipeDetail?.source");
    expect(overlays).toContain(
      "lifecycle.openManage(path, lifecycle.detail?.item)",
    );
  });
});
