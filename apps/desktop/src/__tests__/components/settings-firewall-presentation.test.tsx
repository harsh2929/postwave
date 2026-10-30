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
  vi,
} from "vitest";

import type { FirewallSettings } from "../../lib/api-client";
import type { FirewallController } from "../../components/settings/useFirewallController";

const mocks = vi.hoisted(() => ({
  controller: { value: null as unknown },
}));

vi.mock("../../components/settings/useFirewallController", () => ({
  useFirewallController: () => mocks.controller.value,
}));

import { FirewallSection } from "../../components/settings/FirewallSection";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.controller.value = controller();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function settings(): FirewallSettings {
  return {
    tenant_id: "tenant-1",
    attack_mode_enabled: false,
    auto_attack_mode: true,
    fingerprint_required: true,
    attack_mode_threshold: 70,
    surge_multiplier: 4,
    surge_min_per_hour: 100,
    updated_at: "2026-07-16T08:00:00.000Z",
  };
}

function controller(
  overrides: Partial<FirewallController> = {},
): FirewallController {
  const server = settings();
  return {
    canAdmin: true,
    server,
    draft: {
      attack_mode_enabled: server.attack_mode_enabled,
      auto_attack_mode: server.auto_attack_mode,
      fingerprint_required: server.fingerprint_required,
      attack_mode_threshold: 80,
      surge_multiplier: server.surge_multiplier,
      surge_min_per_hour: server.surge_min_per_hour,
    },
    stats: {
      last_24h: { accepted: 8, rejected: 2, observed: 1 },
      last_7d: { accepted: 80, rejected: 20, observed: 10 },
    },
    events: [],
    loading: false,
    error: null,
    saveError: null,
    saving: false,
    detecting: false,
    detectResult: null,
    dirty: true,
    mutationsLocked: false,
    load: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    detect: vi.fn().mockResolvedValue(undefined),
    setDraft: vi.fn(),
    ...overrides,
  };
}

function render(node: ReactElement = <FirewallSection />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("FirewallSection presentation", () => {
  it("disables every admin control for a viewer", () => {
    mocks.controller.value = controller({ canAdmin: false });
    render();

    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>("input")).every(
        (input) => input.disabled,
      ),
    ).toBe(true);
    expect(button("Check for surge").disabled).toBe(false);
    expect(button("Check for surge").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(button("Save settings").disabled).toBe(false);
    expect(button("Save settings").getAttribute("aria-disabled")).toBe("true");
    expect(button("Check for surge").title).toBe("");
    expect(document.body.textContent).toContain("Admin role required.");
  });

  it("locks fields and both mutations while an action is active", () => {
    mocks.controller.value = controller({
      saving: true,
      mutationsLocked: true,
    });
    render();

    expect(button("Saving…").disabled).toBe(false);
    expect(button("Saving…").getAttribute("aria-disabled")).toBe("true");
    expect(button("Check for surge").disabled).toBe(false);
    expect(button("Check for surge").getAttribute("aria-disabled")).toBe(
      "true",
    );
    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>("input")).every(
        (input) => input.disabled,
      ),
    ).toBe(true);
  });

  it("announces both asynchronous results and load failures", () => {
    mocks.controller.value = controller({
      detectResult: "No surge detected — settings unchanged.",
      error: "request failed",
    });
    render();

    expect(document.querySelector('[role="status"]')?.textContent).toContain(
      "No surge detected",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load firewall state: request failed",
    );
  });
});
