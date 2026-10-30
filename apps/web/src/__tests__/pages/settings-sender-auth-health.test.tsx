// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// /settings/sender read authentication health — the deliverability service's
// live DNS read — in the same Promise.all as the page's own records. Every
// card therefore waited for the slowest, optional call and all its retries,
// and on an environment without that service the page sat on "Loading" until
// the transport gave up. Authentication health now has its own query and
// its own states, inside its own card.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectMounted, renderPage, unmount, WHOAMI } from "./_harness";
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

importBeforeTests(() => import("@/app/(dashboard)/app/settings/sender/page"));

const tenant = WHOAMI.tenant_id;
const profile = {
  tenant_id: tenant,
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
const control = { tenant_id: tenant, paused: false, source: "tenant" };
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
  tenant_id: tenant,
  max_sends_per_hour: 500,
  quiet_hours_start: "",
  quiet_hours_end: "",
  quiet_hours_tz: "",
  quiet_hours_per_recipient: true,
  updated_at: "2026-09-03T10:00:00Z",
};

const AUTH_CHECKS = "/api/v1/auth-checks";

/** Serves the page's records; `authChecks` answers the deliverability read. */
function stubTransport(
  authChecks: (signal?: AbortSignal | null) => Promise<Response>,
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
        .replace(/^https?:\/\/[^/]+/, "")
        .split("?")[0];
      calls.push(path);
      if (path === AUTH_CHECKS) return authChecks(init?.signal);
      const body =
        path === "/api/v1/settings/email-compliance"
          ? profile
          : path === "/api/v1/sending/controls"
            ? control
            : path === "/api/v1/sending/readiness"
              ? readiness
              : path === "/api/v1/settings/sending"
                ? sendingSettings
                : { error: { message: "not found" } };
      return new Response(JSON.stringify(body), {
        status: "error" in body ? 404 : 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

function authCard(container: HTMLElement): HTMLElement {
  const card = container.querySelector<HTMLElement>("#auth-health");
  if (!card) throw new Error("authentication health card not rendered");
  return card;
}

function buttons(root: ParentNode): string[] {
  return Array.from(root.querySelectorAll("button")).map(
    (button) => button.textContent?.trim() ?? "",
  );
}

async function renderSenderPage() {
  const Page = (await import("@/app/(dashboard)/app/settings/sender/page"))
    .default;
  return renderPage(Page);
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("settings/sender authentication health", () => {
  it("renders the sender cards while authentication health is still loading", async () => {
    stubTransport(
      (signal) =>
        new Promise<Response>((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { text, container, root } = await renderSenderPage();
    try {
      expectMounted(text);
      // Compliance, limits and the kill switch come from their own reads.
      await waitFor(() => {
        expect(
          container.querySelector<HTMLInputElement>("#legal-sender-name")
            ?.value,
        ).toBe(profile.legal_sender_name);
        expect(container.querySelector<HTMLInputElement>("#cap")?.value).toBe(
          "500",
        );
        expect(buttons(container)).toContain("Pause sends");
      });
      // Only the authentication-health card is still waiting.
      expect(authCard(container).textContent).toContain(
        "Loading auth checks...",
      );
      expect(authCard(container).getAttribute("aria-busy")).toBe("true");
    } finally {
      unmount(root);
    }
  });

  it("says authentication checks are not available where the deliverability service is not deployed", async () => {
    const calls = stubTransport(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "service_not_deployed",
              message: "This feature isn't available in this environment.",
              retryable: false,
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    const { container, root } = await renderSenderPage();
    try {
      await waitFor(() => {
        expect(authCard(container).textContent).toContain(
          "Authentication checks aren't available in this environment",
        );
      });
      const card = authCard(container);
      // A state of the environment, not a failure: no alert, nothing to retry.
      expect(card.querySelector('[role="alert"]')).toBeNull();
      expect(buttons(card)).not.toContain("Retry authentication checks");
      expect(card.textContent).not.toContain("Could not load");
      // Asked once: neither the transport nor the query re-sent it.
      expect(calls.filter((path) => path === AUTH_CHECKS)).toHaveLength(1);
      // And the rest of the page is unaffected.
      expect(
        container.querySelector<HTMLInputElement>("#legal-sender-name")?.value,
      ).toBe(profile.legal_sender_name);
    } finally {
      unmount(root);
    }
  });

  it("shows missing sending setup without a session error or pointless retry", async () => {
    stubTransport(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "sending_domain_not_configured",
              message: "Set up a sending domain",
            },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    const { container, root } = await renderSenderPage();
    try {
      await waitFor(() => {
        expect(authCard(container).textContent).toContain(
          "Add and verify a domain",
        );
      });
      expect(authCard(container).querySelector('[role="alert"]')).toBeNull();
      expect(buttons(authCard(container))).not.toContain(
        "Retry authentication checks",
      );
    } finally {
      unmount(root);
    }
  });

  it("keeps a failed authentication read inside its card, with its own retry", async () => {
    let answer: "fail" | "ok" = "fail";
    const calls = stubTransport(async () =>
      answer === "fail"
        ? new Response(
            JSON.stringify({
              error: {
                code: "not_found",
                message: "Sending domain lookup failed.",
              },
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          )
        : new Response(
            JSON.stringify([
              {
                domain: "mail.example.test",
                spf: {
                  status: "pass",
                  detail: "v=spf1 include:mail.example.test -all",
                },
                dkim: { status: "pass", detail: "selector pw1" },
                dmarc: { status: "pass", detail: "p=quarantine" },
                checked_at: "2026-09-15T10:00:00Z",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
    );
    const { container, root } = await renderSenderPage();
    try {
      await waitFor(() => {
        expect(
          authCard(container).querySelector('[role="alert"]')?.textContent,
        ).toContain("Sending domain lookup failed.");
      });
      // The page's own records still rendered, and the page reports no error.
      expect(
        container.querySelector<HTMLInputElement>("#legal-sender-name")?.value,
      ).toBe(profile.legal_sender_name);
      expect(buttons(container)).not.toContain("Retry sender settings");

      const before = calls.length;
      answer = "ok";
      const retry = Array.from(
        authCard(container).querySelectorAll("button"),
      ).find(
        (button) =>
          button.textContent?.trim() === "Retry authentication checks",
      );
      expect(retry).toBeDefined();
      await act(async () => retry?.click());
      await waitFor(() => {
        expect(authCard(container).textContent).toContain("mail.example.test");
      });
      // The retry asked for authentication health alone.
      expect(calls.slice(before)).toEqual([AUTH_CHECKS]);
    } finally {
      unmount(root);
    }
  });

  it("re-reads authentication health after the sender profile is saved", async () => {
    const calls = stubTransport(
      async () =>
        new Response(
          JSON.stringify([
            {
              domain: "mail.example.test",
              spf: {
                status: "pass",
                detail: "v=spf1 include:mail.example.test -all",
              },
              dkim: { status: "pass", detail: "selector pw1" },
              dmarc: { status: "pass", detail: "p=quarantine" },
              checked_at: "2026-09-15T10:00:00Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const { container, root } = await renderSenderPage();
    try {
      await waitFor(() => {
        expect(authCard(container).textContent).toContain("mail.example.test");
      });
      const legalName =
        container.querySelector<HTMLInputElement>("#legal-sender-name");
      expect(legalName?.value).toBe(profile.legal_sender_name);
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      await act(async () => {
        setter?.call(legalName, "Renamed workspace sender");
        legalName?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const readsBefore = calls.filter((path) => path === AUTH_CHECKS).length;
      const save = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "Save compliance profile",
      );
      expect(save?.disabled).toBe(false);
      await act(async () => save?.click());
      // The saved sender names the domains authentication health checks, so
      // the card asks again instead of showing the previous identity's result.
      await waitFor(() => {
        expect(calls.filter((path) => path === AUTH_CHECKS).length).toBe(
          readsBefore + 1,
        );
      });
      expect(calls).toContain("/api/v1/settings/email-compliance");
    } finally {
      unmount(root);
    }
  });
});
