// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  whoami: vi.fn(),
  verifyAdmin: vi.fn(),
  listPrograms: vi.fn(),
  getProgram: vi.fn(),
  listEvents: vi.fn(),
  attest: vi.fn(),
  revoke: vi.fn(),
  successToast: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mocks.successToast, error: vi.fn() },
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: mocks.whoami,
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: mocks.verifyAdmin,
}));

vi.mock("@/lib/compliance-programs-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/compliance-programs-api")>()),
  listCompliancePrograms: mocks.listPrograms,
  getComplianceProgram: mocks.getProgram,
  listComplianceEvents: mocks.listEvents,
  attestComplianceProgram: mocks.attest,
  revokeComplianceProgram: mocks.revoke,
}));

// happy-dom does not hydrate Next's `{ ssr: false }` loader. Substitute the
// real deferred control plane at that one boundary so these interaction tests
// exercise its authority checks, dialogs, and mutations instead of stopping
// at the production loading skeleton. The route keeps its lazy boundary.
vi.mock("next/dynamic", async () => {
  const { ComplianceProgramControlPlane } =
    await import("@/app/(dashboard)/app/compliance/compliance-program-control-plane");
  return { default: () => ComplianceProgramControlPlane };
});

import CompliancePage from "@/app/(dashboard)/app/compliance/page";
import type { MeResponse } from "@/lib/auth-api";
import { setOnlineStatusForTest } from "@/lib/online-manager";
import type { ComplianceProgram } from "@/lib/compliance-programs-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OWNER: MeResponse = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.com",
  role: "owner",
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Evidence workspace",
  workspace_slug: "evidence",
};
const REVISION = "2026-08-30T10:00:00Z";
const NEXT_REVISION = "2026-08-30T10:01:00Z";
const HIPAA: ComplianceProgram = {
  framework: "hipaa",
  status: "unsupported",
  notes: "No BAA is offered and PHI workloads are prohibited.",
};

let current: ComplianceProgram;

function pending(): ComplianceProgram {
  return { framework: "soc2", status: "in_progress" };
}

function attested(updatedAt = REVISION): ComplianceProgram {
  return {
    framework: "soc2",
    status: "attested",
    signedByEmail: OWNER.email,
    signerName: "Legal",
    documentPath: "s3://private/report.pdf",
    documentSha256: "a".repeat(64),
    attestedAt: "2026-08-29T10:00:00Z",
    renewalAt: "2027-08-29T10:00:00Z",
    updatedAt,
  };
}

beforeEach(() => {
  // Bounded "load more" requests are gated on the online manager, which
  // starts as "connecting" under vitest.
  setOnlineStatusForTest("online");
  vi.clearAllMocks();
  current = pending();
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.verifyAdmin.mockResolvedValue(OWNER);
  mocks.listPrograms.mockImplementation(() =>
    Promise.resolve([HIPAA, current]),
  );
  mocks.getProgram.mockImplementation(() => Promise.resolve(current));
  mocks.listEvents.mockResolvedValue({
    events: [],
    hasMore: false,
    limit: 100,
    nextCursor: null,
  });
  mocks.attest.mockImplementation(async () => {
    current = attested(NEXT_REVISION);
    return { ok: true, framework: "soc2", updatedAt: NEXT_REVISION };
  });
  mocks.revoke.mockImplementation(async () => {
    current = { ...attested(), status: "revoked", updatedAt: NEXT_REVISION };
    return { ok: true, updatedAt: NEXT_REVISION };
  });
});

afterEach(() => {
  setOnlineStatusForTest("connecting");
  document.body.replaceChildren();
});

describe("compliance programme control plane", () => {
  it("does not request tenant-confidential evidence for non-admin sessions", async () => {
    mocks.whoami.mockResolvedValue({ ...OWNER, role: "viewer" });
    const root = render();
    try {
      await flush();
      expect(document.body.textContent).toContain(
        "Owner or admin access required",
      );
      expect(mocks.listPrograms).not.toHaveBeenCalled();
      expect(mocks.getProgram).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("records an attestation only after fresh authority, state preflight, and readback", async () => {
    const root = render();
    try {
      await flush();
      await click(await waitForButton("SOC 2"));
      await flush();
      expect(document.body.textContent).toContain(
        "No evidence events have been recorded",
      );
      await click(button("Attest"));
      await setInput("#compliance-document-sha", "a".repeat(64));
      await click(button("Review attestation"));
      await click(button("Record attestation"));
      await flush(10);

      expect(mocks.verifyAdmin).toHaveBeenCalledWith(OWNER);
      expect(mocks.attest).toHaveBeenCalledWith(
        "soc2",
        expect.objectContaining({
          signedByEmail: OWNER.email,
          documentSha256: "a".repeat(64),
        }),
      );
      expect(mocks.getProgram).toHaveBeenCalledWith("soc2", { fresh: true });
      expect(mocks.successToast).toHaveBeenCalledWith(
        "SOC 2 attestation recorded.",
      );
      expect(document.body.textContent).toContain("Record renewal");
    } finally {
      act(() => root.unmount());
    }
  });

  it("loads every bounded evidence page without discarding rows already shown", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: 200 - index,
      framework: "soc2" as const,
      eventType: "attested" as const,
      signedByEmail: OWNER.email,
      notes: index === 0 ? "Newest evidence" : undefined,
      at: `2026-08-29T09:${String(59 - (index % 60)).padStart(2, "0")}:00Z`,
    }));
    mocks.listEvents.mockImplementation(
      (_framework: string, options?: { cursor?: string }) =>
        Promise.resolve(
          options?.cursor
            ? {
                events: [
                  {
                    id: 99,
                    framework: "soc2",
                    eventType: "renewed",
                    signedByEmail: OWNER.email,
                    notes: "Older retained evidence",
                    at: "2026-08-28T10:00:00Z",
                  },
                ],
                hasMore: false,
                limit: 100,
                nextCursor: null,
              }
            : {
                events: firstPage,
                hasMore: true,
                limit: 100,
                nextCursor: "cursor_one",
              },
        ),
    );

    const root = render();
    try {
      await flush();
      await click(await waitForButton("SOC 2"));
      await flush();
      expect(document.body.textContent).toContain("Newest evidence");
      expect(document.body.textContent).toContain(
        "Older evidence is available",
      );

      await click(button("Load older evidence"));
      await flush();

      expect(mocks.listEvents).toHaveBeenLastCalledWith(
        "soc2",
        expect.objectContaining({ cursor: "cursor_one" }),
      );
      expect(document.body.textContent).toContain("Newest evidence");
      expect(document.body.textContent).toContain("Older retained evidence");
      expect(document.body.textContent).toContain(
        "All available evidence is shown",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("refuses a stale attestation without sending the mutation", async () => {
    const root = render();
    try {
      await flush();
      await click(await waitForButton("SOC 2"));
      await flush();
      await click(button("Attest"));
      current = {
        framework: "soc2",
        status: "revoked",
        signedByEmail: OWNER.email,
        attestedAt: "2026-08-29T10:00:00Z",
        updatedAt: REVISION,
      };
      await click(button("Review attestation"));
      await click(button("Record attestation"));
      await flush(8);

      expect(mocks.attest).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain(
        "changed after the form opened",
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it("requires typed framework confirmation and the exact loaded revision to revoke", async () => {
    current = attested();
    const root = render();
    try {
      await flush();
      await click(await waitForButton("SOC 2"));
      await flush();
      await click(button("Revoke"));
      await setInput("#compliance-revoke-reason", "Evidence expired");
      await click(button("Review revocation"));
      const confirm = button("Revoke SOC 2");
      expect(confirm.disabled).toBe(true);
      const token = document.querySelector<HTMLInputElement>(
        'input[placeholder="SOC 2"]',
      );
      if (!token) throw new Error("confirmation token input not found");
      await setElementValue(token, "SOC 2");
      expect(confirm.disabled).toBe(false);
      await click(confirm);
      await flush(10);

      expect(mocks.revoke).toHaveBeenCalledWith("soc2", {
        reason: "Evidence expired",
        expectedUpdatedAt: REVISION,
      });
      expect(mocks.successToast).toHaveBeenCalledWith(
        "SOC 2 attestation revoked.",
      );
      expect(document.body.textContent).toContain("Revoked");
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
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(CompliancePage),
      ),
    );
  });
  return root;
}

async function flush(turns = 6): Promise<void> {
  await act(async () => {
    for (let index = 0; index < turns; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
}

async function waitForButton(label: string): Promise<HTMLButtonElement> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return button(label);
    } catch (error) {
      lastError = error;
      await flush(1);
    }
  }
  throw lastError;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function setInput(selector: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    selector,
  );
  if (!input) throw new Error(`input not found: ${selector}`);
  await setElementValue(input, value);
}

async function setElementValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): Promise<void> {
  await act(async () => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
