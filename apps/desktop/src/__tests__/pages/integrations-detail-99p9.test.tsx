// @vitest-environment happy-dom

import axe from "axe-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  IntegrationCatalogItem,
  IntegrationConnection,
  IntegrationConnectorContract,
  IntegrationDetailResponse,
  IntegrationHealthReport,
  IntegrationRecipe,
  IntegrationRecipeApplyResponse,
  IntegrationRecipeBlueprint,
} from "../../lib/api-client";
import {
  DetailPanel,
  RecipeBlueprintPanel,
  RecipeLibrary,
} from "../../pages/integrations/IntegrationDetailPanels";

const catalogItem: IntegrationCatalogItem = {
  slug: "shop",
  name: "Shop platform",
  category: "ecommerce",
  badge: "native",
  runtime_status: "available",
  summary: "A managed commerce connector.",
  capabilities: ["profiles", "orders"],
  setup_path: "/integrations/shop",
  native: true,
};

const connection: IntegrationConnection = {
  slug: "shop",
  name: "Shop platform",
  category: "ecommerce",
  badge: "native",
  runtime_status: "available",
  connected: true,
  status: "active",
  count: 1,
  primary_connection_id: "shop-account-exact-001",
  connection_ids: ["shop-account-exact-001"],
  last_sync_at: "2026-08-09T10:00:00Z",
  manage_path: "/commerce/integrations/shop-account-exact-001",
  source: "commerce",
  health_state: "healthy",
  health_message: "The exact account reports healthy operation.",
};

const blueprint: IntegrationRecipeBlueprint = {
  trigger: "order.created",
  destination: "Moosewave profiles",
  postwave_surface: "/audience/profiles",
  required_scopes: ["customers.read", "orders.read"],
  required_secrets: ["provider_vault_ref"],
  events: ["order.created"],
  data_handling: ["Verify marketing consent before activation"],
  field_mappings: [
    {
      source: "customer.email",
      target: "profile.email",
      required: true,
      description: "Stable profile identity.",
    },
    {
      source: "order.total",
      target: "profile.last_order_total",
      required: false,
    },
  ],
  sample_payload: {
    customer: { email: "sample@example.test" },
    order: { total: 42 },
  },
};

const recipe: IntegrationRecipe = {
  id: "shop-profile-playbook",
  name: "Commerce profile setup",
  provider: "Moosewave native",
  source_slug: "shop",
  target_slug: "postwave-profiles",
  summary: "Prepare a reviewed profile-sync setup plan.",
  badge: "native",
  available: true,
  estimated_minutes: 12,
  setup_path: "/integrations/shop/setup",
  capabilities: ["profiles", "consent"],
  steps: [
    {
      title: "Review requested access",
      description: "Confirm the exact provider scopes and consent boundary.",
      required_fields: ["provider_vault_ref"],
    },
    {
      title: "Open managed setup",
      description: "Continue in the exact setup surface.",
      action: "Open managed setup",
      path: "/integrations/shop/setup",
      required_fields: [],
    },
  ],
  blueprint,
};

const contract: IntegrationConnectorContract = {
  slug: "shop",
  owner: "postwave",
  badge: "native",
  runtime_status: "available",
  native_managed: true,
  native_verified: true,
  implementation_depth: "native_verified",
  public_claim: "A native-managed connector with verified API coverage.",
  auth_modes: ["oauth"],
  credential_storage: "Encrypted reference vault",
  secret_policy: "Reference identifiers only",
  setup_surface: "Commerce integrations",
  monitoring: ["sync history", "provider status"],
  lifecycle_actions: ["connect/start", "sync", "disconnect"],
  bridge_channels: [],
  required_scopes: ["customers.read", "orders.read"],
  data_objects: ["customers", "orders"],
  event_topics: ["order.created"],
  compliance_gates: ["marketing consent"],
  privacy_actions: ["disconnect", "data deletion review"],
  rate_limit_policy: "Provider-aware bounded retry",
  partner_review: "not applicable",
};

const health: IntegrationHealthReport = {
  state: "needs_attention",
  severity: "warning",
  message: "One provider check needs review.",
  monitoring_surface: "Commerce operations",
  docs_url: "/docs/integrations/shop/health",
  checks: [
    {
      key: "credentials",
      label: "Credential reference",
      state: "ok",
      message: "A credential reference is configured.",
    },
    {
      key: "provider_latency",
      label: "Provider latency",
      state: "needs_attention",
      message: "Provider latency is above the declared operating baseline.",
    },
  ],
  retry_policy: {
    mode: "bounded",
    max_attempts: 4,
    backoff: "exponential with jitter",
    dead_letter: "operator review queue",
    idempotency: "exact connection and provider object ID",
  },
  sync_history: [
    {
      at: "2026-08-09T10:00:00Z",
      action: "profile_sync",
      status: "completed",
      attempts: 1,
      message: "The reported run completed.",
    },
    {
      at: "not-a-date",
      action: "order_backfill",
      status: "failed",
      attempts: 2,
      message: "The reported run stopped before completion.",
      error:
        "Provider timeout with an intentionally long operator-safe description.",
    },
  ],
  audit_trail: [
    {
      at: null,
      action: "integration.connection.observed",
      actor: "system observer",
      message: "A connector state observation was synthesized for context.",
    },
  ],
  data_delete: [
    {
      method: "DELETE",
      path: "/api/v1/commerce/integrations/{exact_connection_id}",
      description:
        "Review the exact-account disconnect and provider cleanup instructions.",
    },
  ],
};

function integrationDetail(
  overrides: Partial<IntegrationDetailResponse> = {},
): IntegrationDetailResponse {
  return {
    item: catalogItem,
    connection,
    setup: recipe.steps,
    recipes: [recipe],
    lifecycle_actions: ["connect/start", "sync", "disconnect"],
    health,
    contract,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderSurface(node: ReactElement): void {
  container ??= document.createElement("div");
  if (!container.isConnected) document.body.appendChild(container);
  root ??= createRoot(container);
  act(() => root?.render(node));
}

function detailProps(
  overrides: Partial<React.ComponentProps<typeof DetailPanel>> = {},
): React.ComponentProps<typeof DetailPanel> {
  return {
    detail: integrationDetail(),
    loading: false,
    categoryLabels: new Map([["ecommerce", "Commerce"]]),
    onClose: vi.fn(),
    onOpenPath: vi.fn(),
    onOpenRecipe: vi.fn(),
    onApplyRecipe: vi.fn(),
    applyingRecipeID: "",
    onLifecycleAction: vi.fn(),
    busyLifecycleAction: "",
    canAdmin: true,
    ...overrides,
  };
}

function libraryProps(
  overrides: Partial<React.ComponentProps<typeof RecipeLibrary>> = {},
): React.ComponentProps<typeof RecipeLibrary> {
  return {
    recipes: [recipe],
    loading: false,
    onOpenRecipe: vi.fn(),
    onApplyRecipe: vi.fn(),
    applyingRecipeID: "",
    onOpenSource: vi.fn(),
    canAdmin: true,
    ...overrides,
  };
}

function blueprintProps(
  overrides: Partial<React.ComponentProps<typeof RecipeBlueprintPanel>> = {},
): React.ComponentProps<typeof RecipeBlueprintPanel> {
  return {
    detail: {
      recipe,
      source: catalogItem,
      target: {
        ...catalogItem,
        slug: "postwave-profiles",
        name: "Moosewave profiles",
      },
    },
    fallbackRecipe: recipe,
    loading: false,
    applyResult: null,
    applyingRecipeID: "",
    onApplyRecipe: vi.fn(),
    onOpenPath: vi.fn(),
    onClose: vi.fn(),
    canAdmin: true,
    ...overrides,
  };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("integration detail 99.9th-percentile operator surface", () => {
  it("exposes exact identity, assurance, outage taxonomy, safe time semantics, and honest evidence language", async () => {
    renderSurface(<DetailPanel {...detailProps()} />);

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(dialog?.textContent).toContain("Connection identity");
    expect(dialog?.textContent).toContain("shop-account-exact-001");
    expect(dialog?.textContent).toContain("API-verified native contract");
    expect(dialog?.textContent).toContain("Scopes & consent");
    expect(dialog?.textContent).toContain("Lifecycle controls");
    expect(dialog?.textContent).toContain("Health, outages & recovery");
    expect(dialog?.textContent).toContain("Retry & failure policy");
    expect(dialog?.textContent).toContain("Operational observations");
    expect(dialog?.textContent).toContain(
      "not independently verified audit evidence",
    );
    expect(dialog?.textContent).not.toContain("Audit trail");
    expect(dialog?.textContent).toContain("Data lifecycle instructions");
    expect(dialog?.textContent).toContain(
      "does not prove that deletion occurred",
    );

    expect(
      dialog?.querySelector('time[datetime="2026-08-09T10:00:00.000Z"]'),
    ).not.toBeNull();
    expect(dialog?.textContent).toContain("Timestamp unavailable");
    expect(dialog?.textContent).toContain("Not reported");

    const icons = Array.from(dialog?.querySelectorAll("svg") ?? []);
    expect(icons.length).toBeGreaterThan(0);
    for (const icon of icons) {
      expect(icon.closest('[aria-hidden="true"]')).not.toBeNull();
    }

    const accessibility = await axe.run(dialog!, {
      resultTypes: ["violations"],
      rules: { "aria-allowed-role": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("renders an explicit state for every empty detail collection without inventing success", () => {
    const emptyContract: IntegrationConnectorContract = {
      ...contract,
      native_verified: false,
      auth_modes: [],
      monitoring: [],
      lifecycle_actions: [],
      bridge_channels: [],
      required_scopes: [],
      data_objects: [],
      event_topics: [],
      compliance_gates: [],
      privacy_actions: [],
    };
    const emptyHealth: IntegrationHealthReport = {
      ...health,
      state: "unrecognized_state",
      checks: [],
      retry_policy: { ...health.retry_policy, max_attempts: 0 },
      sync_history: [],
      audit_trail: [],
      data_delete: [],
    };
    const emptyConnection: IntegrationConnection = {
      ...connection,
      connected: false,
      count: 0,
      primary_connection_id: undefined,
      connection_ids: [],
      last_sync_at: null,
      health_state: undefined,
      health_message: undefined,
    };
    renderSurface(
      <DetailPanel
        {...detailProps({
          detail: integrationDetail({
            item: { ...catalogItem, capabilities: [], sources: [] },
            connection: emptyConnection,
            setup: [],
            recipes: [],
            lifecycle_actions: [],
            health: emptyHealth,
            contract: emptyContract,
          }),
        })}
      />,
    );

    const contents = document.body.textContent ?? "";
    for (const explicitState of [
      "No connection identifiers were returned",
      "No catalog capabilities are declared",
      "No catalog source families are declared",
      "No authentication modes are declared",
      "No connector scopes are declared",
      "No consent or compliance gates are declared",
      "No monitoring surfaces are declared",
      "No lifecycle actions are declared by the contract",
      "No data objects are declared",
      "No event topics are declared",
      "No privacy actions are declared",
      "No bridge channels are declared",
      "No lifecycle actions are declared for this connector",
      "No health checks were returned",
      "No recent operation history was returned",
      "No operational observations were returned",
      "No data-lifecycle instructions were returned",
      "No setup steps were returned",
      "No curated setup playbooks were returned",
    ]) {
      expect(contents).toContain(explicitState);
    }
    expect(contents).toContain("Unknown");
    expect(contents).toContain(
      "does not provide a recognized health classification",
    );
    expect(contents).not.toContain("caller managed");
    expect(
      document.querySelectorAll('[data-empty-state="true"]').length,
    ).toBeGreaterThanOrEqual(16);
  });

  it("keeps exact-target lifecycle blocks focusable, explained, and inert", () => {
    const onLifecycleAction = vi.fn();
    const ambiguousConnection: IntegrationConnection = {
      ...connection,
      count: 2,
      primary_connection_id: "shop-account-a",
      connection_ids: ["shop-account-a", "shop-account-b"],
    };
    renderSurface(
      <DetailPanel
        {...detailProps({
          detail: integrationDetail({
            connection: ambiguousConnection,
            lifecycle_actions: ["sync"],
          }),
          onLifecycleAction,
        })}
      />,
    );

    const sync = button("Sync now");
    expect(sync.disabled).toBe(false);
    expect(sync.getAttribute("aria-disabled")).toBe("true");
    const reasonID = sync.getAttribute("aria-describedby");
    const reason = reasonID ? document.getElementById(reasonID) : null;
    expect(reason?.textContent).toContain(
      "Choose one exact configured account",
    );
    expect(reason?.tabIndex).toBe(0);
    act(() => sync.focus());
    expect(document.activeElement).toBe(sync);
    act(() => sync.click());
    expect(onLifecycleAction).not.toHaveBeenCalled();
  });

  it("runs enabled lifecycle and instruction interactions against their exact values", () => {
    const onLifecycleAction = vi.fn();
    const onOpenPath = vi.fn();
    renderSurface(
      <DetailPanel
        {...detailProps({
          detail: integrationDetail({
            lifecycle_actions: ["sync", "oauth/start"],
          }),
          onLifecycleAction,
          onOpenPath,
        })}
      />,
    );

    act(() => button("Sync now").click());
    expect(onLifecycleAction).toHaveBeenCalledWith(catalogItem, "sync");
    const unsupportedOAuth = button("Start OAuth");
    expect(unsupportedOAuth.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(
        unsupportedOAuth.getAttribute("aria-describedby") ?? "missing",
      )?.textContent,
    ).toContain("not supported by this version");
    act(() => unsupportedOAuth.click());
    expect(onLifecycleAction).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Reference only — review and execute this instruction",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Open instructions",
      ),
    ).toBe(false);
    expect(onOpenPath).not.toHaveBeenCalledWith(
      "/api/v1/commerce/integrations/{exact_connection_id}",
    );
    act(() => button("Open managed setup").click());
    expect(onOpenPath).toHaveBeenCalledWith("/integrations/shop/setup");
  });
});

describe("integration setup playbooks", () => {
  it("keeps planned, viewer, and busy preparation reasons visible and keyboard focusable", () => {
    const onApplyRecipe = vi.fn();
    const planned = { ...recipe, id: "planned-playbook", available: false };
    renderSurface(
      <RecipeLibrary
        {...libraryProps({ recipes: [planned], onApplyRecipe })}
      />,
    );

    let prepare = button("Prepare setup");
    let reasonID = prepare.getAttribute("aria-describedby");
    let reason = reasonID ? document.getElementById(reasonID) : null;
    expect(prepare.disabled).toBe(false);
    expect(prepare.getAttribute("aria-disabled")).toBe("true");
    expect(reason?.textContent).toContain("Planned playbook");
    expect(reason?.tabIndex).toBe(0);
    act(() => reason?.focus());
    expect(document.activeElement).toBe(reason);
    act(() => prepare.click());
    expect(onApplyRecipe).not.toHaveBeenCalled();

    renderSurface(
      <RecipeLibrary {...libraryProps({ canAdmin: false, onApplyRecipe })} />,
    );
    prepare = button("Prepare setup");
    reasonID = prepare.getAttribute("aria-describedby");
    reason = reasonID ? document.getElementById(reasonID) : null;
    expect(reason?.textContent).toContain("Admin role required");
    expect(reason?.tabIndex).toBe(0);

    renderSurface(
      <RecipeLibrary
        {...libraryProps({
          applyingRecipeID: recipe.id,
          onApplyRecipe,
        })}
      />,
    );
    prepare = button("Preparing setup…");
    reasonID = prepare.getAttribute("aria-describedby");
    reason = reasonID ? document.getElementById(reasonID) : null;
    expect(prepare.getAttribute("aria-busy")).toBe("true");
    expect(reason?.textContent).toContain(
      "current setup preparation to finish",
    );
    expect(reason?.tabIndex).toBe(0);
    expect(document.body.textContent).not.toMatch(/\b(?:Apply|Use recipe)\b/i);
  });

  it("provides explicit recipe-card empty states and dispatches review interactions", () => {
    const onOpenRecipe = vi.fn();
    const onOpenSource = vi.fn();
    const onApplyRecipe = vi.fn();
    const sparseRecipe: IntegrationRecipe = {
      ...recipe,
      target_slug: undefined,
      estimated_minutes: 0,
      capabilities: [],
      steps: [],
    };
    renderSurface(
      <RecipeLibrary
        {...libraryProps({
          recipes: [sparseRecipe],
          onOpenRecipe,
          onOpenSource,
          onApplyRecipe,
        })}
      />,
    );

    expect(document.body.textContent).toContain("DestinationUnknown");
    expect(document.body.textContent).toContain("Estimate unknown");
    expect(document.body.textContent).toContain(
      "No capabilities are declared for this playbook",
    );
    expect(document.body.textContent).toContain(
      "No setup steps are declared for this playbook",
    );
    act(() => button("Prepare setup").click());
    expect(onApplyRecipe).toHaveBeenCalledWith(sparseRecipe);
    act(() => button("Review blueprint").click());
    expect(onOpenRecipe).toHaveBeenCalledWith(sparseRecipe);
    act(() => button("Source details").click());
    expect(onOpenSource).toHaveBeenCalledWith("shop");
  });

  it("renders semantic mappings and bounded payload context, then prepares without claiming completion", async () => {
    const onApplyRecipe = vi.fn();
    const onOpenPath = vi.fn();
    const applyResult: IntegrationRecipeApplyResponse = {
      recipe_id: recipe.id,
      status: "delegated",
      message: "A reviewable setup plan was generated.",
      delegated_to: "Commerce integrations",
      manage_path: "/integrations/shop/prepared",
      required_fields: [],
      next_steps: [],
      blueprint,
    };
    renderSurface(
      <RecipeBlueprintPanel
        {...blueprintProps({ applyResult, onApplyRecipe, onOpenPath })}
      />,
    );

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const table = dialog?.querySelector("table");
    const mappingRegion = dialog?.querySelector<HTMLElement>(
      '[role="region"][aria-label="Scrollable field mappings"]',
    );
    expect(mappingRegion?.tabIndex).toBe(0);
    expect(table?.querySelector("caption")?.textContent).toContain(
      "2 declared field mappings",
    );
    expect(table?.querySelectorAll('th[scope="col"]')).toHaveLength(4);
    expect(
      dialog?.querySelector('pre[aria-label="Sample payload"]'),
    ).not.toBeNull();
    expect(dialog?.textContent).toContain("customer.email");
    expect(dialog?.textContent).toContain("profile.email");
    expect(dialog?.textContent).toContain("Setup plan prepared");
    expect(dialog?.textContent).toContain(
      "not proof that a connector was configured",
    );
    expect(dialog?.textContent).toContain(
      "No additional required fields were returned",
    );
    expect(dialog?.textContent).toContain("No setup steps were returned");

    act(() => button("Prepare setup").click());
    expect(onApplyRecipe).toHaveBeenCalledWith(recipe);
    act(() => button("Open setup").click());
    expect(onOpenPath).toHaveBeenCalledWith("/integrations/shop/prepared");
    expect(dialog?.textContent).not.toMatch(/\b(?:Apply|Use recipe)\b/i);

    const accessibility = await axe.run(dialog!, {
      resultTypes: ["violations"],
      rules: { "aria-allowed-role": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("states missing blueprint collections and unavailable surfaces explicitly", () => {
    const emptyBlueprint: IntegrationRecipeBlueprint = {
      trigger: "profile.created",
      destination: "",
      postwave_surface: "",
      required_scopes: [],
      required_secrets: [],
      events: [],
      data_handling: [],
      field_mappings: [],
      sample_payload: {},
    };
    const emptyRecipe = {
      ...recipe,
      target_slug: undefined,
      blueprint: emptyBlueprint,
      steps: [],
    };
    renderSurface(
      <RecipeBlueprintPanel
        {...blueprintProps({
          detail: null,
          fallbackRecipe: emptyRecipe,
        })}
      />,
    );
    const contents = document.body.textContent ?? "";
    for (const state of [
      "Unknown destination",
      "No required scopes are declared",
      "No secret references are declared",
      "No event bindings are declared",
      "No consent or special data-handling instructions are declared",
      "No explicit field mappings were provided",
      "No sample payload was provided",
      "No setup steps were returned",
    ]) {
      expect(contents).toContain(state);
    }

    renderSurface(
      <RecipeBlueprintPanel
        {...blueprintProps({ detail: null, fallbackRecipe: null })}
      />,
    );
    expect(document.body.textContent).toContain("Playbook detail unavailable");
    expect(document.body.textContent).toContain(
      "Access, mappings, and setup behavior remain unknown",
    );
  });
});

describe("integration detail source and adaptive presentation contracts", () => {
  it("keeps layout out of JSX and provides responsive accessibility modes", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/pages/integrations/IntegrationDetailPanels.tsx",
      ),
      "utf8",
    );
    const styles = readFileSync(
      resolve(process.cwd(), "src/styles-integrations-detail.css"),
      "utf8",
    );

    expect(source).not.toContain("style={{");
    expect(source).not.toContain('"Use recipe"');
    expect(source).not.toContain('"Apply recipe"');
    expect(source).toContain("int-operator-slideover");
    expect(source).toContain("int-playbook-slideover");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain("@media (max-width: 520px)");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("@media (forced-colors: active)");
    expect(styles).toContain("overflow-wrap: anywhere");
    expect(styles).toContain("max-height: 430px");
  });
});
