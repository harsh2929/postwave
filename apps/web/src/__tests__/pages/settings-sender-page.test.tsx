// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Smoke render for /settings/sender.
//
// This page had zero coverage: nothing imported its module, so a crash on
// mount was invisible. Responses come from recorded fixtures; unrecorded
// endpoints answer 404, which every page has a branch for.
import { act } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { qk } from "@/lib/query-keys";

import {
  clickEveryControl,
  expectMounted,
  renderPage,
  stubFixtureTransport,
  unmount,
  WHOAMI,
} from "./_harness";
import { importBeforeTests, waitFor } from "./_wait";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/settings/sender",
  useSearchParams: () => new URLSearchParams(),
  // Dynamic routes read their id from here; a plausible uuid keeps downstream
  // validation happy without pretending the record exists.
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

vi.mock("@/lib/admin-mutation-authority", () => ({
  verifyFreshAdminAuthority: vi.fn().mockResolvedValue(WHOAMI),
}));

// The page module these tests import is cold work for vitest's transform
// pipeline; pay it before any test's 5 s clock starts.
importBeforeTests(
  () => import("@/app/(dashboard)/app/settings/sender/page"),
);

beforeEach(() => {
  stubFixtureTransport();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings/sender page", () => {
  it("mounts without crashing", async () => {
    const Page = (await import("@/app/(dashboard)/app/settings/sender/page"))
      .default;
    const { text, container, root } = await renderPage(Page);
    try {
      expectMounted(text);
      // This fixture intentionally has no sender endpoints. A failed GET must
      // never become an editable blank full-replace form: doing so can erase a
      // real compliance profile or sending policy when Save is pressed.
      expect(text).toContain("Existing sender values remain protected");
      expect(text).toContain("unknown values cannot be overwritten");
      expect(container.querySelector("#legal-sender-name")).toBeNull();
      expect(container.querySelector("#cap")).toBeNull();
      expect(
        Array.from(container.querySelectorAll("button")).some((button) =>
          button.textContent?.includes("Retry sender settings"),
        ),
      ).toBe(true);
      // Then press everything. The transport is stubbed, so this asserts
      // no handler explodes — not that it does the right thing.
      const { failures } = await clickEveryControl(container);
      expect(failures).toEqual([]);
    } finally {
      unmount(root);
    }
  });

  it("drops drafts, dialogs, and retained data when the exact principal changes", async () => {
    const tenantA = WHOAMI.tenant_id;
    const tenantB = "33333333-3333-4333-8333-333333333333";
    let activeTenant = tenantA;
    const profile = {
      tenant_id: tenantA,
      legal_sender_name: "Verified workspace sender",
      physical_address_line1: "1 Market Street",
      physical_address_line2: "",
      physical_address_city: "San Francisco",
      physical_address_region: "CA",
      physical_address_postal_code: "94105",
      physical_address_country: "US",
      compliance_contact_email: "compliance@example.test",
      default_footer_text: "You subscribed to these updates.",
      list_unsubscribe_enabled: true,
      one_click_unsubscribe_enabled: true,
      verified_sender_domain: true,
    };
    const control = { tenant_id: tenantA, paused: false, source: "tenant" };
    const readiness = {
      ready: true,
      items: [],
      controls: control,
      compliance: {
        exists: true,
        complete: true,
        verified_sender_domain: true,
        list_unsubscribe_enabled: true,
        one_click_unsubscribe_enabled: true,
        legal_sender_name: profile.legal_sender_name,
        compliance_contact_email: profile.compliance_contact_email,
        missing_physical_address: false,
        missing_compliance_email: false,
        missing_legal_sender_name: false,
      },
      settings: {
        exists: true,
        max_sends_per_hour: 500,
        quiet_hours_enabled: false,
      },
      warmup_started: true,
      sending_provisioned: true,
    };
    const sendingSettings = {
      tenant_id: tenantA,
      max_sends_per_hour: 500,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      updated_at: "2026-09-03T10:00:00Z",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input)
          .replace(/^https?:\/\/[^/]+/, "")
          .split("?")[0];
        if (activeTenant === tenantB) {
          return new Response(
            JSON.stringify({ error: { message: "new tenant unavailable" } }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            },
          );
        }
        const body =
          path === "/api/v1/settings/email-compliance"
            ? profile
            : path === "/api/v1/sending/controls"
              ? control
              : path === "/api/v1/sending/readiness"
                ? readiness
                : path === "/api/v1/settings/sending"
                  ? sendingSettings
                  : path === "/api/v1/auth-checks"
                    ? []
                    : { error: { message: "not found" } };
        const status = "error" in body ? 404 : 200;
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const Page = (await import("@/app/(dashboard)/app/settings/sender/page"))
      .default;
    let client: QueryClient | null = null;
    function CapturedPage() {
      client = useQueryClient();
      return <Page />;
    }
    const { container, root } = await renderPage(CapturedPage);
    const setValue = async (
      element: HTMLInputElement | HTMLTextAreaElement,
      value: string,
    ) => {
      const prototype =
        element.tagName === "TEXTAREA"
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) throw new Error("native value setter unavailable");
      await act(async () => {
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    try {
      const legalName =
        container.querySelector<HTMLInputElement>("#legal-sender-name");
      const cap = container.querySelector<HTMLInputElement>("#cap");
      expect(legalName?.value).toBe(profile.legal_sender_name);
      expect(cap?.value).toBe("500");
      await setValue(legalName!, "Admin A unsaved sender");
      await setValue(cap!, "900");

      const pauseButton = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Pause sends",
      );
      await act(async () => pauseButton?.click());
      const pauseReason =
        document.body.querySelector<HTMLTextAreaElement>("#pause-reason");
      expect(pauseReason).not.toBeNull();
      await setValue(pauseReason!, "Admin A private draft reason");

      // Held role is part of the exact principal even when the server keeps
      // effective authority unchanged. A downgrade/upgrade cannot inherit a
      // form or destructive-dialog draft opened under the earlier grant.
      await act(async () => {
        client!.setQueryData(qk.authMe(), {
          ...WHOAMI,
          role: "admin",
          effective_role: "owner",
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => {
        expect(
          container.querySelector<HTMLInputElement>("#legal-sender-name")
            ?.value,
        ).toBe(profile.legal_sender_name);
        expect(document.body.querySelector("#pause-reason")).toBeNull();
      });
      expect(container.textContent).not.toContain("Admin A unsaved sender");
      expect(document.body.textContent).not.toContain(
        "Admin A private draft reason",
      );

      const sameTenantUserB = {
        ...WHOAMI,
        user_id: "44444444-4444-4444-8444-444444444444",
        email: "admin-b@postwave.test",
      };
      await act(async () => {
        client!.setQueryData(qk.authMe(), sameTenantUserB);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => {
        expect(
          container.querySelector<HTMLInputElement>("#legal-sender-name")
            ?.value,
        ).toBe(profile.legal_sender_name);
        expect(container.querySelector<HTMLInputElement>("#cap")?.value).toBe(
          "500",
        );
        expect(document.body.querySelector("#pause-reason")).toBeNull();
      });
      expect(container.textContent).not.toContain("Admin A unsaved sender");
      expect(document.body.textContent).not.toContain(
        "Admin A private draft reason",
      );

      activeTenant = tenantB;
      await act(async () => {
        client!.setQueryData(qk.authMe(), {
          ...sameTenantUserB,
          tenant_id: tenantB,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await waitFor(() => {
        expect(container.textContent).toContain(
          "Existing sender values remain protected",
        );
        expect(container.querySelector("#legal-sender-name")).toBeNull();
        expect(container.querySelector("#cap")).toBeNull();
      });
      expect(container.textContent).not.toContain(profile.legal_sender_name);
    } finally {
      unmount(root);
    }
  });

  it("retains committed R2 read-only when its follow-up refresh fails", async () => {
    const tenantId = WHOAMI.tenant_id;
    const profile = {
      tenant_id: tenantId,
      legal_sender_name: "Verified workspace sender",
      physical_address_line1: "1 Market Street",
      physical_address_line2: "",
      physical_address_city: "San Francisco",
      physical_address_region: "CA",
      physical_address_postal_code: "94105",
      physical_address_country: "US",
      compliance_contact_email: "compliance@example.test",
      default_footer_text: "You subscribed to these updates.",
      list_unsubscribe_enabled: true,
      one_click_unsubscribe_enabled: true,
      verified_sender_domain: true,
    };
    const control = { tenant_id: tenantId, paused: false, source: "tenant" };
    const readiness = {
      ready: true,
      items: [],
      controls: control,
      compliance: {
        exists: true,
        complete: true,
        verified_sender_domain: true,
        list_unsubscribe_enabled: true,
        one_click_unsubscribe_enabled: true,
        legal_sender_name: profile.legal_sender_name,
        compliance_contact_email: profile.compliance_contact_email,
        missing_physical_address: false,
        missing_compliance_email: false,
        missing_legal_sender_name: false,
      },
      settings: {
        exists: true,
        max_sends_per_hour: 500,
        quiet_hours_enabled: false,
      },
      warmup_started: true,
      sending_provisioned: true,
    };
    const r1 = {
      tenant_id: tenantId,
      max_sends_per_hour: 500,
      quiet_hours_start: "",
      quiet_hours_end: "",
      quiet_hours_tz: "",
      quiet_hours_per_recipient: true,
      updated_at: "2026-09-03T10:00:00Z",
    };
    const r2 = {
      ...r1,
      max_sends_per_hour: 900,
      updated_at: "2026-09-03T10:01:00Z",
    };
    let rejectSettingsReads = false;
    let putCount = 0;
    let settingsGetCount = 0;
    let putHadIdempotencyHeader = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
          .replace(/^https?:\/\/[^/]+/, "")
          .split("?")[0];
        const method = (init?.method ?? "GET").toUpperCase();
        if (path === "/api/v1/settings/sending" && method === "PUT") {
          putCount += 1;
          const requestHeaders = init?.headers;
          putHadIdempotencyHeader =
            requestHeaders instanceof Headers
              ? requestHeaders.has("Idempotency-Key")
              : Array.isArray(requestHeaders)
                ? requestHeaders.some(
                    ([name]) => name.toLowerCase() === "idempotency-key",
                  )
                : Object.keys(requestHeaders ?? {}).some(
                    (name) => name.toLowerCase() === "idempotency-key",
                  );
          rejectSettingsReads = true;
          return new Response(JSON.stringify(r2), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-postwave-sending-cap-outcome": "committed",
            },
          });
        }
        if (
          path === "/api/v1/settings/sending" &&
          method === "GET" &&
          rejectSettingsReads
        ) {
          settingsGetCount += 1;
          return new Response(
            JSON.stringify({ error: { message: "refresh unavailable" } }),
            {
              status: 503,
              // GETs intentionally retry 503 responses with randomized
              // backoff. Keep the retry contract in this test while making
              // its completion independent of scheduler/worker load.
              headers: {
                "content-type": "application/json",
                "retry-after": "0",
              },
            },
          );
        }
        if (path === "/api/v1/settings/sending" && method === "GET") {
          settingsGetCount += 1;
        }
        const body =
          path === "/api/v1/settings/email-compliance"
            ? profile
            : path === "/api/v1/sending/controls"
              ? control
              : path === "/api/v1/sending/readiness"
                ? readiness
                : path === "/api/v1/settings/sending"
                  ? r1
                  : path === "/api/v1/auth-checks"
                    ? []
                    : { error: { message: "not found" } };
        const status = "error" in body ? 404 : 200;
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const Page = (await import("@/app/(dashboard)/app/settings/sender/page"))
      .default;
    let client: QueryClient | null = null;
    function CapturedPage() {
      client = useQueryClient();
      return <Page />;
    }
    const { container, root } = await renderPage(CapturedPage);
    const senderSettingsScope = qk.settings(
      tenantId,
      WHOAMI.effective_role,
      "sender",
    );
    const senderSettingsQueryState = () =>
      client!.getQueryCache().find({
        queryKey: senderSettingsScope,
        exact: false,
      })?.state;
    const cap = container.querySelector<HTMLInputElement>("#cap");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!cap || !setter) throw new Error("sending cap input unavailable");
    try {
      await act(async () => {
        setter.call(cap, "900");
        cap.dispatchEvent(new Event("input", { bubbles: true }));
        cap.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const save = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === "Save sending limits",
      );
      await act(async () => {
        save?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      // The follow-up refresh retries its 503s before it settles as failed.
      await waitFor(() => {
        const queryState = senderSettingsQueryState();
        expect(queryState?.fetchStatus).toBe("idle");
        expect(queryState?.error).not.toBeNull();
        expect(container.textContent).toContain(
          "Showing the last verified sender settings",
        );
      });

      expect(putCount).toBe(1);
      expect(settingsGetCount).toBeGreaterThan(1);
      expect(putHadIdempotencyHeader).toBe(false);
      const failedRefresh = senderSettingsQueryState();
      expect(failedRefresh?.fetchStatus).toBe("idle");
      expect(failedRefresh?.error).toBeInstanceOf(Error);
      expect(container.textContent).toContain(
        "Showing the last verified sender settings",
      );
      expect(container.querySelector<HTMLInputElement>("#cap")?.value).toBe(
        "900",
      );
      expect(container.querySelector<HTMLInputElement>("#cap")?.disabled).toBe(
        true,
      );
    } finally {
      unmount(root);
    }
  });
});
