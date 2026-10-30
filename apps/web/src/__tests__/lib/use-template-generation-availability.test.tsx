// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VerifiedAuthScopeProvider } from "@/lib/auth-scope";
import { useTemplateGenerationAvailability } from "@/lib/use-template-generation-availability";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/campaign-templates-api", () => ({
  listCampaignTemplateDesigns: mocks.list,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ enabled = true }: { enabled?: boolean }) {
  return createElement("span", null, useTemplateGenerationAvailability(enabled));
}

describe("template generation availability", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    mocks.list.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function render(scope: string, count = 1, enabled = true) {
    await act(async () => {
      root.render(createElement(VerifiedAuthScopeProvider, {
        scope: { tenantId: scope, userId: "qa-user", canWriteCampaigns: true },
      }, ...Array.from({ length: count }, (_, index) =>
          createElement(Probe, { key: index, enabled }),
        )));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("fails closed when an older API omits the capability", async () => {
    mocks.list.mockResolvedValue({ items: [] });
    await render("older-api");
    expect(host.textContent).toBe("unavailable");
  });

  it("shares one actor-scoped check across multiple template cards", async () => {
    mocks.list.mockResolvedValue({ items: [], generation_available: true });
    await render("configured-api", 3);
    expect(host.textContent).toBe("availableavailableavailable");
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a failed check from a feature that is not enabled", async () => {
    mocks.list.mockRejectedValue(new Error("network unavailable"));
    await render("failed-api");
    expect(host.textContent).toBe("error");
  });

  it("does not check availability for a read-only visitor", async () => {
    await render("read-only", 1, false);
    expect(host.textContent).toBe("unavailable");
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
