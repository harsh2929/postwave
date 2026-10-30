// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// commerce-51 / commerce-53 — the same two verbs with every referral boundary
// simulated as LIFTED (the availability module is mocked to true). Proves the
// verbs are complete behind the gate: the picker lists GET /api/v1/assets,
// the chosen asset travels as `reward_image_asset_id` in the program's POST
// /api/v1/referral-programs full replacement, and the install dialog shows
// the per-subscriber widget tag.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setOnlineStatusForTest } from "@/lib/online-manager";
import { renderPage, unmount, WHOAMI } from "../pages/_harness";
import {
  buttonByText,
  clickEl,
  recordingTransport,
  settle,
} from "../pages/_mount-transport";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/referrals",
  useSearchParams: () => new URLSearchParams("tab=program"),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

vi.mock("@/lib/referral-operational-availability", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/referral-operational-availability")
  >()),
  REFERRAL_PUBLIC_WIDGET_INSTALL_AVAILABLE: true,
  REFERRAL_ATTRIBUTION_RUNTIME_AVAILABLE: true,
  REFERRAL_PROGRAM_MUTATIONS_AVAILABLE: true,
  REFERRAL_PAYOUT_OPERATIONS_AVAILABLE: true,
  REFERRAL_SUBSCRIBER_LINKS_AVAILABLE: true,
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const ASSET_ID = "3f0c1b2a-5d6e-4f70-8a91-b2c3d4e5f601";
const ASSET = {
  id: ASSET_ID,
  tenantId: WHOAMI.tenant_id,
  filename: "reward-mug.png",
  mime: "image/png",
  bytes: 20480,
  width: 400,
  height: 300,
  url: "https://cdn.example.test/reward-mug.png",
  createdAt: "2026-09-01T10:00:00Z",
  updatedAt: "2026-09-01T10:00:00Z",
  version: 1,
  altText: "Reward mug",
  referencesCount: 0,
  lastUsedAt: null,
  folderId: null,
};

const PROGRAM = {
  id: "prog-1",
  active: true,
  milestones: [{ count: 3, reward_label: "Free month", reward_kind: "free" }],
};

let calls: ReturnType<typeof recordingTransport>["calls"];

async function eventually(assertion: () => void, turns = 80): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < turns; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await settle(1);
    }
  }
  throw lastError;
}

beforeEach(() => {
  setOnlineStatusForTest("online");
  calls = recordingTransport((req) => {
    if (req.method === "GET" && req.path === "/api/v1/referral-programs/current") {
      return { body: PROGRAM };
    }
    if (req.method === "GET" && req.path === "/api/v1/assets") {
      return {
        body: {
          items: [ASSET],
          counts: { all: 1, recent: 1, inUse: 0, unused: 1, large: 0 },
          nextCursor: null,
        },
      };
    }
    if (req.method === "POST" && req.path === "/api/v1/referral-programs") {
      const body = req.body as { milestones: unknown[] };
      return { body: { ...PROGRAM, id: "prog-2", milestones: body.milestones } };
    }
    return undefined;
  }).calls;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("referrals program tab with every boundary lifted", () => {
  it("picks a library image and sends it as reward_image_asset_id", async () => {
    const Page = (await import("@/app/(dashboard)/app/referrals/page-client"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const choose = buttonByText(container, /^Choose image$/);
      expect(choose).toBeDefined();
      expect(choose!.getAttribute("aria-disabled")).toBeNull();
      expect(choose!.getAttribute("aria-describedby")).toBeNull();

      await clickEl(choose);
      // The picker is a next/dynamic chunk: wait for its listing request.
      await eventually(() =>
        expect(calls.some((c) => c.path === "/api/v1/assets")).toBe(true),
      );
      const listing = calls.find((c) => c.path === "/api/v1/assets")!;
      expect(listing.method).toBe("GET");
      expect(listing.query.get("limit")).toBe("60");
      expect(listing.query.get("sort")).toBe("newest");

      await eventually(() =>
        expect(document.querySelector('[role="option"]')).not.toBeNull(),
      );
      const option = document.querySelector<HTMLButtonElement>(
        '[role="option"]',
      )!;
      expect(option.getAttribute("aria-label")).toContain("reward-mug.png");
      await clickEl(option);
      expect(option.getAttribute("aria-selected")).toBe("true");
      await clickEl(buttonByText(document.body, /^Use image$/));
      await settle();

      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(container.textContent).toContain("Reward image selected");
      expect(buttonByText(container, /^Change image$/)).toBeDefined();

      await clickEl(buttonByText(container, /^Save program$/));
      await settle();
      const writes = calls.filter((c) => c.method !== "GET");
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatchObject({
        method: "POST",
        path: "/api/v1/referral-programs",
        body: {
          expected_program_id: "prog-1",
          milestones: [
            {
              count: 3,
              reward_label: "Free month",
              reward_kind: "free",
              reward_image_asset_id: ASSET_ID,
            },
          ],
        },
      });
      // onSaved applied the server's receipt: the editor re-keys on the new
      // program id (the success notice belongs to the unmounted instance).
      expect(container.textContent).toContain("Editing program prog-2");
    } finally {
      unmount(root);
    }
  });

  it("opens the install dialog with the per-subscriber widget tag", async () => {
    const Page = (await import("@/app/(dashboard)/app/referrals/page-client"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      const install = buttonByText(container, /Install on website/);
      expect(install).toBeDefined();
      expect(install!.getAttribute("aria-disabled")).toBeNull();
      expect(install!.getAttribute("aria-describedby")).toBeNull();
      await clickEl(install);
      await settle();
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.textContent).toContain("Install the referral widget");
      const code = dialog!.querySelector<HTMLTextAreaElement>("textarea")!;
      expect(code.readOnly).toBe(true);
      // NEXT_PUBLIC_API_URL may or may not be set in the test environment;
      // the tag is origin-relative without it and absolute with it.
      expect(code.value).toMatch(
        /^<script async src="(https?:\/\/[^/"]+)?\/api\/public\/r\/\{\{referral_code\}\}\/widget\.js"><\/script>$/u,
      );
      expect(buttonByText(dialog!, /Copy install code/)).toBeDefined();
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    } finally {
      unmount(root);
    }
  });
});
