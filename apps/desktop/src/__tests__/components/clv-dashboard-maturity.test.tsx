// @vitest-environment happy-dom

import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { CLVDistribution } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({ clvDashboard: vi.fn() }));

vi.mock("../../lib/api-client", () => ({
  predictiveApi: { clvDashboard: mocks.clvDashboard },
}));

vi.mock("../../components/common/Provenance", () => ({
  EstimateBadge: () => <span>Estimate</span>,
}));

import { CLVDashboard } from "../../components/dashboard/CLVDashboard";

const distribution: CLVDistribution = {
  profile_count: 20,
  scored_profiles: 18,
  total_clv_cents: 250_000,
  predicted_clv_cents: 100_000,
  avg_total_clv_cents: 13_889,
  percentiles: {
    p10_cents: 1_000,
    p25_cents: 2_500,
    p50_cents: 8_000,
    p75_cents: 15_000,
    p90_cents: 30_000,
    p99_cents: 80_000,
  },
  tiers: [
    {
      key: "champions",
      label: "Champions",
      profiles: 20,
      avg_total_clv_cents: 50_000,
      avg_churn_risk: 0.08,
    },
  ],
  top_profiles: [
    {
      subscriber_id: "subscriber-1",
      email: "a-complete-long-profile-address@example.test",
      total_clv_cents: 80_000,
      churn_risk: 0.12,
      segment_key: "champions",
    },
  ],
  at_risk_profiles: [
    {
      subscriber_id: "subscriber-2",
      email: "at-risk-profile@example.test",
      total_clv_cents: 60_000,
      churn_risk: 0.82,
      segment_key: "at_risk",
    },
  ],
  last_calculated_at: "2026-07-16T04:00:00.000Z",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.clvDashboard.mockReset();
  mocks.clvDashboard.mockResolvedValue({ data: distribution });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-theme");
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<CLVDashboard />));
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("CLVDashboard maturity", () => {
  it("renders complete projection evidence without exposing profile identities", async () => {
    render();
    await flush();

    expect(mocks.clvDashboard).toHaveBeenCalledWith({ previewLimit: 5 });
    const serialized = container?.outerHTML ?? "";
    for (const privateValue of [
      "a-complete-long-profile-address@example.test",
      "at-risk-profile@example.test",
      "subscriber-1",
      "subscriber-2",
    ]) {
      expect(document.body.textContent).not.toContain(privateValue);
      expect(serialized).not.toContain(privateValue);
    }
    expect(document.body.textContent).toContain("Profile A01");
    expect(document.body.textContent).toContain("At-risk B01");
    expect(document.body.textContent).toContain("Identity hidden");
    expect(document.body.textContent).toContain("Identity-protected preview");
    expect(document.body.textContent).toContain("Projected total CLV");
    expect(document.body.textContent).toContain("Projected churn risk");
    expect(document.body.textContent).toContain("p50 median");
    expect(document.body.textContent).toContain("Average projected CLV");
    expect(document.body.textContent).toContain("average churn risk");
    expect(
      container?.querySelector('dl[aria-label="Customer value summary"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector(
        'meter[aria-label^="Median projected customer value"]',
      ),
    ).not.toBeNull();
    expect(
      container?.querySelectorAll(".pw-clv-profile-list > li"),
    ).toHaveLength(2);
    expect(
      container?.querySelector('[role="status"].pw-clv-partial'),
    ).not.toBeNull();
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(
      distribution.last_calculated_at,
    );
    expect(container?.querySelector("[title]")).toBeNull();
    expect(container?.querySelector("[style]")).toBeNull();

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("contains synchronous failures and single-flights the visible retry", async () => {
    mocks.clvDashboard
      .mockImplementationOnce(() => {
        throw new Error("private predictive database detail");
      })
      .mockResolvedValueOnce({ data: distribution });
    render();
    await flush();

    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain(
      "private predictive database detail",
    );
    const retry = button("Retry CLV dashboard");
    await act(async () => {
      retry.click();
      retry.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.clvDashboard).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Champions");
  });

  it("retains a verified projection and labels it stale after refresh failure", async () => {
    let resolveRefresh!: (value: unknown) => void;
    mocks.clvDashboard
      .mockResolvedValueOnce({ data: distribution })
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveRefresh = resolve;
        }),
      );
    render();
    await flush();
    act(() => button("Refresh").click());
    expect(document.body.textContent).toContain(
      "showing the last verified snapshot",
    );
    await act(async () => {
      resolveRefresh({
        error: {
          status: 500,
          message: "private model service detail",
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(
      "The last verified projection remains visible below.",
    );
    expect(document.body.textContent).toContain("Champions");
    expect(document.body.textContent).not.toContain(
      "private model service detail",
    );
  });

  it("does not claim a projection remains visible after a verified empty snapshot fails to refresh", async () => {
    mocks.clvDashboard
      .mockResolvedValueOnce({ data: null })
      .mockResolvedValueOnce({
        error: { status: 500, message: "private model service detail" },
      });
    render();
    await flush();
    expect(document.body.textContent).toContain(
      "No predicted customer-value snapshot",
    );

    await act(async () => {
      button("Refresh").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain(
      "The last verified response contained no CLV projection",
    );
    expect(document.body.textContent).toContain(
      "there is no prior projection to display",
    );
    expect(document.body.textContent).not.toContain(
      "The last verified projection remains visible below",
    );
    expect(document.body.textContent).not.toContain(
      "private model service detail",
    );
    expect(container?.querySelector(".pw-clv-snapshot")).toBeNull();
  });

  it("gives loading and empty snapshots distinct, announced states", async () => {
    let resolveInitial!: (value: unknown) => void;
    mocks.clvDashboard.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
    );
    render();

    const loading = container?.querySelector<HTMLElement>(
      '.pw-clv-loading[role="status"]',
    );
    expect(loading?.getAttribute("aria-busy")).toBe("true");
    expect(loading?.textContent).toContain("Loading predicted customer value");
    expect(
      loading?.querySelectorAll(".skel, .pw-clv-loading-placeholder"),
    ).toHaveLength(6);

    await act(async () => {
      resolveInitial({ data: null });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      container?.querySelector('.pw-clv-empty[role="status"]'),
    ).not.toBeNull();
    expect(container?.textContent).toContain(
      "No predicted customer-value snapshot",
    );
    expect(container?.textContent).not.toContain(
      "Loading predicted customer value",
    );
  });

  it("enforces identity-free preview caps even when the service over-returns", async () => {
    const topProfiles = Array.from({ length: 12 }, (_, index) => ({
      subscriber_id: `private-subscriber-${index}`,
      email: `private-profile-${index}@example.test`,
      total_clv_cents: 10_000 + index,
      churn_risk: 0.1,
      segment_key: `private-segment-${index}`,
    }));
    const atRiskProfiles = Array.from({ length: 11 }, (_, index) => ({
      subscriber_id: `private-risk-id-${index}`,
      email: `private-risk-${index}@example.test`,
      total_clv_cents: 20_000 + index,
      churn_risk: 0.8,
      segment_key: `private-risk-segment-${index}`,
    }));
    mocks.clvDashboard.mockResolvedValueOnce({
      data: {
        ...distribution,
        top_profiles: topProfiles,
        at_risk_profiles: atRiskProfiles,
      },
    });
    render();
    await flush();

    expect(
      container?.querySelectorAll(".pw-clv-profile-list > li"),
    ).toHaveLength(10);
    const serialized = container?.outerHTML ?? "";
    for (const profile of [...topProfiles, ...atRiskProfiles]) {
      expect(serialized).not.toContain(profile.email);
      expect(serialized).not.toContain(profile.subscriber_id);
      expect(serialized).not.toContain(profile.segment_key);
    }
    expect(serialized).not.toContain("private-subscriber-0");
  });

  it("uses display-rank-only aliases without linking the same private identity across lists", async () => {
    const privateId = "subscriber-private-stable-identity";
    const privateEmail = "stable-private-profile@example.test";
    const sharedProfile = {
      subscriber_id: privateId,
      email: privateEmail,
      total_clv_cents: 42_000,
      churn_risk: 0.35,
      segment_key: "private_segment_key",
    };
    mocks.clvDashboard.mockResolvedValueOnce({
      data: {
        ...distribution,
        top_profiles: [sharedProfile],
        at_risk_profiles: [{ ...sharedProfile, churn_risk: 0.8 }],
      },
    });
    render();
    await flush();

    const aliases = Array.from(
      container?.querySelectorAll(".pw-clv-profile-alias") ?? [],
      (node) => node.textContent,
    );
    expect(aliases).toHaveLength(2);
    expect(aliases).toEqual(["Profile A01", "At-risk B01"]);
    expect(new Set(aliases).size).toBe(2);
    const serialized = container?.outerHTML ?? "";
    expect(serialized).not.toContain(privateId);
    expect(serialized).not.toContain(privateEmail);
    expect(serialized).not.toContain("private_segment_key");
  });

  it.each([
    ["negative snapshot money", { total_clv_cents: -1 }],
    ["unsafe snapshot count", { profile_count: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional scored count", { scored_profiles: 17.5 }],
    ["unsafe snapshot money", { total_clv_cents: Number.MAX_SAFE_INTEGER + 1 }],
    [
      "non-finite profile money",
      {
        top_profiles: [
          { ...distribution.top_profiles[0]!, total_clv_cents: Number.NaN },
        ],
      },
    ],
    [
      "negative tier money",
      {
        tiers: [{ ...distribution.tiers[0]!, avg_total_clv_cents: -100 }],
      },
    ],
    [
      "overflowed churn percentage",
      {
        at_risk_profiles: [
          { ...distribution.at_risk_profiles[0]!, churn_risk: 10 },
        ],
      },
    ],
    ["invalid recompute timestamp", { last_calculated_at: "not-a-date" }],
  ])("rejects %s without rendering unverified evidence", async (_, patch) => {
    mocks.clvDashboard.mockResolvedValueOnce({
      data: { ...distribution, ...patch },
    });
    render();
    await flush();

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "CLV projection could not be verified",
    );
    expect(container?.querySelector(".pw-clv-snapshot")).toBeNull();
    expect(container?.textContent).not.toContain("Champions");
  });

  it.each([
    [
      "empty profile population with nonempty evidence",
      {
        profile_count: 0,
        scored_profiles: 0,
      },
    ],
    [
      "tier counts that do not partition projected profiles",
      {
        tiers: [{ ...distribution.tiers[0]!, profiles: 19 }],
      },
    ],
    ["nonempty profile population without canonical tiers", { tiers: [] }],
    [
      "more top-profile rows than scored profiles",
      {
        profile_count: 1,
        scored_profiles: 1,
        tiers: [{ ...distribution.tiers[0]!, profiles: 1 }],
        top_profiles: [
          distribution.top_profiles[0]!,
          { ...distribution.top_profiles[0]!, subscriber_id: "private-2" },
        ],
        at_risk_profiles: [],
      },
    ],
    [
      "predicted value greater than total value",
      { predicted_clv_cents: distribution.total_clv_cents + 1 },
    ],
    [
      "more tier rows than the bounded canonical contract",
      {
        tiers: Array.from({ length: 9 }, (_, index) => ({
          ...distribution.tiers[0]!,
          key: `tier-${index}`,
          profiles: index === 0 ? 12 : 1,
        })),
      },
    ],
  ])("rejects contradictory distribution: %s", async (_, patch) => {
    mocks.clvDashboard.mockResolvedValueOnce({
      data: { ...distribution, ...patch },
    });
    render();
    await flush();

    expect(container?.querySelector('[role="alert"]')?.textContent).toContain(
      "CLV projection could not be verified",
    );
    expect(container?.querySelector(".pw-clv-snapshot")).toBeNull();
  });

  it("accepts the backend contract where sufficiency is zero but tiers and previews cover all projected profiles", async () => {
    mocks.clvDashboard.mockResolvedValueOnce({
      data: {
        ...distribution,
        scored_profiles: 0,
      },
    });
    render();
    await flush();

    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(container?.querySelector(".pw-clv-snapshot")).not.toBeNull();
    expect(document.body.textContent).toContain(
      "No profiles meet the data-sufficiency threshold",
    );
    expect(document.body.textContent).toContain(
      "can include profiles below that threshold",
    );
    expect(document.body.textContent).toContain("Champions");
    expect(document.body.textContent).toContain("Profile A01");
  });

  it("accepts a canonical zero-profile distribution only when all evidence is empty", async () => {
    mocks.clvDashboard.mockResolvedValueOnce({
      data: {
        profile_count: 0,
        scored_profiles: 0,
        total_clv_cents: 0,
        predicted_clv_cents: 0,
        avg_total_clv_cents: 0,
        percentiles: {
          p10_cents: 0,
          p25_cents: 0,
          p50_cents: 0,
          p75_cents: 0,
          p90_cents: 0,
          p99_cents: 0,
        },
        tiers: [],
        top_profiles: [],
        at_risk_profiles: [],
        last_calculated_at: null,
      },
    });
    render();
    await flush();

    expect(container?.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "No predicted customer-value snapshot",
    );
  });

  it("keeps a flat maximum-safe percentile meter within safe numeric bounds", async () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    mocks.clvDashboard.mockResolvedValueOnce({
      data: {
        ...distribution,
        total_clv_cents: maximum,
        predicted_clv_cents: 0,
        avg_total_clv_cents: maximum,
        percentiles: {
          p10_cents: maximum,
          p25_cents: maximum,
          p50_cents: maximum,
          p75_cents: maximum,
          p90_cents: maximum,
          p99_cents: maximum,
        },
      },
    });
    render();
    await flush();

    const meter = container?.querySelector("meter");
    expect(meter?.getAttribute("max")).toBe(String(maximum));
    expect(meter?.getAttribute("min")).toBe(String(maximum - 1));
    expect(meter?.getAttribute("value")).toBe(String(maximum));
    expect(container?.outerHTML).not.toContain("Infinity");
  });

  it("renders permission denial without raw server detail or a futile retry", async () => {
    mocks.clvDashboard.mockResolvedValueOnce({
      error: {
        status: 403,
        message: "private authorization policy and subscriber identity",
      },
    });
    render();
    await flush();

    expect(container?.textContent).toContain(
      "CLV projection unavailable for this role",
    );
    expect(container?.textContent).toContain(
      "Your current role does not have permission to read this data.",
    );
    expect(container?.textContent).not.toContain(
      "private authorization policy and subscriber identity",
    );
    expect(
      Array.from(container?.querySelectorAll("button") ?? []).some(
        (candidate) => candidate.textContent?.includes("Retry CLV dashboard"),
      ),
    ).toBe(false);
  });

  it.each(["dark", "light"] as const)(
    "keeps long values semantic and axe-clean in %s theme",
    async (theme) => {
      document.documentElement.setAttribute("data-theme", theme);
      mocks.clvDashboard.mockResolvedValueOnce({
        data: {
          ...distribution,
          profile_count: 9_999_999_999,
          scored_profiles: 9_999_999_998,
          total_clv_cents: 999_999_999_999_999,
          predicted_clv_cents: 888_888_888_888_888,
          avg_total_clv_cents: 777_777_777_777_777,
          tiers: [
            {
              ...distribution.tiers[0]!,
              label:
                "Champions with an exceptionally long translated segment label that must wrap",
              profiles: 9_999_999_999,
            },
          ],
          top_profiles: [
            {
              ...distribution.top_profiles[0]!,
              email:
                "customer-with-a-very-long-local-part-and-no-short-breakpoints@an-extraordinarily-long-customer-domain.example.test",
              segment_key:
                "an_exceptionally_long_segment_identifier_that_must_wrap_safely",
            },
          ],
        },
      });
      render();
      await flush();

      expect(container?.textContent).toContain("Champions");
      expect(container?.textContent).not.toContain(
        "customer-with-a-very-long-local-part",
      );
      expect(container?.textContent).not.toContain(
        "an_exceptionally_long_segment_identifier",
      );
      expect(container?.textContent).not.toContain(
        "Champions with an exceptionally long translated segment label",
      );
      expect(container?.querySelector("[title]")).toBeNull();
      expect(container?.querySelector("[style]")).toBeNull();

      const result = await axe.run(container ?? document.body);
      expect(
        result.violations.filter((violation) =>
          ["serious", "critical"].includes(violation.impact ?? ""),
        ),
      ).toEqual([]);
    },
  );
});
