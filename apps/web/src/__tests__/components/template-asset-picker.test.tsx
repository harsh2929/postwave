// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TemplateAssetPicker } from "@/app/(dashboard)/app/templates/_components/template-asset-picker";
import type { Asset } from "@/lib/assets-api";

const mocks = vi.hoisted(() => ({ listAssets: vi.fn(), insert: vi.fn() }));

vi.mock("@/lib/assets-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assets-api")>()),
  listAssets: mocks.listAssets,
}));

vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  const Wrapper = ({ children }: { children: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    Dialog: Wrapper,
    DialogContent: Wrapper,
    DialogHeader: Wrapper,
    DialogFooter: Wrapper,
    DialogTitle: Wrapper,
    DialogDescription: Wrapper,
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const asset: Asset = {
  id: "image-1",
  tenantId: "tenant-1",
  filename: "launch.png",
  mime: "image/png",
  bytes: 1024,
  width: 600,
  height: 400,
  url: "https://cdn.moosewave.com/launch.png",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  version: 1,
  altText: "",
  referencesCount: 0,
  lastUsedAt: null,
  folderId: null,
};

let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  mocks.listAssets.mockResolvedValue({
    items: [asset],
    nextCursor: null,
    counts: { all: 1, recent: 1, inUse: 0, unused: 1, large: 0 },
  });
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}

describe("template asset picker", () => {
  it("requires meaningful alt text before inserting a hosted image", async () => {
    await act(async () => {
      root.render(
        createElement(TemplateAssetPicker, {
          tenantId: "tenant-1",
          open: true,
          onOpenChange: vi.fn(),
          onInsert: mocks.insert,
        }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mocks.listAssets).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-1", limit: 50 }),
    );
    const choice = Array.from(document.querySelectorAll("button")).find(
      (item) => item.textContent?.includes("launch.png"),
    );
    expect(choice).toBeTruthy();
    await act(async () => choice?.click());
    expect(button("Insert image").disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>(
      "#template-asset-alt",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set?.call(input, "Launch artwork");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(button("Insert image").disabled).toBe(false);
    await act(async () => button("Insert image").click());
    expect(mocks.insert).toHaveBeenCalledWith(
      "https://cdn.moosewave.com/launch.png",
      "Launch artwork",
    );
  });
});
