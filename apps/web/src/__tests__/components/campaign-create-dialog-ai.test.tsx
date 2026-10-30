// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CampaignCreateDialog } from "@/app/(dashboard)/app/campaigns/campaign-create-dialog";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) {
    act(() => root.unmount());
  }
  roots = [];
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function props(
  overrides: Partial<ComponentProps<typeof CampaignCreateDialog>> = {},
): ComponentProps<typeof CampaignCreateDialog> {
  return {
    abCreateError: null,
    audienceError: false,
    audienceLoading: false,
    audienceSegments: [
      { id: "segment-one", name: "Engaged readers" },
      { id: "segment-two", name: "Recent customers" },
    ],
    canWrite: true,
    creatingABTest: false,
    draft: { name: "Launch", subject: "Original launch subject" },
    onCreate: vi.fn(),
    onCreateABTest: vi.fn(),
    onDraftChange: vi.fn(),
    onOpenChange: vi.fn(),
    onRetryAudiences: vi.fn(),
    onSubjectChange: vi.fn(),
    open: true,
    readOnlyMessage: "Campaigns are read-only.",
    suggestions: ["First idea", "Second idea", "Third idea"],
    suggestError: null,
    suggestLoading: false,
    ...overrides,
  };
}

async function renderDialog(
  input: ComponentProps<typeof CampaignCreateDialog>,
): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(createElement(CampaignCreateDialog, input));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

describe("campaign-create AI actions", () => {
  it("binds all generated subjects to an explicit audience", async () => {
    const onCreateABTest = vi.fn();
    await renderDialog(props({ onCreateABTest }));

    const audience = document.querySelector<HTMLSelectElement>(
      "#campaign-ab-audience",
    );
    expect(audience?.value).toBe("segment-one");
    expect(button("A/B test all three").disabled).toBe(false);
    expect(document.body.textContent).toContain(
      "Nothing sends until you review and launch it.",
    );

    await act(async () => {
      button("A/B test all three").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onCreateABTest).toHaveBeenCalledOnce();
    expect(onCreateABTest).toHaveBeenCalledWith("segment-one");
  });

  it("fails closed and offers retry when audiences cannot be loaded", async () => {
    const onCreateABTest = vi.fn();
    const onRetryAudiences = vi.fn();
    await renderDialog(
      props({
        audienceError: true,
        audienceSegments: [],
        onCreateABTest,
        onRetryAudiences,
      }),
    );

    expect(button("A/B test all three").disabled).toBe(true);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load saved segment audiences.",
    );
    await act(async () => {
      button("Retry audiences").click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onRetryAudiences).toHaveBeenCalledOnce();
    expect(onCreateABTest).not.toHaveBeenCalled();
  });

  it("freezes every exit and editable field while the multi-resource write is pending", async () => {
    await renderDialog(props({ creatingABTest: true }));

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.getAttribute("aria-busy")).toBe("true");
    expect(
      document.querySelector<HTMLInputElement>("#campaign-name")?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>("#campaign-subject")?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLSelectElement>("#campaign-ab-audience")
        ?.disabled,
    ).toBe(true);
    expect(button("Close").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);
    expect(button("Create").disabled).toBe(true);
    expect(button("Creating A/B test…").disabled).toBe(true);
  });

  it("keeps a defensively opened dialog read-only when campaign authority is absent", async () => {
    const onCreate = vi.fn();
    const onCreateABTest = vi.fn();
    await renderDialog(props({ canWrite: false, onCreate, onCreateABTest }));

    expect(document.body.textContent).toContain("Campaigns are read-only.");
    expect(
      document.querySelector<HTMLInputElement>("#campaign-name")?.disabled,
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>("#campaign-subject")?.disabled,
    ).toBe(true);
    expect(button("Create").disabled).toBe(true);
    expect(button("A/B test all three").disabled).toBe(true);

    await act(async () => {
      button("Create").click();
      button("A/B test all three").click();
    });
    expect(onCreate).not.toHaveBeenCalled();
    expect(onCreateABTest).not.toHaveBeenCalled();
  });
});
