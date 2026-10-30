/**
 * Tests for pathToSection() deep-link slug mapping — focused on the
 * four sections registered by the full-surface wiring pass
 * (automations / affiliates / commerce / dataPlatform) plus guards
 * that the neighbouring pre-existing slugs still win their prefixes.
 *
 * Runs in the node environment (see vitest.config.ts); store.ts is
 * imported with api-client stubbed, mirroring theme-load.test.ts.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type StoreModule = typeof import("../../lib/store");

let store: StoreModule;

beforeAll(async () => {
  vi.resetModules();
  // store.ts pulls api-client; stub to keep the boot path light.
  vi.doMock("../../lib/api-client", () => ({
    api: {},
    apiAuth: { reset: vi.fn() },
    clearApiConfig: vi.fn(),
  }));
  store = await import("../../lib/store");
});

describe("pathToSection — new sections (2026-06-11 wiring)", () => {
  it("maps /automations", () => {
    expect(store.pathToSection("/automations")).toBe("automations");
    expect(store.pathToSection("/app/automations/abc")).toBe("automations");
  });

  it("maps /affiliates", () => {
    expect(store.pathToSection("/affiliates")).toBe("affiliates");
    expect(store.pathToSection("/app/affiliates")).toBe("affiliates");
  });

  it("maps /commerce", () => {
    expect(store.pathToSection("/commerce")).toBe("commerce");
  });

  it("maps both /data-platform and /dataplatform spellings", () => {
    expect(store.pathToSection("/data-platform")).toBe("dataPlatform");
    expect(store.pathToSection("/dataplatform")).toBe("dataPlatform");
  });

  it("maps /integrations", () => {
    expect(store.pathToSection("/integrations")).toBe("integrations");
    expect(store.pathToSection("/app/integrations/shopify")).toBe(
      "integrations",
    );
  });

  it("is case-insensitive like the existing entries", () => {
    expect(store.pathToSection("/Automations")).toBe("automations");
    expect(store.pathToSection("/Data-Platform")).toBe("dataPlatform");
    expect(store.pathToSection("/Integrations")).toBe("integrations");
  });
});

describe("pathToSection — pre-existing slugs keep winning", () => {
  it("does not shadow neighbouring sections", () => {
    expect(store.pathToSection("/referrals")).toBe("referrals");
    expect(store.pathToSection("/discounts")).toBe("discounts");
    expect(store.pathToSection("/gift")).toBe("gifts");
    expect(store.pathToSection("/sequences")).toBe("sequences");
    expect(store.pathToSection("/migrations")).toBe("migrations");
    expect(store.pathToSection("/ai")).toBe("ai");
  });

  it("still returns null on unknown / empty paths", () => {
    expect(store.pathToSection("/nope")).toBeNull();
    expect(store.pathToSection(null)).toBeNull();
  });
});

describe("keyboard shortcut maps stay collision-free", () => {
  it("LETTER_SECTIONS gained no new bindings", () => {
    expect(Object.keys(store.LETTER_SECTIONS).sort()).toEqual(["d", "l"]);
  });

  it("NUMERIC_SECTIONS untouched", () => {
    expect(Object.keys(store.NUMERIC_SECTIONS)).toHaveLength(10);
  });
});
