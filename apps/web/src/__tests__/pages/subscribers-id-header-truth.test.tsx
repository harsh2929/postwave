// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The subscriber profile header said "Subscribed <date>" for every contact,
// including one whose double opt-in was never confirmed — contradicting the
// unconfirmed badge beside it and the email health below, and telling the
// operator an address had opted in when nobody had. The date is the profile's
// creation time, which for such a contact is only when they were added.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

const ID = "11111111-2222-3333-4444-555555555555";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/subscribers/[id]",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: ID }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

/** Serves this contact's timeline as the API shapes it; everything else 404s. */
function serveTimeline(currentStatus: string): void {
  const timeline = {
    subscriber_id: ID,
    email: "ada@example.com",
    stats: {
      sent_count: 0,
      opened_count: 0,
      clicked_count: 0,
      bounced_count: 0,
      replied_count: 0,
      open_rate: 0,
      click_rate: 0,
      engagement_score: 0,
      engagement_daily_30d: Array.from({ length: 30 }, () => 0),
      subscribed_at: "2026-09-01T10:00:00Z",
      current_status: currentStatus,
    },
    events: [],
    pagination: { limit: 50, has_more: false },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const body = url.includes(`/subscribers/${ID}/timeline`)
        ? timeline
        : null;
      if (!body) {
        return new Response(
          JSON.stringify({ error: { code: "not_found", message: "" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

async function headerLine(status: string): Promise<string> {
  serveTimeline(status);
  const Page = (await import("@/app/(dashboard)/app/subscribers/[id]/page"))
    .default;
  const { container, root } = await renderPage(Page, {
    params: Promise.resolve({ id: ID }),
  });
  try {
    const badge = container.querySelector('[data-testid="subscriber-status"]');
    const line = badge?.parentElement;
    if (!line) throw new Error("the profile header did not render its status");
    return line.textContent ?? "";
  } finally {
    unmount(root);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the subscriber profile header's date", () => {
  it("does not call an unconfirmed contact subscribed", async () => {
    const line = await headerLine("unconfirmed");
    expect(line).toContain("unconfirmed");
    expect(line).toContain("Added");
    expect(line).not.toContain("Subscribed");
  });

  it("still dates a subscription for a contact who has one", async () => {
    const line = await headerLine("enabled");
    expect(line).toContain("Subscribed");
    expect(line).not.toContain("Added");
  });
});
