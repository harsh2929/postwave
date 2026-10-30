// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/data-operations",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

async function flush(turns = 5) {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function press(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent ?? "").trim().startsWith(label),
  );
  if (!match) throw new Error(`No button starting with ${label}`);
  return match as HTMLButtonElement;
}

function field<T extends HTMLInputElement | HTMLTextAreaElement>(
  container: HTMLElement,
  selector: string,
): T {
  const match = container.querySelector<T>(selector);
  if (!match) throw new Error(`No field ${selector}`);
  return match;
}

async function requestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const raw =
    input instanceof Request
      ? await input.clone().text()
      : typeof init?.body === "string"
        ? init.body
        : "";
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function verificationBatchReceipt(emails: string[]) {
  return {
    results: emails.map((email) => ({
      email: email.toLowerCase(),
      status: "unknown",
    })),
    usage: {
      total: emails.length,
      cache_hits: 0,
      local_filtered: 0,
      vendor_verified: emails.length,
      credits_spent: emails.length,
      duplicates: 0,
      credits_saved: 0,
      savings_ratio: 0,
    },
  };
}

function verificationJobReceipt(total: number) {
  return {
    id: "018f47f2-9f25-7f73-8ec6-3fd483eb51dd",
    status: "pending",
    source: "inline",
    total,
  };
}

function stubOperationsTransport() {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const idempotencyKeys: string[] = [];
  const transport = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      const path = new URL(rawUrl, "http://postwave.test").pathname;
      const body = await requestBody(input, init);
      bodies.push({ path, body });
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      );
      const idempotencyKey = headers.get("Idempotency-Key");
      if (idempotencyKey) idempotencyKeys.push(idempotencyKey);

      let response: Record<string, unknown> = {};
      if (path === "/api/v1/utm-templates/preview") {
        const original = String(body.url ?? "");
        response = {
          original,
          rewritten: `${original}?utm_source=postwave`,
          template: { enabled: true, created_at: "2026-08-01T00:00:00Z" },
        };
      } else if (path === "/api/v1/inbound-routes/preview") {
        response = { matches: [], evaluated: 0, no_matches: true };
      } else if (path === "/api/v1/verification/verify-batch") {
        response = verificationBatchReceipt(
          Array.isArray(body.emails)
            ? body.emails.filter(
                (email): email is string => typeof email === "string",
              )
            : [],
        );
      } else if (path === "/api/v1/verification/jobs") {
        response = verificationJobReceipt(
          Array.isArray(body.emails) ? body.emails.length : 0,
        );
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", transport);
  return { transport, bodies, idempotencyKeys };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("data operations", () => {
  it("rejects invalid previews before making a request", async () => {
    const { transport } = stubOperationsTransport();
    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await setValue(field(container, "#do-url"), "ftp://example.test/file");
      await press(button(container, "Preview rewrite"));
      expect(container.textContent).toContain(
        "Enter a complete http:// or https:// URL",
      );

      await setValue(field(container, "#do-recipient"), "not-an-address");
      await press(button(container, "Preview match"));
      expect(container.textContent).toContain(
        "Enter a complete recipient email address",
      );

      await setValue(
        field<HTMLTextAreaElement>(container, "#do-emails"),
        "valid@example.com invalid-address",
      );
      await press(button(container, "Verify batch"));
      expect(container.textContent).toContain("1 address is incomplete");
      expect(transport).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("distinguishes a rewritten link from a vacuous route result", async () => {
    const { bodies } = stubOperationsTransport();
    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await press(button(container, "Preview rewrite"));
      await flush();
      expect(container.textContent).toContain(
        "https://example.com/pricing?utm_source=postwave",
      );

      await press(button(container, "Preview match"));
      await flush();
      expect(container.textContent).toContain(
        "No inbound routes exist, so nothing was evaluated",
      );

      await press(button(container, "Send test event"));
      await flush();
      expect(container.textContent).toContain(
        "Audit sink test for s3 accepted",
      );
      expect(bodies.map((request) => request.path)).toEqual([
        "/api/v1/utm-templates/preview",
        "/api/v1/inbound-routes/preview",
        "/api/v1/audit-sinks/test",
      ]);
    } finally {
      unmount(root);
    }
  });

  it("deduplicates a verification batch before the billable mutation", async () => {
    const { bodies, idempotencyKeys } = stubOperationsTransport();
    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await setValue(
        field<HTMLTextAreaElement>(container, "#do-emails"),
        "Alex@example.com, alex@example.com\nsam@example.com",
      );
      const verify = button(container, "Verify batch");
      expect(verify.disabled).toBe(false);
      await press(verify);
      await flush();

      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toEqual({
        path: "/api/v1/verification/verify-batch",
        body: { emails: ["Alex@example.com", "sam@example.com"] },
      });
      expect(idempotencyKeys).toHaveLength(1);
      expect(idempotencyKeys[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(container.textContent).toContain(
        "2 unique addresses accepted for synchronous verification; 1 duplicate was removed",
      );
      expect(verify.disabled).toBe(false);
    } finally {
      unmount(root);
    }
  });

  it("routes larger paid batches to one durable job with the caller-owned key", async () => {
    const { bodies, idempotencyKeys } = stubOperationsTransport();
    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const emails = Array.from(
        { length: 9 },
        (_, index) => `person-${index}@example.com`,
      );
      await setValue(field(container, "#do-emails"), emails.join("\n"));
      await press(button(container, "Verify batch"));
      await flush();

      expect(bodies).toEqual([
        {
          path: "/api/v1/verification/jobs",
          body: { source: "inline", emails },
        },
      ]);
      expect(idempotencyKeys).toHaveLength(1);
      expect(idempotencyKeys[0]).toBeTruthy();
      expect(container.textContent).toContain(
        "9 unique addresses accepted as a durable verification job",
      );
      expect(container.textContent).toContain("Current status: pending");
      expect(container.textContent).toContain(
        "Monitor it on Email verification",
      );
    } finally {
      unmount(root);
    }
  });

  it("reuses one verification key after an uncertain transport outcome", async () => {
    const keys: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const rawUrl =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        // The transport failure makes the online manager probe /api/health;
        // that probe is not a verification request and carries no key.
        if (new URL(rawUrl, "http://postwave.test").pathname === "/api/health") {
          return new Response(null, { status: 204 });
        }
        calls += 1;
        const headers = new Headers(
          input instanceof Request ? input.headers : init?.headers,
        );
        keys.push(headers.get("Idempotency-Key") ?? "");
        if (calls === 1) throw new TypeError("connection reset after upload");
        return new Response(
          JSON.stringify(
            verificationBatchReceipt(["a@example.com", "b@example.com"]),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await setValue(
        field<HTMLTextAreaElement>(container, "#do-emails"),
        "a@example.com\nb@example.com",
      );
      await press(button(container, "Verify batch"));
      await flush();
      expect(container.textContent).toContain("connection reset after upload");

      await press(button(container, "Verify batch"));
      await flush();
      expect(keys).toHaveLength(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);

      // A completed intent is not reusable for another paid execution.
      await press(button(container, "Verify batch"));
      await flush();
      expect(keys[2]).toBeTruthy();
      expect(keys[2]).not.toBe(keys[1]);
    } finally {
      unmount(root);
    }
  });

  it("retains the verification key after a malformed 2xx receipt", async () => {
    const keys: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        const headers = new Headers(
          input instanceof Request ? input.headers : init?.headers,
        );
        keys.push(headers.get("Idempotency-Key") ?? "");
        const response =
          calls === 1
            ? {}
            : verificationBatchReceipt(["a@example.com", "b@example.com"]);
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await setValue(
        field<HTMLTextAreaElement>(container, "#do-emails"),
        "a@example.com\nb@example.com",
      );
      await press(button(container, "Verify batch"));
      await flush();
      expect(container.textContent).toContain(
        "incomplete verification receipt",
      );
      expect(container.textContent).toContain(
        "Refresh Email verification before retrying",
      );

      await press(button(container, "Verify batch"));
      await flush();
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
      expect(container.textContent).toContain(
        "2 unique addresses accepted for synchronous verification",
      );
    } finally {
      unmount(root);
    }
  });

  it("retains the verification key after ambiguous usage accounting", async () => {
    const keys: string[] = [];
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        const headers = new Headers(
          input instanceof Request ? input.headers : init?.headers,
        );
        keys.push(headers.get("Idempotency-Key") ?? "");
        if (calls === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: "verification_usage_outcome_ambiguous",
                message:
                  "Verification completed, but its usage record could not be confirmed.",
              },
            }),
            { status: 409, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify(
            verificationBatchReceipt(["a@example.com", "b@example.com"]),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      await setValue(
        field<HTMLTextAreaElement>(container, "#do-emails"),
        "a@example.com\nb@example.com",
      );
      await press(button(container, "Verify batch"));
      await flush();
      expect(container.textContent).toContain(
        "usage record could not be confirmed",
      );

      await press(button(container, "Verify batch"));
      await flush();
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    } finally {
      unmount(root);
    }
  });

  it("contains legacy tag rename and merge before transport", async () => {
    const { transport } = stubOperationsTransport();
    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain(
        "Tag rename and merge are unavailable",
      );
      expect(button(container, "Rename unavailable").disabled).toBe(true);
      expect(button(container, "Merge unavailable").disabled).toBe(true);
      expect(container.querySelector("#do-from")).toBeNull();
      expect(container.querySelector("#do-to")).toBeNull();
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      const { mergeTag, renameTag } = await import(
        "@/lib/data-operations-api"
      );
      await expect(renameTag("legacy", "current")).rejects.toMatchObject({
        code: "tag_taxonomy_mutation_unavailable",
      });
      await expect(mergeTag("legacy", "current")).rejects.toMatchObject({
        code: "tag_taxonomy_mutation_unavailable",
      });
      expect(transport).not.toHaveBeenCalled();
    } finally {
      unmount(root);
    }
  });

  it("recovers its controls after a failed operation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "bad_request",
                message: "Preview service unavailable",
              },
            }),
            { status: 400, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const Page = (await import("@/app/(dashboard)/app/data-operations/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const preview = button(container, "Preview rewrite");
      await press(preview);
      await flush();
      expect(container.textContent).toContain("Preview service unavailable");
      expect(preview.disabled).toBe(false);
      expect(preview.textContent).toContain("Preview rewrite");
    } finally {
      unmount(root);
    }
  });
});
