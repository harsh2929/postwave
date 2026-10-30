// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UseTemplateDialog } from "@/app/(dashboard)/app/templates/_components/template-actions";
import { describeUnfilledDraftFields } from "@/app/(dashboard)/app/templates/_components/unfilled-draft-fields";
import type { CampaignTemplate } from "@/lib/campaign-templates-api";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  push: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, warning: mocks.warning, error: vi.fn() },
}));
vi.mock("@/lib/campaign-templates-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/campaign-templates-api")>()),
  createCampaignFromTemplate: mocks.create,
}));
vi.mock("@/lib/segments-api", () => ({ listSegments: async () => [] }));
vi.mock("@/lib/forms-api", () => ({ listLists: async () => [] }));

// The built-in "Changelog-First Launch" starter as migration 2055 leaves it:
// its link variables carry no default.
const launch = {
  id: "7d0c1f0e-2b8e-4c55-9a61-2f5b8c1d9e01",
  slug: "announcement-product-launch",
  name: "Changelog-First Launch",
  subject: "{{ brand_name }} {{ version }} shipped — here is what changed",
  goal: "announcement",
  template_kind: "editable",
  review_status: "approved",
  source_license_status: "owned",
  source_provider: "postwave",
  body_html: "<p>launch</p>",
  capabilities: { can_preview: true, can_create_campaign: true },
  variables: [
    { name: "version", label: "Version", default: "v2.4" },
    { name: "cta_url", label: "Try-it URL" },
    { name: "changelog_url", label: "Changelog URL", default: "" },
  ],
} as unknown as CampaignTemplate;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function submitDialog() {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(UseTemplateDialog, {
        template: launch,
        open: true,
        onOpenChange: () => {},
        showTrigger: false,
      }),
    );
  });
  const create = Array.from(document.querySelectorAll("button")).find(
    (button) => /create campaign draft/i.test(button.textContent ?? ""),
  );
  expect(create, "the dialog's create button").toBeTruthy();
  await act(async () => {
    create!.click();
  });
}

describe("UseTemplateDialog", () => {
  it("sends only the variables that have a value and says what the draft still needs", async () => {
    mocks.create.mockResolvedValue({
      id: "c0ffee00-0000-4000-8000-000000000001",
      unresolved_variables: ["changelog_url", "cta_url", "reply_to_email"],
    });
    await submitDialog();

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const payload = mocks.create.mock.calls[0][0];
    // A blank value would be written into the draft as href="".
    expect(payload.variables).toEqual({ version: "v2.4" });
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalledWith("Campaign draft created", {
      description:
        "Before you send, fill in Changelog URL and Try-it URL in the draft, and add a default reply-to address in Settings.",
    });
    expect(mocks.push).toHaveBeenCalledWith(
      "/app/campaigns/c0ffee00-0000-4000-8000-000000000001",
    );
  });

  it("confirms plainly when nothing is left to fill", async () => {
    mocks.create.mockResolvedValue({
      id: "c0ffee00-0000-4000-8000-000000000002",
      unresolved_variables: [],
    });
    await submitDialog();
    expect(mocks.success).toHaveBeenCalledWith("Campaign draft created");
    expect(mocks.warning).not.toHaveBeenCalled();
  });

  it("explains the merge tags in the pre-filled subject", async () => {
    mocks.create.mockResolvedValue({ id: "c1", unresolved_variables: [] });
    await submitDialog();
    const subject = document.querySelector<HTMLInputElement>(
      `#campaign-subject-${launch.id}`,
    );
    const hintID = subject?.getAttribute("aria-describedby");
    expect(hintID).toBeTruthy();
    expect(document.getElementById(hintID!)?.textContent).toContain(
      "filled in when the draft is created",
    );
  });
});

describe("describeUnfilledDraftFields", () => {
  it("names undeclared tags readably and never shows a raw tag name", () => {
    expect(
      describeUnfilledDraftFields(launch, ["hero_image_url", "subscriber.last_name"]),
    ).toBe("Before you send, fill in Hero image URL and Last name in the draft.");
    expect(describeUnfilledDraftFields(launch, [])).toBeNull();
    expect(describeUnfilledDraftFields(launch, undefined)).toBeNull();
  });
});
