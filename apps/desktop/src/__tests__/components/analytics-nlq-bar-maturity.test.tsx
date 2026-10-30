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

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  analyticsNlqApi: { query: mocks.query },
}));

vi.mock("../../components/InlineHelp", () => ({
  InlineHelp: ({ text }: { text: string }) => <span>{text}</span>,
}));

import { AnalyticsNlqBar } from "../../components/analytics/AnalyticsNlqBar";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.query.mockReset();
  mocks.query.mockResolvedValue({
    data: {
      question: "Top campaigns by revenue?",
      answer_kind: "table",
      template: "top_campaigns_by_revenue",
      params: { window_days: 30, limit: 10 },
      columns: ["campaign_name", "currency", "revenue_cents"],
      rows: [
        {
          campaign_name: "Summer launch",
          currency: "USD",
          revenue_cents: 12_345,
        },
      ],
      summary_text:
        "Returned 1 campaign-and-currency row; amounts remain separated by currency.",
      trace: {
        reasoning: "The question requests ranked campaign revenue.",
        prompt_tokens: 10,
        response_tokens: 5,
        summary_tokens: 0,
        generated_at: "2026-07-24T12:00:00Z",
      },
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<AnalyticsNlqBar />));
}

function setQuestion(value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
  if (!textarea) throw new Error("Missing analytics question input");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe("AnalyticsNlqBar maturity", () => {
  it("discloses the processor boundary and renders locally-produced evidence accessibly", async () => {
    render();
    expect(document.body.textContent).toContain(
      "Your question text is sent to Anthropic",
    );
    expect(document.body.textContent).toContain(
      "Result rows stay inside Moosewave",
    );
    const input = document.querySelector<HTMLTextAreaElement>("textarea")!;
    const noteId = input.getAttribute("aria-describedby");
    expect(document.getElementById(noteId!)?.getAttribute("role")).toBe("note");

    setQuestion("Top campaigns by revenue?");
    await act(async () => {
      button("Ask").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0]?.[0]).toBe("Top campaigns by revenue?");
    expect(mocks.query.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(document.body.textContent).toContain("Summer launch");
    expect(document.body.textContent).toContain(
      "Query-selection rationale: The question requests ranked campaign revenue.",
    );
    expect(container?.querySelector("[title]")).toBeNull();
    const tableRegion = document.querySelector(
      '[role="region"][aria-label="Natural-language analytics result table"]',
    );
    expect(tableRegion?.getAttribute("tabindex")).toBe("0");

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("cancels the in-flight request, keeps the draft, and ignores its late result", async () => {
    let resolveRequest!: (value: unknown) => void;
    mocks.query.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    render();
    setQuestion("Keep this draft");

    act(() => button("Ask").click());
    const signal = mocks.query.mock.calls[0]?.[1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    act(() => button("Cancel request").click());
    expect(signal.aborted).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Keep this draft",
    );

    await act(async () => {
      resolveRequest({
        data: {
          question: "stale",
          answer_kind: "summary",
          template: "engagement_overview",
          params: { window_days: 30, limit: 10 },
          columns: [],
          rows: [],
          summary_text: "This stale result must not render.",
          trace: {
            reasoning: "",
            prompt_tokens: 0,
            response_tokens: 0,
            summary_tokens: 0,
            generated_at: "2026-07-24T12:00:00Z",
          },
        },
      });
      await Promise.resolve();
    });
    expect(document.body.textContent).not.toContain(
      "This stale result must not render.",
    );
    expect(button("Ask").disabled).toBe(false);
  });
});
