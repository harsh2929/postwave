// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

import type {
  IntegrationCatalogItem,
  IntegrationConnection,
  IntegrationDetailResponse,
  IntegrationRecipe,
  IntegrationRecipeDetailResponse,
} from "../../lib/api-client";
import type { IntegrationLifecycleController } from "../../pages/integrations/useIntegrationLifecycleController";
import type { IntegrationRecipeController } from "../../pages/integrations/useIntegrationRecipeController";

const mocks = vi.hoisted(() => ({
  actionBackfill: vi.fn(),
  actionDisconnect: vi.fn(),
  actionPause: vi.fn(),
  actionStart: vi.fn(),
  actionSync: vi.fn(),
  detail: vi.fn(),
  nativeBackfill: vi.fn(),
  nativeDisconnect: vi.fn(),
  nativePause: vi.fn(),
  nativeSync: vi.fn(),
  openUrl: vi.fn(),
  recipeApply: vi.fn(),
  recipeDetail: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../lib/api-client", () => {
  const nativeLifecycle = {
    sync: mocks.nativeSync,
    backfill: mocks.nativeBackfill,
    pause: mocks.nativePause,
    disconnect: mocks.nativeDisconnect,
  };
  return {
    analyticsIntegrationsApi: nativeLifecycle,
    crmIntegrationsApi: nativeLifecycle,
    leadIntegrationsApi: nativeLifecycle,
    loyaltyIntegrationsApi: nativeLifecycle,
    reviewIntegrationsApi: nativeLifecycle,
    subscriptionIntegrationsApi: nativeLifecycle,
    supportIntegrationsApi: nativeLifecycle,
    integrationsApi: {
      backfill: mocks.actionBackfill,
      callback: vi.fn(),
      detail: mocks.detail,
      disconnect: mocks.actionDisconnect,
      pause: mocks.actionPause,
      recipeDetail: mocks.recipeDetail,
      applyRecipe: mocks.recipeApply,
      startConnect: mocks.actionStart,
      sync: mocks.actionSync,
    },
  };
});

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopSection: vi.fn(),
  requestDesktopRouteNavigation: vi.fn().mockResolvedValue("proceeded"),
}));

vi.mock("../../lib/dashboard-url", () => ({
  buildDashboardHref: (_base: string, path: string) =>
    `https://dashboard.example.test${path}`,
  getDashboardUrl: () => "https://dashboard.example.test",
}));

vi.mock("../../lib/store", () => ({ pathToSection: () => null }));
vi.mock("../../lib/tauri", () => ({ tauriApi: { openUrl: mocks.openUrl } }));
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, info: mocks.toastInfo },
}));

import { useIntegrationLifecycleController } from "../../pages/integrations/useIntegrationLifecycleController";
import { useIntegrationRecipeController } from "../../pages/integrations/useIntegrationRecipeController";

function item(
  slug: string,
  options: { native?: boolean; sources?: string[] } = {},
): IntegrationCatalogItem {
  return {
    slug,
    name: slug.toUpperCase(),
    category: "forms",
    badge: options.native ? "native" : "zapier",
    runtime_status: options.native ? "available" : "delegated",
    summary: `${slug} integration`,
    capabilities: ["profiles"],
    native: options.native ?? false,
    sources: options.sources ?? ["bridge"],
    setup_path: `/integrations/${slug}`,
  };
}

function connection(
  slug: string,
  overrides: Partial<IntegrationConnection> = {},
): IntegrationConnection {
  return {
    slug,
    name: slug.toUpperCase(),
    category: "forms",
    badge: "native",
    runtime_status: "available",
    connected: true,
    status: "active",
    count: 1,
    primary_connection_id: `${slug}-1`,
    connection_ids: [`${slug}-1`],
    ...overrides,
  };
}

function detailResponse(
  integration: IntegrationCatalogItem,
  configured = connection(integration.slug),
): IntegrationDetailResponse {
  const alignedConnection: IntegrationConnection = {
    ...configured,
    slug: integration.slug,
    name: integration.name,
    category: integration.category,
    badge: integration.badge,
    runtime_status: integration.runtime_status,
    health_state: "healthy",
    health_message: "Healthy",
  };
  return {
    item: integration,
    connection: alignedConnection,
    setup: [],
    recipes: [],
    lifecycle_actions: ["sync", "disconnect"],
    health: {
      state: "healthy",
      severity: "ok",
      message: "Healthy",
      monitoring_surface: "Integrations",
      checks: [],
      retry_policy: {
        mode: "bounded",
        max_attempts: 3,
        backoff: "exponential",
        dead_letter: "operator review",
        idempotency: "connection id",
      },
      sync_history: [],
      audit_trail: [],
      data_delete: [],
    },
    contract: {
      slug: integration.slug,
      owner: "postwave",
      badge: integration.badge,
      runtime_status: integration.runtime_status,
      native_managed: integration.native,
      native_verified: integration.native,
      implementation_depth: "test",
      public_claim: "Test fixture",
      auth_modes: [],
      credential_storage: "vault",
      secret_policy: "references only",
      setup_surface: "Integrations",
      monitoring: [],
      lifecycle_actions: ["sync", "disconnect"],
      data_objects: [],
      event_topics: [],
      compliance_gates: [],
      privacy_actions: [],
      rate_limit_policy: "bounded",
      partner_review: "test",
    },
  };
}

function recipe(id: string, source = "source-a"): IntegrationRecipe {
  return {
    id,
    name: id.toUpperCase(),
    provider: "Moosewave",
    source_slug: source,
    summary: `${id} recipe`,
    badge: "native",
    available: true,
    estimated_minutes: 8,
    capabilities: ["profiles"],
    steps: [],
    blueprint: {
      trigger: "profile.created",
      destination: "Moosewave",
      postwave_surface: "/integrations",
      required_scopes: ["profiles.read"],
      required_secrets: ["provider_vault_ref"],
    },
  };
}

function recipeResponse(
  value: IntegrationRecipe,
): IntegrationRecipeDetailResponse {
  return {
    recipe: value,
    source: item(value.source_slug, { native: true, sources: ["crm"] }),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let lifecycle: IntegrationLifecycleController | null = null;
let recipes: IntegrationRecipeController | null = null;
let refresh: Mock<() => Promise<void>>;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  refresh = vi.fn(async () => undefined);
  mocks.openUrl.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  lifecycle = null;
  recipes = null;
});

function LifecycleHarness({
  canAdmin = true,
  connections = new Map<string, IntegrationConnection>(),
}: {
  canAdmin?: boolean;
  connections?: Map<string, IntegrationConnection>;
}): ReactElement {
  lifecycle = useIntegrationLifecycleController({
    canAdmin,
    catalog: null,
    connectionMap: connections,
    refresh,
  });
  return <div />;
}

function RecipeHarness({
  canAdmin = true,
  inventory,
}: {
  canAdmin?: boolean;
  inventory: IntegrationRecipe[];
}): ReactElement {
  recipes = useIntegrationRecipeController({
    canAdmin,
    recipes: inventory,
    detail: null,
  });
  return <div />;
}

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
}

function currentLifecycle(): IntegrationLifecycleController {
  if (!lifecycle) throw new Error("Lifecycle controller did not render");
  return lifecycle;
}

function currentRecipes(): IntegrationRecipeController {
  if (!recipes) throw new Error("Recipe controller did not render");
  return recipes;
}

describe("integration lifecycle exact-target safety", () => {
  it("ignores a slower detail response after the operator selects a newer integration", async () => {
    const alpha = item("alpha");
    const beta = item("beta");
    const alphaRequest = deferred<{ data: IntegrationDetailResponse }>();
    const betaRequest = deferred<{ data: IntegrationDetailResponse }>();
    mocks.detail.mockImplementation((slug: string) =>
      slug === "alpha" ? alphaRequest.promise : betaRequest.promise,
    );
    render(<LifecycleHarness />);

    let alphaPromise!: Promise<void>;
    let betaPromise!: Promise<void>;
    act(() => {
      alphaPromise = currentLifecycle().openDetail(alpha);
      betaPromise = currentLifecycle().openDetail(beta);
    });
    expect(currentLifecycle().selectedSlug).toBe("beta");
    expect(currentLifecycle().detail).toBeNull();

    await act(async () => {
      betaRequest.resolve({ data: detailResponse(beta) });
      await betaPromise;
    });
    expect(currentLifecycle().detail?.item.slug).toBe("beta");

    await act(async () => {
      alphaRequest.resolve({ data: detailResponse(alpha) });
      await alphaPromise;
    });
    expect(currentLifecycle().detail?.item.slug).toBe("beta");
  });

  it("fails closed for unknown server-supplied lifecycle actions", async () => {
    const integration = item("bridge");
    render(<LifecycleHarness />);
    await act(async () =>
      currentLifecycle().runLifecycleAction(integration, "future/action"),
    );

    expect(mocks.actionStart).not.toHaveBeenCalled();
    expect(mocks.actionSync).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Unsupported integration action" }),
    );
  });

  it("keeps disconnect review open when the exact mutation fails", async () => {
    const integration = item("bridge");
    mocks.detail.mockResolvedValue({ data: detailResponse(integration) });
    mocks.actionDisconnect.mockResolvedValue({
      error: { message: "Provider cleanup failed" },
    });
    render(<LifecycleHarness />);

    await act(async () =>
      currentLifecycle().runLifecycleAction(integration, "disconnect"),
    );
    expect(currentLifecycle().pendingDisconnectItem?.slug).toBe("bridge");
    await act(async () => currentLifecycle().confirmDisconnect());

    expect(mocks.actionDisconnect).toHaveBeenCalledWith("bridge");
    expect(currentLifecycle().pendingDisconnectItem?.slug).toBe("bridge");
  });

  it("refuses an arbitrary primary connection when multiple native accounts exist", async () => {
    const integration = item("crm", { native: true, sources: ["crm"] });
    const ambiguous = connection("crm", {
      count: 2,
      primary_connection_id: "crm-2",
      connection_ids: ["crm-1", "crm-2"],
    });
    mocks.detail.mockResolvedValue({
      data: detailResponse(integration, ambiguous),
    });
    render(<LifecycleHarness connections={new Map([["crm", ambiguous]])} />);

    await act(async () =>
      currentLifecycle().runLifecycleAction(integration, "disconnect"),
    );
    await act(async () => currentLifecycle().confirmDisconnect());

    expect(mocks.nativeDisconnect).not.toHaveBeenCalled();
    expect(mocks.actionDisconnect).not.toHaveBeenCalled();
    expect(currentLifecycle().pendingDisconnectItem?.slug).toBe("crm");
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Choose the exact CRM connection first",
      }),
    );
  });

  it("allows only one catalog mutation at a time and refreshes delegated evidence", async () => {
    const integration = item("bridge");
    const request = deferred<{
      data: {
        slug: string;
        action: string;
        status: string;
        message: string;
      };
    }>();
    mocks.actionSync.mockReturnValue(request.promise);
    render(<LifecycleHarness />);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = currentLifecycle().runAction(integration, "sync");
      second = currentLifecycle().runAction(integration, "sync");
    });
    await expect(second).resolves.toBe(false);
    expect(mocks.actionSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      request.resolve({
        data: {
          slug: "bridge",
          action: "sync",
          status: "delegated",
          message: "Continue in bridge setup",
        },
      });
      await first;
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "BRIDGE sync handoff is ready",
      }),
    );
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://dashboard.example.test/integrations/bridge",
    );
  });

  it("locks disconnect confirmation while exact-target verification is in flight", async () => {
    const integration = item("bridge");
    const verification = deferred<{ data: IntegrationDetailResponse }>();
    mocks.detail.mockReturnValue(verification.promise);
    mocks.actionDisconnect.mockResolvedValue({
      error: { message: "Provider cleanup failed" },
    });
    render(<LifecycleHarness />);

    await act(async () =>
      currentLifecycle().runLifecycleAction(integration, "disconnect"),
    );
    let first!: Promise<void>;
    await act(async () => {
      first = currentLifecycle().confirmDisconnect();
      await Promise.resolve();
    });
    expect(currentLifecycle().disconnectVerifying).toBe(true);

    await act(async () => currentLifecycle().confirmDisconnect());
    expect(mocks.detail).toHaveBeenCalledTimes(1);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "Wait for it to finish before confirming disconnection.",
      }),
    );

    await act(async () => {
      verification.resolve({ data: detailResponse(integration) });
      await first;
    });
    expect(currentLifecycle().disconnectVerifying).toBe(false);
  });

  it("rechecks and blocks a newly discovered multi-account disconnect target", async () => {
    const integration = item("bridge");
    const ambiguous = connection("bridge", {
      badge: "zapier",
      runtime_status: "delegated",
      count: 2,
      primary_connection_id: "bridge-2",
      connection_ids: ["bridge-1", "bridge-2"],
    });
    mocks.detail.mockResolvedValue({
      data: detailResponse(integration, ambiguous),
    });
    render(<LifecycleHarness />);

    await act(async () =>
      currentLifecycle().runLifecycleAction(integration, "disconnect"),
    );
    await act(async () => currentLifecycle().confirmDisconnect());

    expect(mocks.actionDisconnect).not.toHaveBeenCalled();
    expect(currentLifecycle().pendingDisconnectItem?.slug).toBe("bridge");
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Choose the exact BRIDGE connection first",
      }),
    );
  });
});

describe("integration recipe review safety", () => {
  it("ignores a stale recipe response after a newer blueprint is selected", async () => {
    const alpha = recipe("alpha");
    const beta = recipe("beta", "source-b");
    const alphaRequest = deferred<{ data: IntegrationRecipeDetailResponse }>();
    const betaRequest = deferred<{ data: IntegrationRecipeDetailResponse }>();
    mocks.recipeDetail.mockImplementation((id: string) =>
      id === "alpha" ? alphaRequest.promise : betaRequest.promise,
    );
    render(<RecipeHarness inventory={[alpha, beta]} />);

    let alphaPromise!: Promise<void>;
    let betaPromise!: Promise<void>;
    act(() => {
      alphaPromise = currentRecipes().openRecipeDetail(alpha);
      betaPromise = currentRecipes().openRecipeDetail(beta);
    });
    await act(async () => {
      betaRequest.resolve({ data: recipeResponse(beta) });
      await betaPromise;
    });
    await act(async () => {
      alphaRequest.resolve({ data: recipeResponse(alpha) });
      await alphaPromise;
    });

    expect(currentRecipes().selectedRecipeID).toBe("beta");
    expect(currentRecipes().recipeDetail?.recipe.id).toBe("beta");
  });

  it("requires review before preparing a recipe and does not claim creation", async () => {
    const selected = recipe("profile-sync");
    mocks.recipeDetail.mockResolvedValue({ data: recipeResponse(selected) });
    mocks.recipeApply.mockResolvedValue({
      data: {
        recipe_id: selected.id,
        status: "delegated",
        message: "Continue setup",
        delegated_to: "/api/v1/crm/integrations",
        blueprint: selected.blueprint,
      },
    });
    render(<RecipeHarness inventory={[selected]} />);

    await act(async () => currentRecipes().applyRecipe(selected));
    expect(currentRecipes().pendingRecipe?.id).toBe(selected.id);
    expect(mocks.recipeApply).not.toHaveBeenCalled();

    await act(async () => currentRecipes().confirmRecipePreparation());
    expect(mocks.recipeApply).toHaveBeenCalledWith(selected.id);
    expect(currentRecipes().pendingRecipe).toBeNull();
    expect(currentRecipes().recipeApply?.recipe_id).toBe(selected.id);
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "PROFILE-SYNC setup plan is ready",
        detail: expect.stringContaining("No automation was created"),
      }),
    );
  });

  it("keeps the review open when a preparation response targets another recipe", async () => {
    const selected = recipe("profile-sync");
    mocks.recipeDetail.mockResolvedValue({ data: recipeResponse(selected) });
    mocks.recipeApply.mockResolvedValue({
      data: {
        recipe_id: "different-recipe",
        status: "delegated",
        message: "Wrong target",
        blueprint: selected.blueprint,
      },
    });
    render(<RecipeHarness inventory={[selected]} />);

    await act(async () => currentRecipes().applyRecipe(selected));
    await act(async () => currentRecipes().confirmRecipePreparation());

    expect(currentRecipes().pendingRecipe?.id).toBe(selected.id);
    expect(currentRecipes().recipeApply).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: "The server returned malformed or mismatched setup evidence.",
      }),
    );
  });

  it("keeps review open when the server downgrades a recipe to planned", async () => {
    const selected = recipe("profile-sync");
    mocks.recipeDetail.mockResolvedValue({ data: recipeResponse(selected) });
    mocks.recipeApply.mockResolvedValue({
      data: {
        recipe_id: selected.id,
        status: "planned",
        message: "Roadmap preview",
        blueprint: selected.blueprint,
      },
    });
    render(<RecipeHarness inventory={[selected]} />);

    await act(async () => currentRecipes().applyRecipe(selected));
    await act(async () => currentRecipes().confirmRecipePreparation());

    expect(currentRecipes().pendingRecipe?.id).toBe(selected.id);
    expect(currentRecipes().recipeApply).toBeNull();
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.stringContaining("No setup plan or automation"),
      }),
    );
  });

  it("keeps viewer recipe controls non-mutating", async () => {
    const selected = recipe("viewer-recipe");
    render(<RecipeHarness canAdmin={false} inventory={[selected]} />);

    await act(async () => currentRecipes().applyRecipe(selected));

    expect(currentRecipes().pendingRecipe).toBeNull();
    expect(mocks.recipeDetail).not.toHaveBeenCalled();
    expect(mocks.recipeApply).not.toHaveBeenCalled();
  });
});
