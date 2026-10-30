// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The archive custom-domain verbs under the REAL (unmocked) custom-domain
// release policy — the state production ships while
// CUSTOM_DOMAIN_{REGISTRATION,VERIFICATION,REMOVAL}_AVAILABLE are false.
// Each held control must stay visible, disabled, and described by the policy's
// own sentence, and no held verb may reach the network from the UI or from the
// transport. Copying the DNS record is a read and is never held.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ArchiveDomainSection } from "@/app/(dashboard)/app/archive-settings/archive-domain-section";
import {
  removeArchiveDomainVerification,
  saveArchiveDomain,
} from "@/lib/archive-admin-api";
import type { MeResponse } from "@/lib/auth-api";
import {
  CUSTOM_DOMAIN_REGISTRATION_AVAILABLE,
  CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE,
  CUSTOM_DOMAIN_REMOVAL_AVAILABLE,
  CUSTOM_DOMAIN_VERIFICATION_AVAILABLE,
} from "@/lib/custom-domain-operational-availability";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

const me: MeResponse = {
  user_id: "archive-owner",
  tenant_id: "00000000-0000-4000-8000-000000000001",
  email: "owner@example.test",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
  auth_provider: "password",
  email_verified: true,
  workspace_name: "Archive workspace",
  workspace_slug: "archive-workspace",
};

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

async function eventually(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function nonGetCalls(): unknown[][] {
  return (fetchMock.mock.calls as unknown[][]).filter(
    ([, init]) => ((init as RequestInit | undefined)?.method ?? "GET") !== "GET",
  );
}

beforeEach(() => {
  fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          domain: "news.example.test",
          cname_target: "custom-domains.moosewave.com",
          verification_token: "",
          status: "pending",
          last_checked_at: "",
          verified_at: "",
          last_error: "",
          ssl_status: "pending",
          ssl_last_error: "",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("ArchiveDomainSection under the shipped release policy", () => {
  it("is the policy this file pins", () => {
    expect(CUSTOM_DOMAIN_REGISTRATION_AVAILABLE).toBe(false);
    expect(CUSTOM_DOMAIN_VERIFICATION_AVAILABLE).toBe(false);
    expect(CUSTOM_DOMAIN_REMOVAL_AVAILABLE).toBe(false);
  });

  it("renders held verbs disabled with the policy sentence and sends nothing", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, networkMode: "always" } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ArchiveDomainSection me={me} queryBase={["archive-admin", "t"]} />
        </QueryClientProvider>,
      );
    });
    await eventually(() =>
      expect(container.textContent).toContain("custom-domains.moosewave.com"),
    );

    const note = container.querySelector('[role="note"]');
    expect(note?.textContent).toContain(CUSTOM_DOMAIN_RELEASE_HOLD_MESSAGE);
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    for (const label of ["Save domain", "Verify DNS", "Remove verification"]) {
      const control = button(label);
      expect(control, label).toBeDefined();
      expect(control!.disabled, label).toBe(true);
      expect(control!.getAttribute("aria-describedby"), label).toBe(note!.id);
      await act(async () => control!.click());
    }
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button("Copy host")?.disabled).toBe(false);
    expect(nonGetCalls()).toEqual([]);
  });

  it("refuses held writes in the transport before any request", async () => {
    await expect(
      saveArchiveDomain({ previous: "", next: "news.example.test" }),
    ).rejects.toMatchObject({
      code: "custom_domain_registration_unavailable",
      status: 503,
    });
    await expect(
      saveArchiveDomain({ previous: "news.example.test", next: "" }),
    ).rejects.toMatchObject({
      code: "custom_domain_removal_unavailable",
      status: 503,
    });
    await expect(removeArchiveDomainVerification()).rejects.toMatchObject({
      code: "custom_domain_removal_unavailable",
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
