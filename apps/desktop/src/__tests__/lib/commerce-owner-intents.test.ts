import { describe, expect, it } from "vitest";

import type {
  CommerceIntegration,
  IntegrationCatalogItem,
} from "../../lib/api-client";
import {
  COMMERCE_ADMINISTRATION_TASKS,
  commerceAdministrationRoute,
  commerceTaskForLifecycleAction,
  isCommerceOwnedIntegration,
  parseCommerceAdministrationIntent,
  resolveCommerceAdministrationTarget,
} from "../../lib/commerce-owner-intents";
import {
  DesktopRouterController,
  type DesktopRouterEnvironment,
  parseDesktopRoute,
  serializeDesktopRoute,
} from "../../lib/desktop-router";

class CommerceHistoryEnvironment implements DesktopRouterEnvironment {
  readonly entries: Array<{ state: unknown; url: string }>;
  readonly storage: Map<string, string>;
  index = 0;
  readonly #listeners = new Set<(state: unknown) => void>();

  constructor(url = "/app/dashboard", storage = new Map<string, string>()) {
    this.entries = [{ state: null, url }];
    this.storage = storage;
  }

  location = (): string => this.entries[this.index]?.url ?? "/app/dashboard";
  historyState = (): unknown => this.entries[this.index]?.state ?? null;
  pushState = (state: unknown, url: string): void => {
    this.entries.splice(this.index + 1);
    this.entries.push({ state, url });
    this.index = this.entries.length - 1;
  };
  replaceState = (state: unknown, url: string): void => {
    this.entries[this.index] = { state, url };
  };
  go = (delta: number): void => {
    const next = this.index + delta;
    if (next < 0 || next >= this.entries.length || next === this.index) return;
    this.index = next;
    for (const listener of this.#listeners) listener(this.historyState());
  };
  subscribePopState = (listener: (state: unknown) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getStorage = (key: string): string | null => this.storage.get(key) ?? null;
  setStorage = (key: string, value: string): void => {
    this.storage.set(key, value);
  };
  removeStorage = (key: string): void => {
    this.storage.delete(key);
  };
}

const shopifyCatalogItem: IntegrationCatalogItem = {
  slug: "shopify",
  name: "Shopify",
  category: "ecommerce",
  badge: "native",
  runtime_status: "available",
  summary: "Commerce source",
  capabilities: ["orders"],
  native: true,
  sources: ["commerce"],
};

const store = (
  overrides: Partial<CommerceIntegration> = {},
): CommerceIntegration => ({
  id: "store_1",
  provider: "shopify",
  shop_domain: "owner.myshopify.com",
  status: "active",
  scopes: [],
  settings: {},
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z",
  ...overrides,
});

describe("commerce owner intents", () => {
  it.each(COMMERCE_ADMINISTRATION_TASKS)(
    "round-trips the %s handoff through the canonical route codec",
    (task) => {
      const intent = {
        task,
        provider: "shopify",
        integrationId: "store_1",
      } as const;
      const url = serializeDesktopRoute(commerceAdministrationRoute(intent));
      const parsed = parseDesktopRoute(url);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parseCommerceAdministrationIntent(parsed.route)).toEqual(intent);
    },
  );

  it("carries only action and source identifiers, never credential material", () => {
    const route = commerceAdministrationRoute({
      task: "connect",
      provider: "shopify",
    });
    expect(route).toEqual({
      section: "commerce",
      tab: "integrations",
      filters: [{ key: "provider", value: "shopify" }],
      overlay: { name: "connect-store" },
    });
    expect(JSON.stringify(route).toLowerCase()).not.toMatch(
      /credential|password|secret|settings|token/u,
    );
    expect(() =>
      commerceAdministrationRoute({
        task: "manage",
        provider: "shopify",
        integrationId: "   ",
      }),
    ).toThrow("Commerce integration id is invalid");
    expect(() =>
      commerceAdministrationRoute({
        task: "connect",
        provider: "https://credential.example",
      }),
    ).toThrow("Commerce provider must be a safe provider slug");
    expect(() =>
      commerceAdministrationRoute({
        task: "delete" as "connect",
        provider: "shopify",
      }),
    ).toThrow("Commerce administration task is invalid");
  });

  it("rejects ambiguous, unrelated, and unknown route shapes", () => {
    const base = commerceAdministrationRoute({
      task: "sync",
      provider: "shopify",
      integrationId: "store_1",
    });
    expect(
      parseCommerceAdministrationIntent({
        ...base,
        filters: [...(base.filters ?? []), { key: "status", value: "active" }],
      }),
    ).toBeNull();
    expect(
      parseCommerceAdministrationIntent({
        ...base,
        overlay: { name: "unknown-store", resourceId: "store_1" },
      }),
    ).toBeNull();
    expect(
      parseCommerceAdministrationIntent({ ...base, section: "integrations" }),
    ).toBeNull();
    expect(
      parseCommerceAdministrationIntent({
        ...base,
        filters: [{ key: "provider", value: "person@example.com" }],
      }),
    ).toBeNull();
    expect(
      parseCommerceAdministrationIntent({
        ...base,
        overlay: { name: "sync-store", resourceId: "person@example.com" },
      }),
    ).toBeNull();
  });

  it("restores the exact intent through Back, Forward, and a route reload", () => {
    const intent = {
      task: "disconnect",
      provider: "shopify",
      integrationId: "store_1",
    } as const;
    const intentRoute = commerceAdministrationRoute(intent);
    const environment = new CommerceHistoryEnvironment();
    const router = new DesktopRouterController(environment);
    router.navigate(intentRoute);
    router.navigate({ section: "commerce" });

    environment.go(-1);
    expect(
      parseCommerceAdministrationIntent(router.getSnapshot().route),
    ).toEqual(intent);
    environment.go(1);
    expect(
      parseCommerceAdministrationIntent(router.getSnapshot().route),
    ).toBeNull();

    const reloaded = new DesktopRouterController(
      new CommerceHistoryEnvironment(serializeDesktopRoute(intentRoute)),
    );
    expect(
      parseCommerceAdministrationIntent(reloaded.getSnapshot().route),
    ).toEqual(intent);
  });

  it("downgrades a customer-bearing action to its safe destination on reopen", () => {
    const storage = new Map<string, string>();
    const first = new DesktopRouterController(
      new CommerceHistoryEnvironment("/app/dashboard", storage),
    );
    first.setIdentity("user-a", "tenant-a");
    const intent = {
      task: "backfill",
      provider: "bigcommerce",
      integrationId: "store_1",
    } as const;
    first.navigate(commerceAdministrationRoute(intent));

    const persisted = [...storage.values()].join("\n").toLowerCase();
    expect(persisted).toContain('"section":"commerce"');
    expect(persisted).not.toContain("bigcommerce");
    expect(persisted).not.toContain("backfill-store");
    expect(persisted).not.toContain("store_1");
    expect(persisted).not.toMatch(
      /credential|password|secret|settings|token|shop-domain|draft/u,
    );

    const reopened = new DesktopRouterController(
      new CommerceHistoryEnvironment("/app/dashboard", storage),
    );
    reopened.setIdentity("user-a", "tenant-a");
    expect(reopened.getSnapshot().route).toEqual({ section: "commerce" });
    expect(
      parseCommerceAdministrationIntent(reopened.getSnapshot().route),
    ).toBeNull();
  });

  it("uses source ownership and exact provider/id matching", () => {
    expect(isCommerceOwnedIntegration(shopifyCatalogItem)).toBe(true);
    expect(
      isCommerceOwnedIntegration({
        ...shopifyCatalogItem,
        sources: ["bridge"],
      }),
    ).toBe(false);

    const stores = [store(), store({ id: "store_2", provider: "bigcommerce" })];
    expect(
      resolveCommerceAdministrationTarget(stores, {
        task: "manage",
        provider: "shopify",
        integrationId: "store_1",
      })?.id,
    ).toBe("store_1");
    expect(
      resolveCommerceAdministrationTarget(stores, {
        task: "disconnect",
        provider: "shopify",
        integrationId: "store_2",
      }),
    ).toBeNull();
  });

  it("maps only Commerce-owned lifecycle mutations", () => {
    expect(commerceTaskForLifecycleAction("connect/start")).toBe("connect");
    expect(commerceTaskForLifecycleAction("sync")).toBe("sync");
    expect(commerceTaskForLifecycleAction("backfill")).toBe("backfill");
    expect(commerceTaskForLifecycleAction("pause")).toBe("pause");
    expect(commerceTaskForLifecycleAction("disconnect")).toBe("disconnect");
    expect(commerceTaskForLifecycleAction("connect/callback")).toBeNull();
  });
});
