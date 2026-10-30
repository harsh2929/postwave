// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// The send review's Audience line. It read "Selected segment" for every
// segment (the name was only reachable through a send-preview hook nothing
// wired) and "Entire eligible audience" for a list — any kind but a segment
// fell through to the whole-workspace phrase — beside a checklist that said a
// list was selected. It now names the list or segment, falls back to a phrase
// for the right kind, and never shows an id.
//
// The real dialog, mounted through the shared page harness; send-preview is
// answered with the shapes the API returns.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, stubFixtureTransport, unmount, WHOAMI } from "./_harness";
import { importBeforeTests, waitFor } from "./_wait";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/campaigns/c1",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: "c1" }),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
  whoamiFresh: vi.fn().mockResolvedValue(WHOAMI),
}));

importBeforeTests(
  () => import("@/app/(dashboard)/app/campaigns/campaign-send-dialogs"),
);

const CAMPAIGN_ID = "c1a2b3c4-0000-4000-8000-000000000002";

function servePreview(preview: Record<string, unknown>): void {
  stubFixtureTransport();
  const fixtures = globalThis.fetch as typeof fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (
        new URL(url, "http://postwave.test").pathname.endsWith("/send-preview")
      ) {
        return new Response(
          JSON.stringify({
            campaign_id: CAMPAIGN_ID,
            recipients: 3,
            suppressed_excluded: 0,
            deliverable: 3,
            tier_cap_today: -1,
            tier_cap_remaining: -1,
            tier_cap_remaining_after: -1,
            over_cap: false,
            counted_at: "2026-09-15T10:00:00Z",
            ...preview,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return fixtures(input, init);
    }),
  );
}

async function audienceLine(): Promise<string> {
  const { CampaignSendDialog } =
    await import("@/app/(dashboard)/app/campaigns/campaign-send-dialogs");
  const { root } = await renderPage(CampaignSendDialog, {
    campaign: {
      id: CAMPAIGN_ID,
      tenant_id: WHOAMI.tenant_id,
      name: "Launch",
      subject: "Hello",
      status: "draft",
      created_at: "2026-09-15T10:00:00Z",
      updated_at: "2026-09-15T10:00:00Z",
    },
    tenantId: WHOAMI.tenant_id,
    role: "owner",
    onConfirm: vi.fn(),
    onOpenChange: vi.fn(),
    open: true,
    sending: false,
  });
  let value = "";
  try {
    await waitFor(() => {
      const term = [...document.querySelectorAll("dt")].find(
        (dt) => dt.textContent === "Audience",
      );
      value = term?.nextElementSibling?.textContent ?? "";
      expect(value).not.toBe("Checking…");
      expect(value).not.toBe("");
    });
  } finally {
    unmount(root);
  }
  return value;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("send review audience", () => {
  it("names the list the campaign sends to", async () => {
    servePreview({ audience_kind: "list", audience_label: "Newsletter" });
    expect(await audienceLine()).toBe("Newsletter");
  });

  it("says a list is selected, not the whole workspace, when the name is unavailable", async () => {
    servePreview({ audience_kind: "list" });
    const line = await audienceLine();
    expect(line).toBe("Selected list");
    expect(line).not.toMatch(/entire|everyone/i);
  });

  it("names a segment from audience_label or an older server's segment_label", async () => {
    servePreview({
      audience_kind: "segment",
      audience_label: "Spring VIPs",
      segment_label: "Spring VIPs",
    });
    expect(await audienceLine()).toBe("Spring VIPs");
    vi.unstubAllGlobals();
    servePreview({ audience_kind: "segment", segment_label: "Spring VIPs" });
    expect(await audienceLine()).toBe("Spring VIPs");
  });

  it("marks a frozen snapshot", async () => {
    servePreview({
      audience_kind: "segment",
      audience_label: "Spring VIPs",
      audience_frozen: true,
    });
    expect(await audienceLine()).toBe("Spring VIPs (frozen snapshot)");
  });

  it("describes a whole-workspace send as everyone eligible", async () => {
    servePreview({ audience_kind: "workspace" });
    expect(await audienceLine()).toBe("Everyone eligible in this workspace");
  });
});
