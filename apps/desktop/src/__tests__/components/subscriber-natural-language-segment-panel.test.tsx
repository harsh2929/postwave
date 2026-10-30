// @vitest-environment happy-dom

import axe from "axe-core";
import { act, type ReactElement, StrictMode } from "react";
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
  compileSegmentFromText: vi.fn(),
  getSegmentAIProcessingDisclosure: vi.fn(),
  segmentCreate: vi.fn(),
  previewCompiledSegment: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  compileSegmentFromText: mocks.compileSegmentFromText,
  getSegmentAIProcessingDisclosure: mocks.getSegmentAIProcessingDisclosure,
  isSegmentAIProcessingDisclosure: (value: unknown) =>
    Boolean(
      value &&
      typeof value === "object" &&
      Array.isArray((value as { data_categories?: unknown }).data_categories),
    ),
  previewCompiledSegment: mocks.previewCompiledSegment,
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { create: mocks.segmentCreate },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

import { SubscriberNaturalLanguageSegmentPanel } from "../../components/subscribers/SubscriberNaturalLanguageSegmentPanel";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.segmentCreate.mockResolvedValue({ data: { id: "segment-1" } });
  mocks.getSegmentAIProcessingDisclosure.mockResolvedValue({
    data: {
      available: true,
      ai_processing: {
        provider: "anthropic",
        model: "claude-test",
        data_categories: [
          "operator_supplied_segment_description",
          "segment_predicate_catalog",
        ],
        retention: "not_declared",
        residency: "not_declared",
      },
    },
  });
  mocks.previewCompiledSegment.mockResolvedValue({
    data: {
      count: 240,
      workspace_total: 1000,
      workspace_percentage: 24,
      generated_at: "2026-07-18T12:00:00Z",
      archive_scope: "active_only",
      applied_exclusions: ["archived_profiles"],
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

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<StrictMode>{node}</StrictMode>));
}

function setInput(label: string, value: string): void {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  );
  if (!input) throw new Error(`Missing input: ${label}`);
  act(() => {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function acknowledgeAI(): void {
  const checkbox = document.querySelector<HTMLInputElement>(
    '.subscriber-nl-ai-consent input[type="checkbox"]',
  );
  if (!checkbox) throw new Error("Missing AI acknowledgement");
  act(() => checkbox.click());
}

function click(label: string): void {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.includes(label));
  if (!button) throw new Error(`Missing button: ${label}`);
  act(() => button.click());
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw lastError;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SubscriberNaturalLanguageSegmentPanel", () => {
  it("shows provider facts before any external AI request", async () => {
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("anthropic");
      expect(document.body.textContent).toContain("claude-test");
      expect(document.body.textContent).toContain(
        "Available · Never selected automatically",
      );
    });
    expect(mocks.compileSegmentFromText).not.toHaveBeenCalled();
  });

  it("keeps external AI disabled when its preflight cannot be verified", async () => {
    mocks.getSegmentAIProcessingDisclosure.mockResolvedValue({
      error: { kind: "network", message: "offline" },
    });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.body.textContent).toContain("Preflight unavailable");
      expect(document.body.textContent).toContain("Try AI stays disabled");
    });
    expect(
      document.querySelector<HTMLInputElement>(
        '.subscriber-nl-ai-consent input[type="checkbox"]',
      )?.disabled,
    ).toBe(true);
    expect(mocks.compileSegmentFromText).not.toHaveBeenCalled();
  });

  it("does not invoke external AI processing before explicit acknowledgement", () => {
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "high intent readers");
    click("Try AI");

    expect(mocks.compileSegmentFromText).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "acknowledge the external AI-processing disclosure",
    );
  });

  it("requires an explicit AI choice after rules fail and saves the reviewed AST", async () => {
    const ast = {
      op: "and",
      children: [
        {
          op: "condition",
          field: "last_opened_at",
          comparator: "in_last_days",
          value: 7,
        },
        {
          op: "condition",
          field: "last_clicked_at",
          comparator: "never",
          value: null,
        },
      ],
    } as const;
    mocks.compileSegmentFromText
      .mockResolvedValueOnce({
        error: { message: "rules miss", kind: "http", status: 422 },
      })
      .mockResolvedValueOnce({
        data: {
          ast,
          engine_used: "ai",
          suggested_name: "Recent openers",
          nutrition_facts: {
            predicates: ["last_opened_at", "last_clicked_at"],
            time_windows: ["now-7d"],
            source: "ai-compiler",
          },
          ai_processing: {
            provider: "anthropic",
            model: "claude-test",
            data_categories: [
              "operator_supplied_segment_description",
              "segment_predicate_catalog",
            ],
            retention: "not_declared",
            residency: "not_declared",
          },
        },
      });
    const onSaved = vi.fn();
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="subscribed"
        query=""
        onSaved={onSaved}
      />,
    );
    setInput(
      "Natural language segment description",
      "opened recently but never clicked",
    );
    click("Build with rules");

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "explicitly choose Try AI",
      );
    });
    expect(mocks.compileSegmentFromText).toHaveBeenCalledTimes(1);
    expect(mocks.compileSegmentFromText).toHaveBeenCalledWith(
      "opened recently but never clicked",
      expect.objectContaining({ engine: "rules", signal: expect.anything() }),
    );
    expect(document.body.textContent).toContain("Never selected automatically");

    acknowledgeAI();
    click("Try AI");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Last Opened At");
      expect(document.body.textContent).toContain(
        "occurred in the last 7 days",
      );
      expect(document.body.textContent).toContain("AI-assisted");
      expect(document.body.textContent).toContain("anthropic");
      expect(document.body.textContent).toContain("claude-test");
      expect(document.body.textContent).toContain("Not declared");
    });
    expect(
      document.querySelector<HTMLInputElement>(
        '.subscriber-nl-ai-consent input[type="checkbox"]',
      )?.checked,
    ).toBe(false);
    expect(mocks.compileSegmentFromText).toHaveBeenNthCalledWith(
      1,
      "opened recently but never clicked",
      expect.objectContaining({ engine: "rules", signal: expect.anything() }),
    );
    expect(mocks.compileSegmentFromText).toHaveBeenNthCalledWith(
      2,
      "opened recently but never clicked",
      expect.objectContaining({ engine: "ai", signal: expect.anything() }),
    );

    click("Save exact segment");
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const reviewedAST = {
      op: "and",
      children: [
        ast,
        {
          op: "condition",
          field: "mailchimp_status",
          comparator: "equals",
          value: "subscribed",
        },
      ],
    };
    expect(mocks.previewCompiledSegment).toHaveBeenCalledWith(
      reviewedAST,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(mocks.segmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Recent openers",
        description: "opened recently but never clicked",
        queryAst: reviewedAST,
      }),
    );
  });

  it("surfaces a friendly unavailable-AI error", async () => {
    mocks.compileSegmentFromText.mockResolvedValue({
      error: { message: "unavailable", kind: "http", status: 503 },
    });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "complex cohort");
    await waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>(
          '.subscriber-nl-ai-consent input[type="checkbox"]',
        )?.disabled,
      ).toBe(false);
    });
    acknowledgeAI();
    click("Try AI");

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "AI compilation isn't available",
      );
    });
  });

  it("rejects malformed compiler output before preview or save", async () => {
    mocks.compileSegmentFromText.mockResolvedValue({
      data: {
        ast: {
          op: "condition",
          field: "email",
          comparator: "execute_sql",
          value: "private@example.test",
        },
        engine_used: "rules",
      },
    });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "unsafe output");
    click("Build with rules");

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "unsupported audience comparison",
      );
    });
    expect(mocks.previewCompiledSegment).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private@example.test");
    expect(document.body.textContent).not.toContain("Save exact segment");
  });

  it("blocks broad directory search instead of silently narrowing it to email", () => {
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="subscribed"
        query="vip customer"
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "engaged readers");
    const buildButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent?.includes("Build with rules"));
    expect(buildButton?.getAttribute("aria-disabled")).toBe("true");

    click("Build with rules");

    expect(mocks.compileSegmentFromText).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Clear the directory search",
    );
    expect(document.body.textContent).toContain(
      "names, email, tags, groups, and profile fields",
    );
  });

  it("rejects an empty compiler AST before preview or save", async () => {
    mocks.compileSegmentFromText.mockResolvedValue({
      data: {
        ast: { op: "and", children: [] },
        engine_used: "rules",
      },
    });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="subscribed"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "an impossible cohort");
    click("Build with rules");

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "No empty or match-all draft was accepted",
      );
    });
    expect(mocks.previewCompiledSegment).not.toHaveBeenCalled();
    expect(mocks.segmentCreate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Save exact segment");
  });

  it("single-flights a thrown compile, releases busy state, and retries", async () => {
    mocks.compileSegmentFromText
      .mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce({
        data: {
          ast: {
            op: "condition",
            field: "status",
            comparator: "equals",
            value: "subscribed",
          },
          engine_used: "ai",
          ai_processing: {
            provider: "anthropic",
            model: "claude-test",
            data_categories: [
              "operator_supplied_segment_description",
              "segment_predicate_catalog",
            ],
            retention: "not_declared",
            residency: "not_declared",
          },
        },
      });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "active readers");
    await waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>(
          '.subscriber-nl-ai-consent input[type="checkbox"]',
        )?.disabled,
      ).toBe(false);
    });
    acknowledgeAI();
    const tryAi = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Try AI");
    expect(tryAi).toBeDefined();
    act(() => {
      tryAi?.click();
      tryAi?.click();
    });

    await waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        "didn't complete",
      );
    });
    expect(mocks.compileSegmentFromText).toHaveBeenCalledTimes(1);
    expect(tryAi?.disabled).toBe(false);
    expect(document.body.textContent).not.toContain("private transport detail");

    acknowledgeAI();
    click("Try AI");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Status");
      expect(document.body.textContent).toContain("subscribed");
    });
    expect(mocks.compileSegmentFromText).toHaveBeenCalledTimes(2);
  });

  it("keeps save permission discoverable, guarded, and axe-clean", async () => {
    mocks.compileSegmentFromText.mockResolvedValue({
      data: {
        ast: {
          op: "condition",
          field: "status",
          comparator: "equals",
          value: "subscribed",
        },
        engine_used: "rules",
        suggested_name: "Subscribed readers",
      },
    });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate={false}
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "subscribed readers");
    click("Build with rules");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Status");
      expect(document.body.textContent).toContain("subscribed");
    });

    const save = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Save exact segment");
    expect(save?.disabled).toBe(false);
    expect(save?.getAttribute("aria-disabled")).toBe("true");
    const descriptionId = save?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(descriptionId)?.textContent).toContain(
      "Read-only access",
    );
    act(() => save?.click());
    expect(mocks.segmentCreate).not.toHaveBeenCalled();
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);

    const result = await axe.run(container ?? document.body, {
      rules: { region: { enabled: false } },
    });
    expect(
      result.violations.filter((violation) =>
        ["serious", "critical"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  });

  it("keeps the compile context immutable when page filters later change", async () => {
    mocks.compileSegmentFromText.mockResolvedValue({
      data: {
        ast: {
          op: "condition",
          field: "tag",
          comparator: "equals",
          value: "vip",
        },
        engine_used: "rules",
        suggested_name: "Frozen VIPs",
      },
    });
    const onSaved = vi.fn();
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="subscribed"
        query=""
        onSaved={onSaved}
      />,
    );
    setInput("Natural language segment description", "VIP readers");
    click("Build with rules");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Compile context is frozen");
    });

    act(() =>
      root?.render(
        <StrictMode>
          <SubscriberNaturalLanguageSegmentPanel
            canMutate
            status="bounced"
            query="@new.example"
            onSaved={onSaved}
          />
        </StrictMode>,
      ),
    );
    expect(document.body.textContent).toContain(
      "Directory changed; draft stayed frozen",
    );
    expect(document.body.textContent).toContain("Status · subscribed");
    expect(document.body.textContent).not.toContain("Search · @new.example");

    click("Save exact segment");
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(mocks.segmentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        queryAst: expect.objectContaining({
          op: "and",
        }),
      }),
    );
  });

  it("keeps inherited Directory status visibly locked while compiled leaves remain removable", async () => {
    mocks.compileSegmentFromText.mockResolvedValue({
      data: {
        ast: {
          op: "condition",
          field: "tag",
          comparator: "equals",
          value: "vip",
        },
        engine_used: "rules",
        suggested_name: "VIP subscribers",
      },
    });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="subscribed"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "tagged vip");
    click("Build with rules");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Locked context");
    });

    const removeButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Remove condition:"]',
      ),
    );
    expect(removeButtons).toHaveLength(1);
    expect(removeButtons[0]?.getAttribute("aria-label")).toContain("tag");
    act(() => removeButtons[0]?.click());
    await waitFor(() => {
      expect(
        document.querySelectorAll('button[aria-label^="Remove condition:"]'),
      ).toHaveLength(0);
    });
    expect(document.body.textContent).toContain("Mailchimp Status");
    expect(document.body.textContent).toContain("Locked context");
  });

  it("requires rebuild when the source description changes after compile", async () => {
    mocks.compileSegmentFromText.mockResolvedValue({
      data: {
        ast: {
          op: "condition",
          field: "tag",
          comparator: "equals",
          value: "vip",
        },
        engine_used: "rules",
        suggested_name: "VIP subscribers",
      },
    });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "tagged vip");
    click("Build with rules");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Save exact segment");
    });
    setInput("Natural language segment description", "tagged trial");

    expect(document.body.textContent).toContain(
      "Description changed; rebuild before save",
    );
    const save = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Save exact segment");
    expect(save?.getAttribute("aria-disabled")).toBe("true");
    act(() => save?.click());
    expect(mocks.segmentCreate).not.toHaveBeenCalled();
  });

  it("fails closed until aggregate preview succeeds", async () => {
    mocks.previewCompiledSegment.mockResolvedValueOnce({
      error: { kind: "network", message: "offline" },
    });
    mocks.compileSegmentFromText.mockResolvedValue({
      data: {
        ast: {
          op: "condition",
          field: "tag",
          comparator: "equals",
          value: "vip",
        },
        engine_used: "rules",
        suggested_name: "VIP subscribers",
      },
    });
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "tagged vip");
    click("Build with rules");
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "cannot be saved until a fresh aggregate preview succeeds",
      );
    });
    const save = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent === "Save exact segment");
    act(() => save?.click());
    expect(mocks.segmentCreate).not.toHaveBeenCalled();

    mocks.previewCompiledSegment.mockResolvedValueOnce({
      data: {
        count: 24,
        workspace_total: 100,
        workspace_percentage: 24,
        generated_at: "2026-07-18T12:00:00Z",
        archive_scope: "active_only",
        applied_exclusions: ["archived_profiles"],
      },
    });
    click("Retry preview");
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "24 matching active profiles",
      );
    });
    click("Save exact segment");
    await waitFor(() => expect(mocks.segmentCreate).toHaveBeenCalledTimes(1));
  });

  it("never restores a cleared AST when an older compile resolves late", async () => {
    const late = deferred<{
      data: {
        ast: {
          op: "condition";
          field: string;
          comparator: "equals";
          value: string;
        };
        engine_used: "rules";
      };
    }>();
    mocks.compileSegmentFromText
      .mockResolvedValueOnce({
        data: {
          ast: {
            op: "condition",
            field: "old_segment",
            comparator: "equals",
            value: "yes",
          },
          engine_used: "rules",
        },
      })
      .mockReturnValueOnce(late.promise);
    render(
      <SubscriberNaturalLanguageSegmentPanel
        canMutate
        status="all"
        query=""
        onSaved={vi.fn()}
      />,
    );
    setInput("Natural language segment description", "first query");
    click("Build with rules");
    await waitFor(() => {
      expect(document.body.textContent).toContain("Old Segment");
    });

    setInput("Natural language segment description", "second query");
    click("Build with rules");
    await waitFor(() =>
      expect(mocks.compileSegmentFromText).toHaveBeenCalledTimes(2),
    );
    click("Discard draft");
    const pendingOptions = mocks.compileSegmentFromText.mock.calls[1]?.[1] as
      | { signal?: AbortSignal }
      | undefined;
    expect(pendingOptions?.signal?.aborted).toBe(true);
    await act(async () => {
      late.resolve({
        data: {
          ast: {
            op: "condition",
            field: "previous_subscriber_secret",
            comparator: "equals",
            value: "yes",
          },
          engine_used: "rules",
        },
      });
      await late.promise;
    });

    expect(document.body.textContent).not.toContain("Old Segment");
    expect(document.body.textContent).not.toContain(
      "previous_subscriber_secret",
    );
  });
});
