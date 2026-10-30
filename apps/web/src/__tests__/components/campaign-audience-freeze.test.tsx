// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// Parity row campaigns-26 — freeze the campaign's audience.
//
// Freezing is PERMANENT for the campaign: the gateway mounts no unfreeze, so
// what is asserted here is that the request only goes out behind a confirm
// that states that, that it is withheld (with the reason) when the server
// would refuse it anyway, and that a server refusal is shown in the server's
// own words.
import { act, createElement } from "react";
import type { ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  whoami: vi.fn(),
  whoamiFresh: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "33333333-3333-4333-8333-333333333333" }),
}));
vi.mock("@/lib/api", () => ({
  api: { post: mocks.post },
  apiErrorMessage: (error: unknown, fallback = "Something went wrong") =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("@/lib/auth-api", () => ({
  whoami: mocks.whoami,
  whoamiFresh: mocks.whoamiFresh,
  effectiveAuthRole: (me: { effective_role?: string; role: string }) =>
    me.effective_role ?? me.role,
}));
vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

import { CampaignAudienceSection } from "@/app/(dashboard)/app/campaigns/[id]/campaign-audience-section";
import type { Segment } from "@/lib/segments-api";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CAMPAIGN = "33333333-3333-4333-8333-333333333333";
const FREEZE_PATH = `/api/v1/campaigns/${CAMPAIGN}/audience/freeze`;
const OWNER = {
  user_id: "11111111-1111-4111-8111-111111111111",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  role: "owner",
  effective_role: "owner",
  viewer_mode: false,
};
const VIEWER = { ...OWNER, role: "viewer", effective_role: "viewer" };

const SEGMENT: Segment = {
  id: "segment-1",
  tenantId: OWNER.tenant_id,
  name: "VIPs",
  description: "",
  queryAst: {
    op: "condition",
    field: "email",
    comparator: "contains",
    value: "@example.com",
  },
  lastCount: 1200,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const roots: Root[] = [];

function render(ui: ReactNode): Root {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client }, ui));
  });
  roots.push(root);
  return root;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function mount(
  segmentId: string,
  { listId = "", frozen = false }: { listId?: string; frozen?: boolean } = {},
) {
  return render(
    createElement(CampaignAudienceSection, {
      audience: { list_id: listId, segment_id: segmentId },
      audienceCount: {
        base: 1300,
        excluded: 100,
        deliverable: 1200,
        kind: "segment",
      },
      audienceCountError: null,
      audienceCountLoading: false,
      frozen,
      lists: [],
      listsError: false,
      listsLoading: false,
      onAudienceChange: vi.fn(),
      onRetryLists: vi.fn(),
      onRetrySegments: vi.fn(),
      segmentsError: false,
      segmentsLoading: false,
      segments: [SEGMENT],
    }),
  );
}

function button(label: string): HTMLButtonElement {
  const match = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (!match) throw new Error(`Button not found: ${label}`);
  return match;
}

/** Scoped to the confirm, because the page button says "Freeze audience now". */
function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) throw new Error("No confirm dialog is open");
  const match = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Dialog button not found: ${label}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.whoami.mockResolvedValue(OWNER);
  mocks.whoamiFresh.mockResolvedValue(OWNER);
  mocks.post.mockResolvedValue({ ok: true, frozen_members: 1180 });
});

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
});

describe("freeze campaign audience", () => {
  it("posts the freeze only after a confirm that names the permanence", async () => {
    mount(SEGMENT.id);
    await flush();

    act(() => button("Freeze audience now").click());
    await flush();

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Freeze this campaign's audience?");
    expect(dialog?.textContent).toContain(
      "Subscribers who join the segment afterwards will NOT be mailed",
    );
    expect(dialog?.textContent).toContain("There is no unfreeze");
    expect(mocks.post).not.toHaveBeenCalled();

    act(() => dialogButton("Freeze audience").click());
    await flush();

    expect(mocks.post).toHaveBeenCalledWith(
      FREEZE_PATH,
      {},
      expect.objectContaining({ requireOnline: true, idempotencyKey: null }),
    );
    // Authority is re-read against the live session before the write.
    expect(mocks.whoamiFresh).toHaveBeenCalled();
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Audience frozen — 1,180 recipients captured for this campaign.",
    );
    expect(
      document.querySelector('[data-testid="campaign-audience-freeze"]')
        ?.textContent,
    ).toContain("Audience frozen at 1,180 recipients.");
  });

  it("withholds the verb on a whole-audience campaign, saying why", async () => {
    mount("");
    await flush();

    expect(button("Freeze audience now").disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="campaign-audience-freeze"]')
        ?.textContent,
    ).toContain("a whole-audience campaign has no membership to snapshot");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("withholds the verb on a list audience, saying why", async () => {
    mount("", { listId: "16" });
    await flush();

    expect(button("Freeze audience now").disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="campaign-audience-freeze"]')
        ?.textContent,
    ).toContain("a list audience always sends to the list's current members");
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("locks the picker and the verb once the audience is frozen", async () => {
    mount(SEGMENT.id, { frozen: true });
    await flush();

    expect(
      document.querySelector<HTMLSelectElement>("#campaign-audience")?.disabled,
    ).toBe(true);
    expect(button("Freeze audience now").disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Duplicate the campaign to send to a different audience.",
    );
  });

  it("withholds the verb from a viewer with the workspace's own sentence", async () => {
    mocks.whoami.mockResolvedValue(VIEWER);
    mount(SEGMENT.id);
    await flush();

    expect(button("Freeze audience now").disabled).toBe(true);
    expect(
      document.querySelector('[data-testid="campaign-audience-freeze"]')
        ?.textContent,
    ).toContain("Campaign changes are read-only for this session.");
  });

  it("says what the SNAPSHOT is taken from, not just that it is a snapshot", async () => {
    mount(SEGMENT.id);
    await flush();
    expect(
      document.querySelector('[data-testid="campaign-audience-freeze"]')
        ?.textContent,
    ).toContain("Snapshots the SAVED segment's members");
  });

  it("renders the server's refusal verbatim when the freeze is rejected", async () => {
    mocks.post.mockRejectedValue(
      new Error("a static snapshot requires a segment audience"),
    );
    mount(SEGMENT.id);
    await flush();

    act(() => button("Freeze audience now").click());
    await flush();
    act(() => dialogButton("Freeze audience").click());
    await flush();

    expect(mocks.toastError).toHaveBeenCalledWith(
      "a static snapshot requires a segment audience",
    );
  });
});
