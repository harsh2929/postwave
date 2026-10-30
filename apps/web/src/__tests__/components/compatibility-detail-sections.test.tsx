// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompatibilityDetailSections } from "@/app/(dashboard)/app/compatibility/compatibility-detail-sections";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
  window.history.replaceState({}, "", "/");
});

function render(ui: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return root;
}

function action(): ReturnType<typeof vi.fn<() => Promise<void>>> {
  return vi.fn(async () => undefined);
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (element): element is HTMLButtonElement =>
      element instanceof HTMLButtonElement &&
      element.textContent?.includes(text) === true,
  );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

function props(
  overrides: Partial<Parameters<typeof CompatibilityDetailSections>[0]> = {},
): Parameters<typeof CompatibilityDetailSections>[0] {
  const baseProps: Parameters<typeof CompatibilityDetailSections>[0] = {
    accountExports: null,
    agencyEcosystem: null,
    applyLocalMailchimpClosures: action(),
    assets: [],
    audienceInsights: null,
    batches: null,
    blockCatalog: null,
    busy: null,
    clickMap: null,
    connectedSites: null,
    contentStudio: null,
    convertSampleVideo: action(),
    createAccountExportSnapshot: action(),
    creativeDraft: null,
    customReport: null,
    deliveryInsights: null,
    demoActionsEnabled: true,
    draftCampaignCreative: action(),
    groups: [],
    inbox: null,
    integrations: [],
    journeys: [],
    landingPages: [],
    landingParity: null,
    marketplace: null,
    multiChannel: null,
    multivariate: null,
    parityWorkbench: null,
    planner: null,
    popups: [],
    previewSampleTemplate: action(),
    runBatchCompatibilityCheck: action(),
    segmentSchema: null,
    sendDay: null,
    sendTime: null,
    surveys: null,
    templatePreview: null,
    verifiedDomains: null,
    videoConversion: null,
    websiteStatus: null,
  };
  return Object.assign(baseProps, overrides);
}

describe("CompatibilityDetailSections", () => {
  it("exposes semantic section headings and current-page navigation", () => {
    const root = render(createElement(CompatibilityDetailSections, props()));

    try {
      const headings = Array.from(document.querySelectorAll("h2"));
      expect(headings).toHaveLength(7);
      expect(headings.map((heading) => heading.id)).toEqual([
        "compat-workbench",
        "compat-intelligence",
        "compat-multichannel",
        "compat-audience",
        "compat-content",
        "compat-developer",
        "compat-objects",
      ]);

      const links = Array.from(
        document.querySelectorAll<HTMLAnchorElement>(
          'nav[aria-label="Parity sections"] a',
        ),
      );
      expect(links[0].getAttribute("aria-current")).toBe("location");
      act(() => links[4].click());
      expect(links[0].hasAttribute("aria-current")).toBe(false);
      expect(links[4].getAttribute("aria-current")).toBe("location");
    } finally {
      act(() => root.unmount());
    }
  });

  it("hides write controls when demo actions are disabled", () => {
    const root = render(
      createElement(CompatibilityDetailSections, {
        ...props(),
        demoActionsEnabled: false,
      }),
    );

    try {
      expect(document.body.textContent).toContain("Remaining parity workbench");
      expect(document.body.textContent).toContain("Compatibility objects");
      expect(document.body.textContent).not.toContain("Apply local closures");
      expect(document.body.textContent).not.toContain("Run batch check");
      expect(document.body.textContent).not.toContain("Generate creative");
    } finally {
      act(() => root.unmount());
    }
  });

  it("routes action buttons through props", () => {
    const callbacks = {
      applyLocalMailchimpClosures: action(),
      createAccountExportSnapshot: action(),
      convertSampleVideo: action(),
      draftCampaignCreative: action(),
      previewSampleTemplate: action(),
      runBatchCompatibilityCheck: action(),
    };
    const root = render(
      createElement(CompatibilityDetailSections, {
        ...props(callbacks),
        demoActionsEnabled: true,
      }),
    );

    try {
      act(() => {
        buttonByText("Apply local closures").click();
        buttonByText("Generate creative").click();
        buttonByText("Convert video").click();
        buttonByText("Preview template").click();
        buttonByText("Run batch check").click();
        buttonByText("Create export").click();
      });

      expect(callbacks.applyLocalMailchimpClosures).toHaveBeenCalledTimes(1);
      expect(callbacks.draftCampaignCreative).toHaveBeenCalledTimes(1);
      expect(callbacks.convertSampleVideo).toHaveBeenCalledTimes(1);
      expect(callbacks.previewSampleTemplate).toHaveBeenCalledTimes(1);
      expect(callbacks.runBatchCompatibilityCheck).toHaveBeenCalledTimes(1);
      expect(callbacks.createAccountExportSnapshot).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("announces the active demo action and blocks competing writes", () => {
    const root = render(
      createElement(CompatibilityDetailSections, {
        ...props(),
        busy: "Template preview",
      }),
    );

    try {
      const active = buttonByText("Preview template");
      expect(active.disabled).toBe(true);
      expect(active.getAttribute("aria-busy")).toBe("true");
      expect(buttonByText("Generate creative").disabled).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  });
});
