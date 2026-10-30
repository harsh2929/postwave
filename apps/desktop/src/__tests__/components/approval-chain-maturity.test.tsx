// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
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

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getChain: vi.fn(),
  setChain: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getApprovalChain: mocks.getChain,
    setApprovalChain: mocks.setChain,
  },
}));

import { ApprovalChainSection } from "../../components/settings/ApprovalChainSection";
import { resolveSettingsAnchorElements } from "../../lib/settings-anchor-focus";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function renderSection(): HTMLDivElement {
  container = document.createElement("div");
  container.id = "main-content";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ApprovalChainSection />));
  return container;
}

function expectNoChainTransport(): void {
  expect(mocks.getChain).not.toHaveBeenCalled();
  expect(mocks.setChain).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
}

describe("ApprovalChainSection release hold", () => {
  it("keeps the Settings destination truthful and performs zero transport", () => {
    const rendered = renderSection();
    const section = rendered.querySelector<HTMLElement>(
      '[data-settings-anchor="approval-chain"]',
    );
    const hold = rendered.querySelector<HTMLElement>(
      '[data-testid="approval-chain-release-hold"]',
    );

    expect(section).not.toBeNull();
    expect(section?.querySelector("h2")?.textContent).toBe("Approval chain");
    expect(hold?.getAttribute("role")).toBe("note");
    expect(hold?.textContent).toContain(
      "Multi-stage approvals are on release hold",
    );
    expect(hold?.textContent).toContain("Role enforcement:");
    expect(hold?.textContent).toContain("Base approval binding:");
    expect(hold?.textContent).toContain("Transactional completion:");
    expect(hold?.textContent).toContain(
      "performs no approval-chain reads or writes",
    );
    expect(hold?.textContent).toContain(
      "raw backend failure details are intentionally not displayed",
    );
    expect(
      section?.querySelector("button, input, select, textarea"),
    ).toBeNull();
    expectNoChainTransport();
  });

  it("retains a sane keyboard focus target and an axe-clean static tree", async () => {
    const rendered = renderSection();
    const anchor = resolveSettingsAnchorElements(rendered, "approval-chain");

    expect(anchor?.scrollOwner.dataset.settingsAnchor).toBe("approval-chain");
    expect(anchor?.focusOwner.textContent).toBe("Approval chain");
    if (!anchor) throw new Error("Missing approval-chain Settings anchor");
    anchor.focusOwner.tabIndex = -1;
    act(() => anchor.focusOwner.focus());
    expect(document.activeElement).toBe(anchor.focusOwner);
    expect(
      rendered.querySelector(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ).toBeNull();

    const result = await axe.run(rendered, {
      rules: { region: { enabled: false } },
    });
    expect(result.violations).toEqual([]);
    expectNoChainTransport();
  });
});
