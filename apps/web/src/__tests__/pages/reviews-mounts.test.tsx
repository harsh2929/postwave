// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Mount reachability for /app/reviews:
//   commerce-45 — the review-widget authoring form renders inside the
//     "Review widgets" surface, fed by the catalog's widget_types and the
//     page's own admin authority, under the REAL release policy: every
//     control disabled, described by the policy's sentence, and no
//     POST /api/v1/reviews/widgets leaves the page.
import { afterEach, describe, expect, it, vi } from "vitest";

import { REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON } from "@/lib/reviews-operational-availability";
import { renderPage, unmount } from "./_harness";
import { buttonByText, recordingTransport, settle } from "./_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/reviews",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => {
  const { WHOAMI: me } = await import("./_harness");
  return {
    ...(await importOriginal<typeof import("@/lib/auth-api")>()),
    whoami: vi.fn().mockResolvedValue(me),
    whoamiFresh: vi.fn().mockResolvedValue(me),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const CATALOG = {
  statuses: ["pending", "approved", "rejected"],
  // Deliberately NOT the client's default list, so the select proves it was
  // fed by the page from the catalog read rather than by its own fallback.
  widget_types: ["star_rating", "summary"],
  authenticity: ["verified_buyer"],
  request_channels: ["email"],
  public_contract: "Public widgets expose approved reviews only.",
  schema_version: "klv11.reviews.v1",
};

async function mount() {
  const transport = recordingTransport((req) => {
    if (req.method !== "GET") return undefined;
    if (req.path === "/api/v1/reviews/catalog") return { body: CATALOG };
    if (req.path === "/api/v1/reviews/widgets") return { body: { items: [] } };
    if (req.path === "/api/v1/reviews") return { body: { items: [] } };
    return undefined;
  });
  const Page = (await import("@/app/(dashboard)/app/reviews/page")).default;
  const rendered = await renderPage(Page);
  await settle(6);
  return { ...transport, ...rendered };
}

describe("reviews page mounts", () => {
  it("renders the held widget-authoring form fed by the catalog's widget types (commerce-45)", async () => {
    const { calls, container, root } = await mount();
    try {
      // The form is a next/dynamic chunk; give it a bounded moment to mount.
      const deadline = Date.now() + 10_000;
      while (
        !container.textContent?.includes("Create review widget") &&
        Date.now() < deadline
      ) {
        await settle(1);
      }
      expect(container.textContent).toContain("Create review widget");

      // Held exactly as desktop holds it: the control is disabled and the
      // reason it points at is the policy's own sentence.
      const submit = buttonByText(container, "Create widget");
      expect(submit).toBeDefined();
      expect(submit!.disabled).toBe(true);
      const describedBy = submit!.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const note = container.querySelector(`[id="${describedBy}"]`);
      expect(note?.textContent).toContain(
        REVIEW_WIDGET_AUTHORING_UNAVAILABLE_REASON,
      );
      // The harness identity is an owner, so the notice speaks to an admin.
      expect(note?.textContent).toContain("An administrator can monitor");

      // The renderer select was fed by the page from the catalog read.
      const typeSelect = [...container.querySelectorAll("select")].find(
        (select) => select.disabled && select.options.length === 2,
      );
      expect(typeSelect).toBeDefined();
      expect([...typeSelect!.options].map((o) => o.value)).toEqual([
        "star_rating",
        "summary",
      ]);

      // Nothing left the page but reads.
      expect(
        calls.some((c) => c.method === "GET" && c.path === "/api/v1/reviews/catalog"),
      ).toBe(true);
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
      expect(calls.some((c) => c.path === "/api/v1/reviews/widgets" && c.method === "POST")).toBe(false);
    } finally {
      unmount(root);
    }
  });
});
