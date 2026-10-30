// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
//
// A stored omnichannel campaign opens a path-summary dialog from its list
// row. The assertions are consequences: the GET the click sends (path with the
// id encoded, abort signal attached), the path rows the dialog renders, the
// refresh that re-sends it, and the server sentence a failure carries.

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api";
import { renderPage, unmount, WHOAMI } from "../pages/_harness";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/omnichannel",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { ...actual.api, get: mocks.get } };
});

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

const catalog = {
  schema_version: "1",
  runtime: {
    capability: "omnichannel_campaign_execution",
    runtime_status: "unavailable",
    execution_enabled: false,
    code: "omnichannel_runtime_unavailable",
    message: "Omnichannel execution is release-held.",
  },
  channels: [{ key: "email", label: "Email", runtime_status: "unavailable" }],
  send_strategies: [],
};

const campaign = {
  id: "camp_1",
  tenant_id: WHOAMI.tenant_id,
  name: "Winback",
  status: "draft",
  objective: "reactivation",
  recipient_snapshot_mode: "at_send",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-02T10:00:00Z",
  paths: [
    {
      path_key: "email_first",
      name: "Email first",
      channel: "email",
      status: "planned",
      traffic_weight_basis_points: 7000,
      sequence: 1,
    },
    {
      path_key: "sms_fallback",
      name: "SMS fallback",
      channel: "sms",
      status: "planned",
      fallback_path_key: "email_first",
      traffic_weight_basis_points: 3000,
      sequence: 2,
    },
  ],
};

function serve(
  detail: (path: string) => unknown | Promise<unknown>,
  listItems: unknown[] = [{ id: "camp_1", name: "Winback", status: "draft" }],
) {
  mocks.get.mockImplementation(async (path: string) => {
    if (path === "/api/v1/omnichannel/catalog") return catalog;
    if (path === "/api/v1/omnichannel/campaigns") return { items: listItems };
    if (path.startsWith("/api/v1/omnichannel/campaigns/")) return detail(path);
    throw new ApiError("not found", 404, undefined, { code: "not_found" });
  });
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw last;
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll("button")).find(
    (candidate): candidate is HTMLButtonElement =>
      candidate instanceof HTMLButtonElement &&
      candidate.textContent?.trim() === label,
  );
}

async function click(label: string): Promise<void> {
  const target = button(label);
  if (!target) throw new Error(`Missing button: ${label}`);
  await act(async () => target.click());
}

function detailCalls(): unknown[][] {
  return mocks.get.mock.calls.filter(([path]) =>
    String(path).startsWith("/api/v1/omnichannel/campaigns/"),
  );
}

async function mount() {
  const Page = (await import("@/app/(dashboard)/app/omnichannel/page")).default;
  return renderPage(Page);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("omnichannel campaign detail", () => {
  it("opens the stored path summary from the campaign row and refreshes it", async () => {
    serve(() => campaign);
    const { root } = await mount();
    try {
      expect(detailCalls()).toEqual([]);
      await click("Winback");
      await eventually(() =>
        expect(mocks.get).toHaveBeenCalledWith(
          "/api/v1/omnichannel/campaigns/camp_1",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      await eventually(() =>
        expect(document.body.textContent).toContain("Email first"),
      );
      const text = document.body.textContent ?? "";
      expect(text).toContain("Partial path summary");
      expect(text).toContain("SMS fallback");
      expect(text).toContain("sms_fallback");
      expect(text).toContain("70%");
      expect(text).toContain("30%");
      expect(text).toContain("stored draft");
      // The fallback column names the path it falls back to.
      expect(
        Array.from(document.querySelectorAll("td code")).map(
          (node) => node.textContent,
        ),
      ).toEqual(["email_first", "sms_fallback", "email_first"]);
      // Objective is fetched but deliberately not represented.
      expect(text).not.toContain("reactivation");

      await click("Refresh definition");
      await eventually(() => expect(detailCalls()).toHaveLength(2));
    } finally {
      unmount(root);
    }
  });

  it("encodes the campaign identity into the path", async () => {
    serve(() => ({ ...campaign, id: "camp/1", paths: [] }), [
      { id: "camp/1", name: "Slashed", status: "draft" },
    ]);
    const { root } = await mount();
    try {
      await click("Slashed");
      await eventually(() =>
        expect(mocks.get).toHaveBeenCalledWith(
          "/api/v1/omnichannel/campaigns/camp%2F1",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      await eventually(() =>
        expect(document.body.textContent).toContain("No path definitions"),
      );
    } finally {
      unmount(root);
    }
  });

  it("renders the server's sentence when the definition cannot be read", async () => {
    serve(() => {
      throw new ApiError("campaign not found", 404, undefined, {
        code: "not_found",
      });
    });
    const { root } = await mount();
    try {
      await click("Winback");
      await eventually(() =>
        expect(document.body.textContent).toContain("campaign not found"),
      );
      expect(document.body.textContent).toContain(
        "Campaign definition is unavailable",
      );
      expect(document.body.textContent).not.toContain("Email first");
    } finally {
      unmount(root);
    }
  });

  it("refuses a definition that answers for a different campaign", async () => {
    serve(() => ({ ...campaign, id: "camp_2" }));
    const { root } = await mount();
    try {
      await click("Winback");
      await eventually(() =>
        expect(document.body.textContent).toContain(
          "different campaign definition",
        ),
      );
      expect(document.body.textContent).not.toContain("Email first");
    } finally {
      unmount(root);
    }
  });
});
