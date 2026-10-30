// @vitest-environment happy-dom

import axe from "axe-core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  presendVerdict: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: { presendVerdict: mocks.presendVerdict },
}));

import {
  decodePresendVerdictResponse,
  PresendCheckPanel,
} from "../../components/ai/PresendCheckPanel";

const CHECKED_AT = "2026-08-08T10:15:00.000Z";
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
  mocks.presendVerdict.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(node: ReactElement = <PresendCheckPanel canMutate />): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function labelledInput(label: string): HTMLInputElement {
  const element = Array.from(
    document.querySelectorAll<HTMLLabelElement>("label"),
  ).find((candidate) => candidate.textContent?.includes(label));
  const control = element?.htmlFor
    ? document.getElementById(element.htmlFor)
    : null;
  if (!(control instanceof HTMLInputElement)) {
    throw new Error(`Missing labelled input: ${label}`);
  }
  return control;
}

function labelledTextarea(label: string): HTMLTextAreaElement {
  const element = Array.from(
    document.querySelectorAll<HTMLLabelElement>("label"),
  ).find((candidate) => candidate.textContent?.includes(label));
  const control = element?.htmlFor
    ? document.getElementById(element.htmlFor)
    : null;
  if (!(control instanceof HTMLTextAreaElement)) {
    throw new Error(`Missing labelled textarea: ${label}`);
  }
  return control;
}

function setInputValue(element: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setTextareaValue(element: HTMLTextAreaElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function submitButton(): HTMLButtonElement {
  const element = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.includes("pre-send check"));
  if (!element) throw new Error("Missing pre-send submit button");
  return element;
}

function fillValidDraft(subject = "A useful update"): void {
  setInputValue(labelledInput("Subject"), subject);
  setInputValue(labelledInput("Sender email"), "hello@example.com");
  setTextareaValue(labelledTextarea("Message body"), "Hello from Moosewave");
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function runCheck(): Promise<void> {
  act(() => submitButton().click());
  await flush();
}

function successfulResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    verdict: "ok",
    complete: true,
    summary: "All pre-send checks passed.",
    components: [
      {
        name: "eq_score",
        status: "ok",
        score: 82,
        message: "Content signal completed.",
      },
      {
        name: "voice_drift",
        status: "ok",
        score: 91,
        message: "Voice signal completed.",
      },
      {
        name: "placement",
        status: "ok",
        score: 0.74,
        message: "Placement signal completed.",
      },
    ],
    computed_at: CHECKED_AT,
    ...overrides,
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

describe("PresendCheckPanel", () => {
  it("keeps viewer drafts local and never starts a pre-send request", () => {
    render(<PresendCheckPanel canMutate={false} />);
    fillValidDraft("Viewer draft");

    expect(submitButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("View-only access");
    expect(document.body.textContent).toContain(
      "only editors and admins can run a new advisory check",
    );
    act(() => submitButton().click());
    expect(mocks.presendVerdict).not.toHaveBeenCalled();
  });

  it("starts disabled, labels every field, explains the advisory boundary, and has no serious accessibility violations", async () => {
    render();

    expect(labelledInput("Subject").required).toBe(true);
    expect(labelledInput("Sender email").required).toBe(true);
    expect(labelledTextarea("Message body").required).toBe(true);
    expect(submitButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("Advisory only");
    expect(document.body.textContent).toContain(
      "This review does not authorize a send.",
    );
    expect(document.body.textContent).toContain("No advisory result yet");
    expect(container?.querySelector("[style]")).toBeNull();

    const results = await axe.run(container!, {
      rules: { region: { enabled: false } },
    });
    expect(
      results.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("submits only a valid draft and presents a complete result with a freshness receipt", async () => {
    mocks.presendVerdict.mockResolvedValue({ data: successfulResponse() });
    render();
    fillValidDraft("  A useful update  ");

    expect(submitButton().disabled).toBe(false);
    await runCheck();

    expect(mocks.presendVerdict).toHaveBeenCalledWith({
      subject: "A useful update",
      from: "hello@example.com",
      html: "Hello from Moosewave",
      text: "Hello from Moosewave",
    });
    expect(document.body.textContent).toContain("Checks completed");
    expect(document.body.textContent).toContain("Current for this draft");
    expect(document.body.textContent).toContain("3 of 3 checks completed");
    expect(
      document.querySelector(".presend-check__result.is-pass"),
    ).not.toBeNull();
    expect(
      document.querySelector<HTMLTimeElement>(`time[datetime="${CHECKED_AT}"]`),
    ).not.toBeNull();
  });

  it("fails closed when an ostensibly passing response contains unavailable checks", async () => {
    mocks.presendVerdict.mockResolvedValue({
      data: successfulResponse({
        verdict: "ok",
        complete: true,
        components: [
          { name: "eq_score", status: "ok", score: 82 },
          {
            name: "voice_drift",
            status: "error",
            error: "Voice service unavailable",
          },
          {
            name: "placement",
            status: "skipped",
            message: "Predictor is not configured",
          },
        ],
      }),
    });
    render();
    fillValidDraft();
    await runCheck();

    expect(document.body.textContent).toContain("Incomplete review");
    expect(document.body.textContent).toContain(
      "Incomplete — do not infer a pass",
    );
    expect(document.body.textContent).toContain("Unavailable");
    expect(document.body.textContent).toContain("Not run");
    expect(document.body.textContent).not.toContain(
      "All pre-send checks passed.",
    );
    expect(document.querySelector(".presend-check__result.is-pass")).toBeNull();
    expect(
      document.querySelector(".presend-check__component.is-ok"),
    ).toBeNull();
  });

  it("keeps critical precedence while clearly disclosing incomplete coverage", async () => {
    mocks.presendVerdict.mockResolvedValue({
      data: successfulResponse({
        verdict: "critical",
        complete: false,
        summary: "Critical issue found.",
        components: [
          {
            name: "eq_score",
            status: "critical",
            score: 24,
            message: "Content needs correction.",
          },
          { name: "voice_drift", status: "ok", score: 85 },
          { name: "placement", status: "skipped" },
        ],
      }),
    });
    render();
    fillValidDraft();
    await runCheck();

    expect(document.body.textContent).toContain("Critical issues");
    expect(document.body.textContent).toContain(
      "one or more checks did not complete",
    );
    expect(document.body.textContent).toContain(
      "Incomplete — do not infer a pass",
    );
    expect(
      document.querySelector(".presend-check__result.is-critical"),
    ).not.toBeNull();
  });

  it("immediately makes a retained result stale when any draft value changes", async () => {
    mocks.presendVerdict.mockResolvedValue({ data: successfulResponse() });
    render();
    fillValidDraft("Original subject");
    await runCheck();

    setInputValue(labelledInput("Subject"), "Revised subject");

    expect(document.body.textContent).toContain(
      "Previous result — was checks completed",
    );
    expect(document.body.textContent).toContain("Previous draft only");
    expect(document.body.textContent).toContain("Original subject");
    expect(document.body.textContent).toContain(
      "retained for comparison but is not current",
    );
    expect(
      document.querySelector(".presend-check__result.is-stale"),
    ).not.toBeNull();
  });

  it("contains thrown requests, restores the submit lifecycle, and preserves the entered draft", async () => {
    mocks.presendVerdict.mockRejectedValue(
      new Error("private upstream detail"),
    );
    render();
    fillValidDraft("Retained subject");
    await runCheck();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Review unavailable",
    );
    expect(document.body.textContent).toContain(
      "Your draft was kept; try again.",
    );
    expect(document.body.textContent).not.toContain("private upstream detail");
    expect(labelledInput("Subject").value).toBe("Retained subject");
    expect(submitButton().disabled).toBe(false);
  });

  it("fails closed when a completed component omits its required score", async () => {
    mocks.presendVerdict.mockResolvedValue({
      data: successfulResponse({
        components: [
          { name: "eq_score", status: "ok" },
          { name: "voice_drift", status: "ok", score: 91 },
          { name: "placement", status: "ok", score: 0.74 },
        ],
      }),
    });
    render();
    fillValidDraft();
    await runCheck();

    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Review unavailable",
    );
    expect(document.body.textContent).not.toContain("0 / 100");
    expect(document.querySelector(".presend-check__result.is-pass")).toBeNull();
  });

  it("ignores an obsolete response after an edit and keeps the latest receipt", async () => {
    const first = deferred<{ data: Record<string, unknown> }>();
    mocks.presendVerdict
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        data: successfulResponse({
          verdict: "warn",
          summary: "Latest warning.",
          components: [
            { name: "eq_score", status: "warn", score: 60 },
            { name: "voice_drift", status: "ok", score: 88 },
            { name: "placement", status: "ok", score: 0.7 },
          ],
        }),
      });
    render();
    fillValidDraft("First subject");
    act(() => submitButton().click());
    await flush();

    setInputValue(labelledInput("Subject"), "Latest subject");
    expect(submitButton().disabled).toBe(false);
    await runCheck();
    expect(document.body.textContent).toContain("Review suggested");
    expect(document.body.textContent).toContain("Latest subject");

    first.resolve({ data: successfulResponse() });
    await flush();

    expect(document.body.textContent).toContain("Review suggested");
    expect(document.body.textContent).toContain("Latest subject");
    expect(document.body.textContent).not.toContain("First subject");
  });
});

describe("decodePresendVerdictResponse", () => {
  it("accepts the new completeness contract and safely derives legacy completeness", () => {
    const preferred = decodePresendVerdictResponse(successfulResponse());
    expect(preferred).toMatchObject({ ok: true, value: { complete: true } });

    const legacy = successfulResponse();
    delete legacy.complete;
    expect(decodePresendVerdictResponse(legacy)).toMatchObject({
      ok: true,
      value: { complete: true },
    });

    const explicitIncomplete = decodePresendVerdictResponse(
      successfulResponse({ verdict: "incomplete", complete: false }),
    );
    expect(explicitIncomplete).toMatchObject({
      ok: true,
      value: { complete: false, verdict: "incomplete" },
    });
  });

  it("rejects malformed receipts and derives incomplete from missing or unknown components", () => {
    expect(
      decodePresendVerdictResponse(successfulResponse({ complete: "yes" })),
    ).toMatchObject({ ok: false });
    expect(
      decodePresendVerdictResponse(
        successfulResponse({ computed_at: "not-a-date" }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      decodePresendVerdictResponse(
        successfulResponse({
          components: [{ name: "eq_score", status: "ok", score: Number.NaN }],
        }),
      ),
    ).toMatchObject({ ok: false });

    for (const status of ["ok", "warn", "critical"]) {
      expect(
        decodePresendVerdictResponse(
          successfulResponse({
            components: [
              { name: "eq_score", status },
              { name: "voice_drift", status: "ok", score: 90 },
              { name: "placement", status: "ok", score: 0.8 },
            ],
          }),
        ),
      ).toMatchObject({ ok: false });
    }
    expect(
      decodePresendVerdictResponse(
        successfulResponse({
          components: [
            { name: "eq_score", status: "error", score: 0 },
            { name: "voice_drift", status: "ok", score: 90 },
            { name: "placement", status: "ok", score: 0.8 },
          ],
        }),
      ),
    ).toMatchObject({ ok: false });

    const unknown = decodePresendVerdictResponse(
      successfulResponse({
        components: [
          { name: "eq_score", status: "future_status", score: 80 },
          { name: "voice_drift", status: "ok", score: 90 },
        ],
      }),
    );
    expect(unknown).toMatchObject({
      ok: true,
      value: {
        complete: false,
        components: [
          { name: "eq_score", status: "unknown" },
          { name: "voice_drift", status: "ok" },
          { name: "placement", received: false, status: "unknown" },
        ],
      },
    });
  });
});

describe("Pre-send responsive style contract", () => {
  it("uses intrinsic grids and includes zoom-width, reduced-motion, and forced-color fallbacks", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/styles-postwave-ai-presend.css"),
      "utf8",
    );

    expect(css).toContain("repeat(auto-fit, minmax(min(100%, 15rem), 1fr))");
    expect(css).toContain("repeat(auto-fit, minmax(min(100%, 12rem), 1fr))");
    expect(css).toContain("@media (max-width: 32rem)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
  });
});
