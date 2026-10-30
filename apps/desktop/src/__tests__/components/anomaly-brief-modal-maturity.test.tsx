// @vitest-environment happy-dom

import axe, { type AxeResults } from "axe-core";
import { act, type ReactElement, useState } from "react";
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

import type {
  AnomalyBriefMetric,
  AnomalyBriefResponse,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  anomalyBrief: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  analyticsNlqApi: { anomalyBrief: mocks.anomalyBrief },
}));

import { AnomalyBriefModal } from "../../components/dashboard/AnomalyBriefModal";

const longCampaignName =
  "The exceptionally long multilingual campaign name that must remain readable without clipping or a pointer-only tooltip";

const completeBrief: AnomalyBriefResponse = {
  metric: "opens",
  window_days: 7,
  summary:
    "Open activity rose after the product announcement reached the most engaged segment.",
  probable_causes: [
    "The product announcement contributed most of the current-window opens.",
  ],
  suggested_actions: [
    "Verify delivery and audience composition before changing the schedule.",
  ],
  aggregates: {
    metric: "opens",
    window_days: 7,
    current_total: 9_999_999_999_999,
    previous_total: 4_000_000_000_000,
    daily: [{ day: "2026-07-17", value: 1_000_000_000_000 }],
    top_campaigns: [
      {
        campaign_id:
          "campaign-id-with-an-exceptionally-long-unbroken-identifier-00000000000000000001",
        campaign_name: longCampaignName,
        value: 8_888_888_888_888,
      },
    ],
  },
  trace: {
    reasoning: "PRIVATE INTERNAL MODEL REASONING MUST NOT RENDER",
    prompt_tokens: 100,
    response_tokens: 80,
    summary_tokens: 40,
    generated_at: "2026-07-18T08:00:00.000Z",
  },
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.anomalyBrief.mockReset();
  mocks.anomalyBrief.mockResolvedValue({ data: completeBrief });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  document.documentElement.removeAttribute("data-theme");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender(next) {
      act(() => root?.render(next));
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function dispatchKey(key: string): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key,
    }),
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function modal(
  metric: AnomalyBriefMetric = "opens",
  onClose = vi.fn(),
): ReactElement {
  return (
    <AnomalyBriefModal open metric={metric} windowDays={7} onClose={onClose} />
  );
}

function seriousOrCritical(result: AxeResults) {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

function FocusHarness({ onClose }: { onClose: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" id="anomaly-trigger" onClick={() => setOpen(true)}>
        Explain opens
      </button>
      <AnomalyBriefModal
        open={open}
        metric={open ? "opens" : null}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    </>
  );
}

describe("AnomalyBriefModal maturity", () => {
  it.each(["dark", "light"] as const)(
    "renders named, responsive aggregate evidence without private trace or native tooltips in %s theme",
    async (theme) => {
      document.documentElement.setAttribute("data-theme", theme);
      render(modal());
      await flush();

      expect(mocks.anomalyBrief).toHaveBeenCalledWith({
        metric: "opens",
        window_days: 7,
      });
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain(completeBrief.summary);
      expect(dialog?.textContent).toContain(longCampaignName);
      expect(dialog?.textContent).not.toContain(
        "PRIVATE INTERNAL MODEL REASONING MUST NOT RENDER",
      );
      expect(dialog?.textContent).not.toContain(
        completeBrief.aggregates.top_campaigns[0]!.campaign_id,
      );
      expect(dialog?.querySelector("[title]")).toBeNull();
      expect(dialog?.querySelector("[style]")).toBeNull();

      const evidenceRegion = dialog?.querySelector<HTMLElement>(
        '[role="region"][aria-label="Campaign evidence for open-event volume"]',
      );
      expect(evidenceRegion?.tabIndex).toBe(0);
      const table = evidenceRegion?.querySelector("table");
      expect(table?.querySelector("caption")?.textContent).toContain(
        "Campaign totals included",
      );
      expect(table?.querySelectorAll('th[scope="col"]')).toHaveLength(2);
      expect(table?.querySelectorAll('th[scope="row"]')).toHaveLength(1);
      expect(
        dialog?.querySelector(
          'dl[aria-label="open-event volume window comparison"]',
        ),
      ).not.toBeNull();
      expect(dialog?.textContent).toContain("Explain open-event volume");
      expect(dialog?.textContent).toContain("Raw event counts");
      expect(dialog?.textContent).toContain("Current 7-day event count");
      expect(dialog?.textContent).toContain("Previous 7-day event count");
      expect(
        Array.from(dialog?.querySelectorAll('th[scope="col"]') ?? []).map(
          (node) => node.textContent?.trim(),
        ),
      ).toEqual(["Campaign", "Event count"]);
      expect(dialog?.textContent).not.toContain("open rate");

      const result = await axe.run(dialog!);
      expect(seriousOrCritical(result)).toEqual([]);
    },
  );

  it("announces only loading milestones while keeping the visual elapsed timer out of the live region", () => {
    vi.useFakeTimers();
    mocks.anomalyBrief.mockReturnValueOnce(new Promise(() => undefined));
    render(modal());

    const state = document.querySelector<HTMLElement>(".pw-anomaly-loading");
    const live = state?.querySelector<HTMLElement>('[role="status"]');
    const visualTimer = state?.querySelector<HTMLElement>(".tabular");
    expect(state).not.toBeNull();
    expect(
      document.querySelector(".pw-anomaly-brief")?.getAttribute("aria-busy"),
    ).toBe("true");
    expect(live?.textContent).toContain("Asking Claude to analyse the spike");
    expect(live?.getAttribute("aria-atomic")).toBe("true");
    expect(live?.textContent).not.toContain("0s elapsed");
    expect(visualTimer?.getAttribute("aria-hidden")).toBe("true");
    expect(visualTimer?.textContent).toContain("0s elapsed");
    expect(document.activeElement).toBe(button("Close"));

    act(() => {
      void vi.advanceTimersByTime(9_000);
    });
    expect(live?.textContent).toContain("Asking Claude to analyse the spike");
    expect(live?.textContent).not.toContain("9s elapsed");
    expect(visualTimer?.textContent).toContain("9s elapsed");

    act(() => {
      void vi.advanceTimersByTime(1_000);
    });
    expect(live?.textContent).toContain("Still working");
    expect(live?.textContent).not.toContain("10s elapsed");
    expect(visualTimer?.textContent).toContain("10s elapsed");
  });

  it("renders honest partial-result states instead of silently dropping sections", async () => {
    mocks.anomalyBrief.mockResolvedValueOnce({
      data: {
        ...completeBrief,
        summary: "",
        probable_causes: [],
        suggested_actions: [],
        aggregates: {
          ...completeBrief.aggregates,
          top_campaigns: [],
        },
      },
    });
    render(modal());
    await flush();

    expect(container?.textContent).toContain(
      "No narrative summary was returned",
    );
    expect(container?.textContent).toContain(
      "The model did not return probable causes",
    );
    expect(container?.textContent).toContain(
      "The model did not return suggested actions",
    );
    expect(container?.textContent).toContain(
      "No per-campaign breakdown was available",
    );
    expect(container?.querySelector(".pw-anomaly-comparison")).not.toBeNull();
    expect(container?.querySelector(".pw-anomaly-evidence-table")).toBeNull();

    const result = await axe.run(
      document.querySelector<HTMLElement>('[role="dialog"]')!,
    );
    expect(seriousOrCritical(result)).toEqual([]);
  });

  it("rejects a response without matching deterministic aggregate evidence", async () => {
    mocks.anomalyBrief.mockResolvedValueOnce({
      data: {
        ...completeBrief,
        aggregates: undefined,
      } as unknown as AnomalyBriefResponse,
    });
    render(modal());
    await flush();

    expect(container?.textContent).toContain(
      "Explanation could not be verified",
    );
    expect(
      container?.querySelector('.pw-anomaly-error[role="alert"]'),
    ).not.toBeNull();
    expect(container?.textContent).not.toContain(completeBrief.summary);
  });

  it.each([
    [
      "response metric",
      { ...completeBrief, metric: "clicks" } as AnomalyBriefResponse,
    ],
    [
      "response window",
      { ...completeBrief, window_days: 30 } as AnomalyBriefResponse,
    ],
    [
      "aggregate metric",
      {
        ...completeBrief,
        aggregates: { ...completeBrief.aggregates, metric: "clicks" },
      } as AnomalyBriefResponse,
    ],
    [
      "aggregate window",
      {
        ...completeBrief,
        aggregates: { ...completeBrief.aggregates, window_days: 30 },
      } as AnomalyBriefResponse,
    ],
  ])("rejects a mismatched %s", async (_, response) => {
    mocks.anomalyBrief.mockResolvedValueOnce({ data: response });
    render(modal("opens"));
    await flush();

    expect(container?.textContent).toContain(
      "Explanation could not be verified",
    );
    expect(container?.textContent).toContain(
      "incomplete or mismatched evidence",
    );
    expect(container?.textContent).not.toContain(completeBrief.summary);
    expect(container?.querySelector(".pw-anomaly-content")).toBeNull();
  });

  it("retries retryable failures but does not offer futile cost-cap retries", async () => {
    mocks.anomalyBrief
      .mockResolvedValueOnce({
        error: {
          kind: "timeout",
          message: "The request timed out",
        },
      })
      .mockResolvedValueOnce({ data: completeBrief });
    render(modal());
    await flush();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "The explanation timed out",
    );
    await act(async () => {
      button("Try again").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.anomalyBrief).toHaveBeenCalledTimes(2);
    expect(container?.textContent).toContain(completeBrief.summary);

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    document.body.replaceChildren();
    mocks.anomalyBrief.mockReset();
    mocks.anomalyBrief.mockResolvedValueOnce({
      error: {
        status: 429,
        code: "cost_cap_exceeded",
        message: "private provider budget detail",
      },
    });
    render(modal());
    await flush();

    expect(document.body.textContent).toContain("Daily AI budget exhausted");
    expect(document.body.textContent).not.toContain(
      "private provider budget detail",
    );
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Try again",
      ),
    ).toBe(false);
  });

  it("turns thrown transport failures into retryable non-disclosing copy", async () => {
    mocks.anomalyBrief.mockRejectedValueOnce(
      new Error("PRIVATE PROVIDER TRANSPORT DETAIL"),
    );
    render(modal());
    await flush();

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Explanation unavailable");
    expect(alert?.textContent).toContain(
      "The explanation service could not be reached",
    );
    expect(document.body.textContent).not.toContain(
      "PRIVATE PROVIDER TRANSPORT DETAIL",
    );
    expect(button("Try again")).toBeTruthy();
  });

  it("never reflects API diagnostics, URLs, codes, or tokens into the dialog", async () => {
    mocks.anomalyBrief.mockResolvedValueOnce({
      error: {
        status: 500,
        code: "PRIVATE_UPSTREAM_CODE",
        requestId: "private-request-token",
        message:
          "POST https://internal.example.test failed Authorization=Bearer-private-token",
      },
    });
    render(modal());
    await flush();

    const copy = document.querySelector('[role="alert"]')?.textContent ?? "";
    expect(copy).toContain("Couldn't generate the explanation");
    for (const privateValue of [
      "PRIVATE_UPSTREAM_CODE",
      "private-request-token",
      "internal.example.test",
      "Bearer-private-token",
      "POST https://",
    ]) {
      expect(copy).not.toContain(privateValue);
    }
  });

  it("redacts identity, contact, link, credential, and bidi/control text from every model-authored field", async () => {
    const privateEmail = "jane.doe@example.test";
    const privatePhone = "+1 (415) 555-2671";
    const privateUuid = "550e8400-e29b-41d4-a716-446655440000";
    const privateSubscriber = "subscriber-secret-001";
    const privateProfile = "profile-secret-002";
    mocks.anomalyBrief.mockResolvedValueOnce({
      data: {
        ...completeBrief,
        summary: `Contact ${privateEmail} or ${privatePhone}; ref ${privateUuid}. Inspect https://private.example.test/path\u202e`,
        probable_causes: [
          `subscriber_id=${privateSubscriber} and profile identifier: ${privateProfile}`,
          "Authorization: Bearer abcdefghijklmnop",
        ],
        suggested_actions: [
          "Use api_key=ghp_privatecredential123456",
          "Open www.private-action.example.test/path\u0007",
        ],
        aggregates: {
          ...completeBrief.aggregates,
          top_campaigns: [
            {
              ...completeBrief.aggregates.top_campaigns[0]!,
              campaign_name:
                "VIP profile-id: campaign-profile-909 at private-campaign.example.test token=private-value",
            },
          ],
        },
      },
    });
    render(modal());
    await flush();

    const copy = container?.textContent ?? "";
    expect(copy).toContain("[link redacted]");
    expect(copy).toContain("[credential redacted]");
    expect(copy).toContain("[email redacted]");
    expect(copy).toContain("[phone redacted]");
    expect(copy).toContain("[identifier redacted]");
    expect(copy).toContain("[profile identifier redacted]");
    expect(copy).toContain("[control removed]");
    for (const privateValue of [
      privateEmail,
      privatePhone,
      privateUuid,
      privateSubscriber,
      privateProfile,
      "private.example.test",
      "sk-private-secret-value",
      "abcdefghijklmnop",
      "ghp_privatecredential123456",
      "private-campaign.example.test",
      "campaign-profile-909",
      "private-action.example.test",
      "private-value",
      "\u202e",
      "\u0007",
    ]) {
      expect(copy).not.toContain(privateValue);
    }
    expect(container?.outerHTML).not.toContain(privateEmail);
    expect(copy).toContain("privacy-filtered");
    expect(copy).not.toContain(
      "No subscriber-level data is displayed in this brief",
    );
  });

  it("bounds model-authored strings and lists after privacy filtering", async () => {
    mocks.anomalyBrief.mockResolvedValueOnce({
      data: {
        ...completeBrief,
        summary: `${"S".repeat(6_000)} hidden@example.test`,
        probable_causes: Array.from(
          { length: 20 },
          (_, index) => `${index}:${"C".repeat(1_500)}`,
        ),
        suggested_actions: Array.from(
          { length: 20 },
          (_, index) => `${index}:${"A".repeat(1_500)}`,
        ),
        aggregates: {
          ...completeBrief.aggregates,
          top_campaigns: [
            {
              ...completeBrief.aggregates.top_campaigns[0]!,
              campaign_name: "N".repeat(500),
            },
          ],
        },
      },
    });
    render(modal());
    await flush();

    expect(
      container?.querySelector(".pw-anomaly-summary p")?.textContent?.length,
    ).toBeLessThanOrEqual(4_000);
    expect(
      container?.querySelectorAll(".pw-anomaly-insight:first-of-type li"),
    ).toHaveLength(8);
    expect(
      container?.querySelectorAll(".pw-anomaly-insight:last-of-type li"),
    ).toHaveLength(8);
    for (const item of container?.querySelectorAll(".pw-anomaly-insight li") ??
      []) {
      expect(item.textContent?.length).toBeLessThanOrEqual(1_000);
    }
    expect(
      container?.querySelector(".pw-anomaly-campaign-name")?.textContent
        ?.length,
    ).toBeLessThanOrEqual(240);
    expect(container?.outerHTML).not.toContain("hidden@example.test");
  });

  it("formats EUR evidence with Intl and discloses excluded currencies", async () => {
    mocks.anomalyBrief.mockResolvedValueOnce({
      data: {
        ...completeBrief,
        metric: "revenue",
        aggregates: {
          ...completeBrief.aggregates,
          metric: "revenue",
          current_total: 12_345,
          previous_total: 5_000,
          daily: [{ day: "2026-07-17", value: 12_345 }],
          revenue_scope: {
            currency: "EUR",
            monetary_conversion_count: 4,
            excluded_currency_count: 1,
          },
          top_campaigns: [
            {
              campaign_id: "campaign-1",
              campaign_name: "Summer offer",
              value: 9_876,
            },
          ],
        },
      },
    });
    render(modal("revenue"));
    await flush();

    const comparison = container?.querySelector(".pw-anomaly-comparison");
    const euro = (value: number) =>
      new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(value / 100);
    expect(comparison?.textContent).toContain(euro(12_345));
    expect(comparison?.textContent).toContain(euro(5_000));
    expect(
      container?.querySelector(".pw-anomaly-evidence-table")?.textContent,
    ).toContain(euro(9_876));
    expect(
      container?.querySelector('.pw-anomaly-evidence-empty[role="note"]')
        ?.textContent,
    ).toBe(
      "Across both windows, 4 monetary conversions were recorded. Revenue totals are scoped to EUR; 1 other currency was excluded from every total, daily point, and campaign row.",
    );
    expect(container?.textContent).toContain("Explain currency-scoped revenue");
    expect(container?.textContent).toContain("Current 7-day scoped revenue");
    expect(container?.textContent).not.toContain("$");
  });

  it.each([
    ["missing scope", undefined],
    [
      "missing currency",
      {
        monetary_conversion_count: 1,
        excluded_currency_count: 0,
      },
    ],
    [
      "null currency with monetary rows",
      {
        currency: null,
        monetary_conversion_count: 1,
        excluded_currency_count: 0,
      },
    ],
    [
      "invalid ISO currency",
      {
        currency: "ZZZ",
        monetary_conversion_count: 1,
        excluded_currency_count: 0,
      },
    ],
    [
      "lower-case currency",
      {
        currency: "eur",
        monetary_conversion_count: 1,
        excluded_currency_count: 0,
      },
    ],
  ])("rejects positive revenue with %s", async (_, revenueScope) => {
    mocks.anomalyBrief.mockResolvedValueOnce({
      data: {
        ...completeBrief,
        metric: "revenue",
        aggregates: {
          ...completeBrief.aggregates,
          metric: "revenue",
          current_total: 100,
          previous_total: 0,
          daily: [{ day: "2026-07-17", value: 100 }],
          top_campaigns: [],
          revenue_scope: revenueScope,
        },
      } as unknown as AnomalyBriefResponse,
    });
    render(modal("revenue"));
    await flush();

    expect(container?.textContent).toContain(
      "Explanation could not be verified",
    );
    expect(container?.querySelector(".pw-anomaly-content")).toBeNull();
    expect(container?.textContent).not.toContain(completeBrief.summary);
  });

  it("renders an explicit no-monetary-conversions revenue scope without inventing a currency", async () => {
    mocks.anomalyBrief.mockResolvedValueOnce({
      data: {
        ...completeBrief,
        metric: "revenue",
        aggregates: {
          ...completeBrief.aggregates,
          metric: "revenue",
          current_total: 0,
          previous_total: 0,
          daily: [],
          top_campaigns: [],
          revenue_scope: {
            currency: null,
            monetary_conversion_count: 0,
            excluded_currency_count: 0,
          },
        },
      },
    });
    render(modal("revenue"));
    await flush();

    expect(container?.textContent).toContain(
      "No monetary conversions were recorded in either comparison window",
    );
    expect(container?.textContent).toContain(
      "0 minor units (no currency selected)",
    );
    expect(container?.textContent).not.toMatch(/[$€£]/u);
  });

  it.each([
    ["unsafe total", { current_total: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional total", { previous_total: 10.5 }],
    [
      "unsafe daily value",
      { daily: [{ day: "2026-07-17", value: Number.POSITIVE_INFINITY }] },
    ],
    [
      "unsafe campaign value",
      {
        top_campaigns: [
          {
            ...completeBrief.aggregates.top_campaigns[0]!,
            value: Number.MAX_SAFE_INTEGER + 1,
          },
        ],
      },
    ],
    [
      "overlong daily evidence",
      {
        daily: Array.from({ length: 367 }, (_, index) => ({
          day: `2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
          value: index,
        })),
      },
    ],
  ])("rejects %s instead of formatting corrupt numerics", async (_, patch) => {
    mocks.anomalyBrief.mockResolvedValueOnce({
      data: {
        ...completeBrief,
        aggregates: { ...completeBrief.aggregates, ...patch },
      },
    });
    render(modal());
    await flush();

    expect(container?.textContent).toContain(
      "Explanation could not be verified",
    );
    expect(container?.querySelector(".pw-anomaly-content")).toBeNull();
    expect(container?.textContent).not.toContain("Infinity");
  });

  it("drops a closed request and never lets it overwrite a newer metric", async () => {
    const first = deferred<{ data: AnomalyBriefResponse }>();
    const second = deferred<{ data: AnomalyBriefResponse }>();
    mocks.anomalyBrief
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const onClose = vi.fn();
    const view = render(modal("opens", onClose));
    expect(mocks.anomalyBrief).toHaveBeenCalledTimes(1);

    view.rerender(
      <AnomalyBriefModal open={false} metric={null} onClose={onClose} />,
    );
    view.rerender(modal("clicks", onClose));
    expect(mocks.anomalyBrief).toHaveBeenCalledTimes(2);

    const clicksBrief: AnomalyBriefResponse = {
      ...completeBrief,
      metric: "clicks",
      summary: "NEW CLICKS BRIEF",
      aggregates: {
        ...completeBrief.aggregates,
        metric: "clicks",
      },
    };
    await act(async () => {
      second.resolve({ data: clicksBrief });
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      first.resolve({
        data: { ...completeBrief, summary: "STALE OPENS BRIEF" },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("NEW CLICKS BRIEF");
    expect(container?.textContent).not.toContain("STALE OPENS BRIEF");
  });

  it("preserves modal focus, Escape close, and trigger restoration while a request is pending", async () => {
    mocks.anomalyBrief.mockReturnValueOnce(new Promise(() => undefined));
    const onClose = vi.fn();
    render(<FocusHarness onClose={onClose} />);
    const trigger = document.getElementById(
      "anomaly-trigger",
    ) as HTMLButtonElement;

    act(() => {
      trigger.focus();
      trigger.click();
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement).toBe(button("Close"));

    await act(async () => dispatchKey("Escape"));
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
