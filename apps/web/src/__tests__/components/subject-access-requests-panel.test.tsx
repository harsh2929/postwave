// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  listStores: vi.fn(),
  toastSuccess: vi.fn(),
  uuid: vi.fn(),
  verifyAdmin: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess } }));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));

vi.mock("@/lib/http-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http-fetch")>()),
  newUUIDv7: mocks.uuid,
}));

vi.mock("@/lib/compliance-requests-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance-requests-api")>()),
  createSarAccessRequest: mocks.create,
  listSarStoreResponses: mocks.listStores,
}));

import { SubjectAccessRequestsPanel } from "@/app/(dashboard)/app/compliance-requests/subject-access-requests-panel";
import type { MeResponse } from "@/lib/auth-api";
import type {
  SarAccessReceipt,
  SarRequest,
} from "@/lib/compliance-requests-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST_ID = "018f47f2-9f25-7f73-8ec6-3fd483eb51aa";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

function identity(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    email: "owner@example.test",
    role: "owner",
    effective_role: "owner",
    viewer_mode: false,
    auth_provider: "password",
    email_verified: true,
    workspace_name: "Operations",
    workspace_slug: "operations",
    ...overrides,
  };
}

function request(overrides: Partial<SarRequest> = {}): SarRequest {
  return {
    id: REQUEST_ID,
    kind: "access",
    subscriberEmail: "reader@example.com",
    status: "ready",
    rowsDeleted: null,
    eventCount: 12,
    consentCount: 2,
    bundleBytes: 2048,
    requestedBy: "admin:owner@example.test",
    requestedAt: "2026-09-03T10:00:00Z",
    readyAt: "2026-09-03T10:00:01Z",
    region: "GDPR",
    error: "",
    ...overrides,
  };
}

function receipt(): SarAccessReceipt {
  return {
    id: REQUEST_ID,
    kind: "access",
    subscriberEmail: "reader@example.com",
    status: "ready",
    eventCount: 12,
    consentCount: 2,
    bundleBytes: 2048,
    downloadPath: `/api/v1/sar/requests/${REQUEST_ID}.zip`,
    storeResponses: [],
  };
}

function render(node: ReactNode): Root {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return root;
}

function panel(
  overrides: Partial<Parameters<typeof SubjectAccessRequestsPanel>[0]> = {},
) {
  return (
    <SubjectAccessRequestsPanel
      identity={identity()}
      identityError={false}
      identityPending={false}
      identityRetrying={false}
      onRetryIdentity={vi.fn()}
      requests={[]}
      requestsError={null}
      requestsFetching={false}
      requestsPending={false}
      reloadRequests={vi.fn().mockResolvedValue([])}
      {...overrides}
    />
  );
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.includes(text),
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${text}`);
  }
  return button;
}

function changeInput(id: string, value: string): void {
  const input = document.getElementById(id);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error(`Input not found: ${id}`);
  }
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.uuid.mockReturnValue("018f47f2-stable-access-intent");
  mocks.verifyAdmin.mockResolvedValue(identity());
  mocks.listStores.mockResolvedValue([]);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("subject-access request panel", () => {
  it("single-flights creation and requires an exact list readback", async () => {
    let releaseAuthority!: (value: MeResponse) => void;
    mocks.verifyAdmin.mockReturnValueOnce(
      new Promise<MeResponse>((resolve) => {
        releaseAuthority = resolve;
      }),
    );
    mocks.create.mockResolvedValue(receipt());
    const reload = vi.fn().mockResolvedValue([request()]);
    const root = render(panel({ reloadRequests: reload }));

    try {
      act(() => buttonByText("New access request").click());
      act(() => changeInput("sar-subject-email", "Reader@Example.com"));
      expect(
        document.querySelector<HTMLInputElement>('input[type="checkbox"]')
          ?.checked,
      ).toBe(false);
      const submit = buttonByText("Create access bundle");
      act(() => {
        submit.click();
        submit.click();
      });
      expect(mocks.verifyAdmin).toHaveBeenCalledTimes(1);

      releaseAuthority(identity());
      await flush();
      expect(mocks.create).toHaveBeenCalledTimes(1);
      expect(mocks.create).toHaveBeenCalledWith(
        {
          email: "reader@example.com",
          fanoutEnabled: false,
          notes: "",
          region: "GDPR",
        },
        expect.objectContaining({
          idempotencyKey: "018f47f2-stable-access-intent",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(reload).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Bundle ready and read back");
      expect(mocks.toastSuccess).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("reuses an unchanged idempotency intent after an ambiguous failure", async () => {
    mocks.uuid
      .mockReset()
      .mockReturnValueOnce("018f47f2-first-access-intent")
      .mockReturnValueOnce("018f47f2-second-access-intent");
    mocks.create
      .mockRejectedValueOnce(new Error("The request outcome is unknown."))
      .mockResolvedValueOnce(receipt());
    const reload = vi.fn().mockResolvedValue([request()]);
    const root = render(panel({ reloadRequests: reload }));

    try {
      act(() => buttonByText("New access request").click());
      act(() => changeInput("sar-subject-email", "reader@example.com"));
      act(() => buttonByText("Create access bundle").click());
      await flush();
      expect(document.body.textContent).toContain(
        "The request outcome is unknown.",
      );
      act(() => buttonByText("Close").click());
      act(() => buttonByText("New access request").click());
      expect(document.body.textContent).toContain(
        "The request outcome is unknown.",
      );

      const retry = buttonByText("Retry access request");
      act(() => {
        retry.click();
        retry.click();
      });
      await flush();
      expect(mocks.create).toHaveBeenCalledTimes(2);
      expect(mocks.create.mock.calls[0]?.[1].idempotencyKey).toBe(
        mocks.create.mock.calls[1]?.[1].idempotencyKey,
      );
      expect(mocks.uuid).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain("Bundle ready and read back");
    } finally {
      act(() => root.unmount());
    }
  });

  it("does not fetch or expose SAR actions to a viewer and always holds erasure", () => {
    const root = render(
      panel({
        identity: identity({
          role: "admin",
          effective_role: "viewer",
          viewer_mode: true,
        }),
        requestsPending: true,
      }),
    );

    try {
      expect(document.body.textContent).toContain("inventory was not fetched");
      expect(document.body.textContent).toContain(
        "erasure is temporarily unavailable while retained-history coverage is being completed",
      );
      expect(document.body.textContent).toContain(
        "erasure_coverage_incomplete",
      );
      expect(buttonByText("Erasure unavailable").disabled).toBe(true);
      expect(document.body.textContent).not.toContain("New access request");
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.listStores).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("fresh-checks and readbacks a ready access request before same-origin download", async () => {
    const paths: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      paths.push(this.getAttribute("href") ?? "");
    });
    const reload = vi.fn().mockResolvedValue([request()]);
    const root = render(
      panel({ requests: [request()], reloadRequests: reload }),
    );

    try {
      const download = buttonByText("Download ZIP");
      act(() => {
        download.click();
        download.click();
      });
      await flush();
      expect(mocks.verifyAdmin).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(paths).toEqual([
        `/api/v1/sar/requests/${REQUEST_ID}.zip`,
      ]);
      expect(document.body.textContent).toContain(
        "after a fresh authority and server-state check",
      );
    } finally {
      act(() => root.unmount());
    }
  });
});
