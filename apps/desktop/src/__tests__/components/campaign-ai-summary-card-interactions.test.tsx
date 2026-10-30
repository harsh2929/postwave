// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement } from "react";
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

const mocks = vi.hoisted(() => ({
  getSummary: vi.fn(),
  regenerate: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getCampaignSummary: mocks.getSummary,
    regenerateCampaignSummary: mocks.regenerate,
  },
}));
vi.mock("../../components/Toast", () => ({
  toast: { success: mocks.toastSuccess },
}));

import { CampaignAISummaryCard } from "../../components/CampaignAISummaryCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.getSummary.mockReset();
  mocks.regenerate.mockReset();
  mocks.toastSuccess.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function summary(campaignId: string, body = "**Strong result.** Keep going.") {
  return {
    campaign_id: campaignId,
    body_markdown: body,
    source: "voice" as const,
    inputs_snapshot: {},
    generated_at: "2026-07-16T10:00:00Z",
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(node: ReactElement): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${label} button`);
  }
  return match;
}

async function waitFor(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await act(async () => Promise.resolve());
    }
  }
  throw failure;
}

describe("CampaignAISummaryCard interactions", () => {
  it("contains thrown loads, coalesces retry, and exposes source without tooltips", async () => {
    mocks.getSummary.mockImplementationOnce(() => {
      throw new Error("summary service offline");
    });
    render(<CampaignAISummaryCard campaignId="campaign-1" />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Couldn't load the campaign summary: summary service offline",
      ),
    );

    const pending = deferred<{ data: ReturnType<typeof summary> }>();
    mocks.getSummary.mockReturnValue(pending.promise);
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    expect(mocks.getSummary).toHaveBeenCalledTimes(2);
    pending.resolve({ data: summary("campaign-1") });
    await act(async () => pending.promise);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Voice-authored"),
    );
    expect(document.body.textContent).toContain("Strong result.");
    expect(document.querySelector("[title]")).toBeNull();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("single-flights generation and retains a visible failure", async () => {
    mocks.getSummary.mockResolvedValue({
      error: { status: 404, message: "not generated" },
    });
    const pending = deferred<{ data: ReturnType<typeof summary> }>();
    mocks.regenerate.mockReturnValue(pending.promise);
    render(<CampaignAISummaryCard campaignId="campaign-2" />);
    await waitFor(() => expect(button("Generate summary")).toBeTruthy());

    const generate = button("Generate summary");
    act(() => {
      generate.click();
      generate.click();
    });
    expect(mocks.regenerate).toHaveBeenCalledTimes(1);
    expect(button("Generating…").disabled).toBe(true);

    pending.resolve({ data: summary("campaign-2", "Generated summary") });
    await act(async () => pending.promise);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Generated summary"),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Summary refreshed");

    mocks.regenerate.mockRejectedValueOnce(new Error("generation unavailable"));
    act(() => button("Refresh").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Action failed: generation unavailable",
      ),
    );
    expect(button("Refresh").disabled).toBe(false);
  });

  it("serializes suggested actions and contains rejected callbacks", async () => {
    mocks.getSummary.mockResolvedValue({ data: summary("campaign-3") });
    const resendPending = deferred<void>();
    const onResend = vi.fn(() => resendPending.promise);
    const onABTest = vi.fn().mockRejectedValue(new Error("experiment blocked"));
    render(
      <CampaignAISummaryCard
        campaignId="campaign-3"
        canMutate
        onResendNonOpeners={onResend}
        onABTest={onABTest}
      />,
    );
    await waitFor(() =>
      expect(button("Resend to non-openers in 48h")).toBeTruthy(),
    );

    const resend = button("Resend to non-openers in 48h");
    act(() => {
      resend.click();
      resend.click();
    });
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(button("Scheduling resend…").disabled).toBe(true);
    expect(button("A/B test the subject").disabled).toBe(true);
    await act(async () => {
      resendPending.resolve();
      await resendPending.promise;
    });

    act(() => button("A/B test the subject").click());
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Action failed: experiment blocked",
      ),
    );
    expect(onABTest).toHaveBeenCalledTimes(1);
    expect(button("A/B test the subject").disabled).toBe(false);
  });

  it("drops an old regeneration after the campaign changes", async () => {
    const oldRegeneration = deferred<{ data: ReturnType<typeof summary> }>();
    mocks.getSummary
      .mockResolvedValueOnce({ data: summary("old", "Old initial") })
      .mockResolvedValueOnce({ data: summary("new", "New campaign summary") });
    mocks.regenerate.mockReturnValue(oldRegeneration.promise);
    render(<CampaignAISummaryCard campaignId="old" />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Old initial"),
    );
    act(() => button("Refresh").click());

    render(<CampaignAISummaryCard campaignId="new" />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("New campaign summary"),
    );
    oldRegeneration.resolve({ data: summary("old", "Stale regenerated body") });
    await act(async () => oldRegeneration.promise);
    expect(document.body.textContent).toContain("New campaign summary");
    expect(document.body.textContent).not.toContain("Stale regenerated body");
  });
});
