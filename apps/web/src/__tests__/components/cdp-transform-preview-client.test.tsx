// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  verifyAdmin: vi.fn(),
  catalog: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    createElement("a", { href }, children as never),
}));
vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));
vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));
vi.mock("@/lib/cdp-transform-preview-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cdp-transform-preview-api")>()),
  getCDPTransformOperations: mocks.catalog,
  previewCDPTransforms: mocks.preview,
}));

import { CDPTransformPreviewClient } from "@/app/(dashboard)/app/cdp-transforms/transform-preview-client";
import type { MeResponse } from "@/lib/auth-api";
import {
  SAMPLE_CDP_OPERATIONS,
  type CDPTransformOperation,
} from "@/lib/cdp-transform-preview-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IDENTITY: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Test",
  workspace_slug: "test",
};

const CATALOG = [
  "coerce_number",
  "country_iso2",
  "email_normalize",
  "title_case",
  "trim",
];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.whoami.mockResolvedValue(IDENTITY);
  mocks.verifyAdmin.mockResolvedValue(IDENTITY);
  mocks.catalog.mockResolvedValue(CATALOG);
  const operations = JSON.parse(SAMPLE_CDP_OPERATIONS) as CDPTransformOperation[];
  mocks.preview.mockResolvedValue({
    properties: {
      email: "adalovelace@gmail.com",
      first_name: "Ada",
      address: { country: "GB" },
      ltv_cents: 12900,
    },
    results: operations.map((op) => ({
      op,
      changed: true,
      oldValue: "before",
      newValue: "after",
      error: null,
    })),
    success: operations.length,
    failed: 0,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("CDPTransformPreviewClient", () => {
  it("runs a real bounded sample only after fresh authority and catalog checks", async () => {
    const root = render();
    try {
      await flush();
      await click(requiredButton("Run preview"));
      await flush(8);
      expect(mocks.verifyAdmin).toHaveBeenCalledWith(
        IDENTITY,
        expect.any(AbortSignal),
      );
      expect(mocks.catalog).toHaveBeenCalledWith(
        expect.objectContaining({ fresh: true }),
      );
      expect(mocks.preview).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({ first_name: "ada" }),
          operations: expect.arrayContaining([
            expect.objectContaining({ type: "email_normalize", field: "email" }),
          ]),
        }),
        expect.any(AbortSignal),
      );
      expect(document.body.textContent).toContain("5 operation(s) succeeded");
      expect(document.body.textContent).toContain("Preview passed");
    } finally {
      act(() => root.unmount());
    }
  });

  it("keeps preview transmission locked in viewer mode", async () => {
    mocks.whoami.mockResolvedValue({
      ...IDENTITY,
      effective_role: "viewer",
      viewer_mode: true,
    });
    const root = render();
    try {
      await flush();
      expect(document.body.textContent).toContain("Preview execution is admin-scoped");
      expect(requiredButton("Admin required").disabled).toBe(true);
      expect(mocks.verifyAdmin).not.toHaveBeenCalled();
      expect(mocks.preview).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("marks acknowledged output stale when either draft changes", async () => {
    const root = render();
    try {
      await flush();
      await click(requiredButton("Run preview"));
      await flush(8);
      const properties = document.getElementById("cdp-properties-json");
      if (!(properties instanceof HTMLTextAreaElement)) {
        throw new Error("Missing properties editor");
      }
      await setTextarea(properties, '{"first_name":"grace"}');
      expect(document.body.textContent).toContain("Inputs changed");
      expect(document.body.textContent).toContain("previous input");
    } finally {
      act(() => root.unmount());
    }
  });
});

function render(): Root {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CDPTransformPreviewClient),
      ),
    );
  });
  return root;
}

async function flush(times = 5): Promise<void> {
  await act(async () => {
    for (let index = 0; index < times; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function requiredButton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setTextarea(
  target: HTMLTextAreaElement,
  value: string,
): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  await act(async () => {
    setter?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
