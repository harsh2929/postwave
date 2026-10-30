// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderPage, unmount, WHOAMI } from "./_harness";

const { catalogMock, settingsMock } = vi.hoisted(() => ({
  catalogMock: vi.fn(),
  settingsMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/app/onsite-growth",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
  redirect: vi.fn(),
}));

vi.mock("@/lib/auth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-api")>()),
  whoami: vi.fn().mockResolvedValue(WHOAMI),
}));

vi.mock("@/lib/onsite-growth-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/onsite-growth-api")>()),
  getOnsiteGrowthCatalog: catalogMock,
  getNbpSettings: settingsMock,
}));

beforeEach(() => {
  catalogMock.mockReset().mockResolvedValue({
    trigger_types: [],
    targeting_groups: [],
    frequency_modes: [],
    experiment_modes: [],
    winner_metrics: [],
    spin_reward_types: [],
  });
  settingsMock.mockReset().mockResolvedValue({
    enabled: false,
    recency_exclude_days: 0,
    top_n_per_user: 0,
    similarity_floor: 0,
    refresher_strategy: "",
    refresh_interval_hours: 0,
    model_version: 0,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("onsite growth empty state", () => {
  it("explains an empty successful catalogue instead of leaving a blank section", async () => {
    const Page = (await import("@/app/(dashboard)/app/onsite-growth/page"))
      .default;
    const { container, root } = await renderPage(Page);
    try {
      expect(container.textContent).toContain(
        "No onsite capabilities are offered by this build.",
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      unmount(root);
    }
  });
});
