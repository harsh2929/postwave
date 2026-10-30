// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactNode } from "react";
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
  SubjectLabScoredVariant,
  SubjectScoreResponse,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  analyze: vi.fn(),
  generate: vi.fn(),
  getVoice: vi.fn(),
  onClose: vi.fn(),
  onPick: vi.fn(),
  onRunBandit: vi.fn(),
  score: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    generateSubjectLabVariants: mocks.generate,
    getBrandVoiceProfile: mocks.getVoice,
    scoreSubjectVariants: mocks.score,
  },
  subjectAnalyzerApi: { score: mocks.analyze },
}));

vi.mock("../../components/Modal", () => ({
  Modal: ({
    children,
    open,
    title,
  }: {
    children: ReactNode;
    open: boolean;
    title: string;
  }) =>
    open ? (
      <section aria-label={title} role="dialog">
        {children}
      </section>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => (
    <footer>{children}</footer>
  ),
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { SubjectLab } from "../../components/SubjectLab";

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason: unknown) => void;
  resolve: (value: T) => void;
}

interface LabProps {
  bodyExcerpt?: string;
  canMutate: boolean;
  onClose: () => void;
  onPickVariant: (text: string) => void;
  onRunBandit: (top3: SubjectLabScoredVariant[]) => void;
  open: boolean;
  seedSubject: string;
}

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
  vi.clearAllMocks();
  mocks.analyze.mockResolvedValue({ data: analyzerScore() });
  mocks.generate.mockImplementation(
    (input: { axis: "length" | "emoji" | "question" | "personalization" }) =>
      Promise.resolve({
        data: {
          variants: ["First choice", "Second choice", "Third choice"],
          axis: input.axis,
          generated_at: "2026-07-16T10:00:00.000Z",
        },
      }),
  );
  mocks.getVoice.mockResolvedValue({
    data: { id: "voice-1", is_active: true },
  });
  mocks.score.mockResolvedValue({
    data: {
      baseline_open: 0.25,
      window_days: 180,
      variants: scoredVariants(),
    },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function analyzerScore(
  overrides: Partial<SubjectScoreResponse> = {},
): SubjectScoreResponse {
  return {
    subject: "Launch our summer sale",
    attributes: {
      length: 22,
      length_bucket: "medium",
      word_count: 4,
      emoji_count: 0,
      has_question: false,
      has_personalize: false,
      uppercase_ratio: 0.05,
      all_caps: false,
    },
    expected_open: 0.31,
    expected_click: 0.08,
    matched_history: 12,
    suggestions: ["Try a question"],
    ...overrides,
  };
}

function scoredVariant(
  text: string,
  ciLow: number,
  overrides: Partial<SubjectLabScoredVariant> = {},
): SubjectLabScoredVariant {
  return {
    text,
    axis: "server-value",
    predicted_open: ciLow + 0.08,
    ci_low: ciLow,
    ci_high: ciLow + 0.16,
    matched_n: 25,
    low_confidence: false,
    below_baseline: false,
    ...overrides,
  };
}

function scoredVariants(): SubjectLabScoredVariant[] {
  return [
    scoredVariant("First choice", 0.22),
    scoredVariant("Second choice", 0.27),
    scoredVariant("Third choice", 0.24),
  ];
}

function defaultProps(overrides: Partial<LabProps> = {}): LabProps {
  return {
    open: true,
    seedSubject: "Launch our summer sale",
    bodyExcerpt: "A short campaign body",
    canMutate: true,
    onClose: mocks.onClose,
    onPickVariant: mocks.onPick,
    onRunBandit: mocks.onRunBandit,
    ...overrides,
  };
}

function renderLab(overrides: Partial<LabProps> = {}): {
  rerender: (next: Partial<LabProps>) => void;
  unmount: () => void;
} {
  let props = defaultProps(overrides);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = (): void => {
    act(() => root?.render(<SubjectLab {...props} />));
  };
  render();
  return {
    rerender(next) {
      props = { ...props, ...next };
      render();
    },
    unmount() {
      act(() => root?.unmount());
      root = null;
    },
  };
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function buttons(label: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((candidate) => candidate.textContent?.trim() === label);
}

function click(target: HTMLElement): void {
  act(() => target.click());
}

async function clickAndFlush(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function setInput(target: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => Promise.resolve());
    }
  }
  throw lastError;
}

async function waitForAnalyzer(): Promise<void> {
  await waitFor(() => expect(mocks.analyze).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(document.body.textContent).toContain("matched 12 campaigns"),
  );
}

describe("SubjectLab", () => {
  it("allows viewer-safe analysis but denies every mutating entry point", async () => {
    renderLab({ canMutate: false });
    await waitForAnalyzer();

    expect(mocks.analyze).toHaveBeenCalledWith("Launch our summer sale");
    expect(button("Generate").disabled).toBe(false);
    expect(button("Generate").getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(
        button("Generate").getAttribute("aria-describedby") ?? "",
      )?.textContent,
    ).toBe("Viewer access can analyze subjects but cannot generate variants.");
    expect(button("Run top 3 as A/B").disabled).toBe(false);
    expect(button("Run top 3 as A/B").getAttribute("aria-disabled")).toBe(
      "true",
    );
    await clickAndFlush(button("Generate"));
    click(button("Run top 3 as A/B"));
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.onRunBandit).not.toHaveBeenCalled();
  });

  it("submits the exact bounded request and ranks the scored top three by lower confidence bound", async () => {
    const bodyExcerpt = "x".repeat(2105);
    renderLab({ bodyExcerpt });
    await waitForAnalyzer();
    click(button("Emoji"));
    const count = document.querySelector<HTMLInputElement>("#lab-count");
    expect(count).not.toBeNull();
    setInput(count!, "99");
    await clickAndFlush(button("Generate"));

    await waitFor(() => expect(buttons("Use")).toHaveLength(3));
    expect(mocks.generate).toHaveBeenCalledWith({
      seed_subject: "Launch our summer sale",
      axis: "emoji",
      count: 8,
      body_excerpt: bodyExcerpt.slice(0, 2000),
      voice_profile_id: "voice-1",
    });
    expect(mocks.score).toHaveBeenCalledWith({
      subjects: ["First choice", "Second choice", "Third choice"],
    });
    expect(document.body.textContent).toContain(
      "Tenant baseline open rate: 25.0% over the last 180 days",
    );

    click(buttons("Use")[0]!);
    expect(mocks.onPick).toHaveBeenCalledWith("Second choice");
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      'Subject updated to "Second choice"',
    );
    click(button("Run top 3 as A/B"));
    expect(mocks.onRunBandit).toHaveBeenCalledWith([
      { ...scoredVariants()[1], axis: "emoji" },
      { ...scoredVariants()[2], axis: "emoji" },
      { ...scoredVariants()[0], axis: "emoji" },
    ]);
    expect(document.querySelector("table")).not.toBeNull();
    expect(
      Array.from(document.querySelectorAll("th")).map((header) =>
        header.textContent?.trim(),
      ),
    ).toEqual([
      "Rank",
      "Subject",
      "Axis",
      "Predicted open",
      "Confidence",
      "Action",
    ]);
    expect(document.body.textContent).toContain("90% CI");
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

  it("serializes rapid generation attempts while the first request is pending", async () => {
    const pending = deferred<{
      data: { variants: string[]; axis: "length"; generated_at: string };
    }>();
    mocks.generate.mockReturnValue(pending.promise);
    renderLab();
    await waitForAnalyzer();

    const generate = button("Generate");
    act(() => {
      generate.click();
      generate.click();
    });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(button("Generating…").disabled).toBe(false);
    expect(button("Generating…").getAttribute("aria-disabled")).toBe("true");
    expect(
      document.querySelector<HTMLInputElement>("#lab-count")?.disabled,
    ).toBe(true);

    await act(async () => {
      pending.resolve({
        data: {
          variants: ["First choice", "Second choice", "Third choice"],
          axis: "length",
          generated_at: "2026-07-16T10:00:00.000Z",
        },
      });
      await pending.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(button("Generate").getAttribute("aria-disabled")).toBeNull(),
    );
  });

  it("invalidates an old generation when its seed changes", async () => {
    const oldRequest = deferred<{
      data: { variants: string[]; axis: "length"; generated_at: string };
    }>();
    mocks.generate
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({
        data: {
          variants: ["New one", "New two", "New three"],
          axis: "length",
          generated_at: "2026-07-16T10:05:00.000Z",
        },
      });
    mocks.score.mockResolvedValueOnce({
      data: {
        baseline_open: 0.2,
        window_days: 180,
        variants: [
          scoredVariant("New one", 0.2),
          scoredVariant("New two", 0.3),
          scoredVariant("New three", 0.25),
        ],
      },
    });
    const view = renderLab({ seedSubject: "An old seed subject" });
    await waitForAnalyzer();
    await clickAndFlush(button("Generate"));
    view.rerender({ seedSubject: "A replacement seed subject" });
    await waitFor(() =>
      expect(button("Generate").getAttribute("aria-disabled")).toBeNull(),
    );

    await act(async () => {
      oldRequest.resolve({
        data: {
          variants: ["Old one", "Old two", "Old three"],
          axis: "length",
          generated_at: "2026-07-16T10:00:00.000Z",
        },
      });
      await oldRequest.promise;
    });
    expect(document.body.textContent).not.toContain("Old one");
    await clickAndFlush(button("Generate"));
    await waitFor(() => expect(document.body.textContent).toContain("New two"));
    expect(mocks.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ seed_subject: "A replacement seed subject" }),
    );
    expect(document.body.textContent).not.toContain("Old one");
  });

  it("shows real generated text as unscored when scoring fails and blocks A/B", async () => {
    mocks.score.mockResolvedValue({
      error: { kind: "http", status: 503, message: "scorer offline" },
    });
    renderLab();
    await waitForAnalyzer();
    await clickAndFlush(button("Generate"));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Score unavailable (scorer offline)",
      ),
    );
    expect(buttons("Use")).toHaveLength(3);
    expect(document.body.textContent).toContain("Unscored");
    expect(document.body.textContent).toContain("—");
    expect(document.body.textContent).not.toContain(
      "Tenant baseline open rate",
    );
    const run = button("Run top 3 as A/B");
    expect(run.disabled).toBe(false);
    expect(run.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(run.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Scoring must succeed before starting an A/B test.");
    click(buttons("Use")[0]!);
    expect(mocks.onPick).toHaveBeenCalledWith("First choice");
  });

  it("keeps only the newest analyzer response and reports a thrown retryable failure", async () => {
    const oldAnalysis = deferred<{ data: SubjectScoreResponse }>();
    mocks.analyze
      .mockReset()
      .mockReturnValueOnce(oldAnalysis.promise)
      .mockResolvedValueOnce({
        data: analyzerScore({ expected_open: 0.42, matched_history: 7 }),
      })
      .mockRejectedValueOnce(new Error("analyzer network failure"))
      .mockResolvedValueOnce({ data: analyzerScore() });
    const view = renderLab({ seedSubject: "An old analyzer seed" });
    await waitFor(() => expect(mocks.analyze).toHaveBeenCalledTimes(1));
    view.rerender({ seedSubject: "A new analyzer seed" });
    await waitFor(() =>
      expect(document.body.textContent).toContain("~42.0% open"),
    );

    await act(async () => {
      oldAnalysis.resolve({
        data: analyzerScore({ expected_open: 0.11, matched_history: 2 }),
      });
      await oldAnalysis.promise;
    });
    expect(document.body.textContent).toContain("~42.0% open");
    expect(document.body.textContent).not.toContain("~11.0% open");

    view.rerender({ seedSubject: "A third analyzer seed" });
    await waitFor(() =>
      expect(document.body.textContent).toContain("analyzer network failure"),
    );
    click(button("Retry"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("matched 12 campaigns"),
    );
  });

  it("drops pending generation work after unmount", async () => {
    const pending = deferred<{
      data: { variants: string[]; axis: "length"; generated_at: string };
    }>();
    mocks.generate.mockReturnValue(pending.promise);
    const view = renderLab();
    await waitForAnalyzer();
    click(button("Generate"));
    view.unmount();

    await act(async () => {
      pending.resolve({
        data: {
          variants: ["Late one", "Late two", "Late three"],
          axis: "length",
          generated_at: "2026-07-16T10:00:00.000Z",
        },
      });
      await pending.promise;
    });
    expect(mocks.score).not.toHaveBeenCalled();
    expect(mocks.onPick).not.toHaveBeenCalled();
    expect(mocks.onRunBandit).not.toHaveBeenCalled();
  });
});
