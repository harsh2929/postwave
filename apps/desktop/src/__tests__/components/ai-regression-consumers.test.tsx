// @vitest-environment happy-dom

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
  archiveGoldenExample: vi.fn(),
  captureGoldenExample: vi.fn(),
  getLatestRegressionRun: vi.fn(),
  getRegressionRunResults: vi.fn(),
  getRegressionSettings: vi.fn(),
  listGoldenExamples: vi.fn(),
  listRegressionRuns: vi.fn(),
  triggerRegressionRun: vi.fn(),
  updateRegressionSettings: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: mocks,
}));

import { AIRegressionSettings } from "../../components/ai/AIRegressionSettings";
import { ModelChangelogPanel } from "../../components/ai/ModelChangelogPanel";
import { VoiceRegressionBadge } from "../../components/ai/VoiceRegressionBadge";
import {
  discardAndRecheckLifecycleTransition,
  getLifecycleDecisionState,
  inspectLifecycle,
  prepareLifecycle,
  requestLifecycleTransition,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

const SETTINGS = {
  warn_threshold: 60,
  hard_gate_enabled: false,
  hard_gate_threshold: 70,
  min_examples_for_gate: 5,
};
const UUID_PATTERN_FOR_TEST =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const GOLDEN = {
  id: "golden-1",
  surface_kind: "campaign_draft",
  brief: "Announce the launch",
  model_id: "model-v1",
  created_at: "2026-07-16T08:00:00.000Z",
};

const PENDING_RUN = {
  id: "run-1",
  runtime_provider: "google",
  model_id: "model-1",
  model_version_tag: "model-v2",
  prompt_version_tag: "prompt-v1",
  status: "pending" as const,
  total_examples: 5,
  passed_examples: 0,
  scored_examples: 0,
  error_examples: 0,
  warn_threshold: 60,
  hard_gate_enabled: false,
  min_examples_for_gate: 5,
  max_attempts: 3,
  created_at: "2026-07-16T08:00:00.000Z",
  snapshot_frozen_at: "2026-07-16T08:00:00.000Z",
  attempt_count: 0,
  updated_at: "2026-07-16T08:00:00.000Z",
};

const COMPLETED_RUN = {
  ...PENDING_RUN,
  status: "completed" as const,
  passed_examples: 5,
  scored_examples: 5,
  error_examples: 0,
  fidelity_score_mean: 84,
  fidelity_score_p25: 79,
  gate_result: "pass" as const,
  completed_at: "2026-07-16T08:01:00.000Z",
  attempt_count: 1,
  updated_at: "2026-07-16T08:01:00.000Z",
  by_surface: {
    campaign_draft: {
      total: 4,
      scored: 4,
      errors: 0,
      passed: 4,
      mean_score: 81.5,
      gate_result: "pass" as const,
    },
    subject_line: {
      total: 1,
      scored: 1,
      errors: 0,
      passed: 1,
      mean_score: 84,
      gate_result: "pass" as const,
    },
  },
};

const SCORED_RESULTS = Array.from({ length: 5 }, (_, index) => ({
  id: `result-${index + 1}`,
  attempt_count: 1,
  surface_kind: index === 4 ? "subject_line" : "campaign_draft",
  fidelity_score: 80 + index,
  breakdown: {
    embedding_similarity: 0.9,
    stylistic_distance: 0.9,
    vocabulary_overlap: 0.8,
    structural_match: 0.85,
    combined: 80 + index,
  },
  severity: "ok" as const,
  replayed_output:
    index === 0
      ? "Launch day is here <script>literal evidence</script> 🚀"
      : `Approved replay output ${index + 1}`,
  ...(index === 0
    ? {
        example_id: "golden-1",
        brief: "Announce the launch with a concise, warm campaign.",
        source_model_id: "model-1",
        voice_profile_version: "voice-profile-42",
        approved_output:
          "Frozen approved truth <strong>literal markup</strong> — café 你好 🚀",
        approval_id: "approval-1",
        agent_run_id: "agent-run-1",
        source_created_at: "2026-07-15T09:00:00.000Z",
        snapshotted_at: "2026-07-16T08:00:00.000Z",
        snapshot_ordinal: 1,
      }
    : {}),
  scored_at: "2026-07-16T08:01:00.000Z",
}));

const QUIT_INTENT: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
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
  vi.clearAllMocks();
  mocks.getRegressionSettings.mockResolvedValue({ data: SETTINGS });
  mocks.listGoldenExamples.mockResolvedValue({ data: { items: [GOLDEN] } });
  mocks.updateRegressionSettings.mockResolvedValue({ data: SETTINGS });
  mocks.triggerRegressionRun.mockResolvedValue({
    data: {
      run_id: "5ec56b6a-7931-4b77-8505-61137a851dc8",
      status: "pending",
      runtime: {
        provider: "google",
        model_id: "model-1",
        prompt_policy_version: "prompt-v1",
      },
    },
  });
  mocks.captureGoldenExample.mockResolvedValue({ data: GOLDEN });
  mocks.archiveGoldenExample.mockResolvedValue({ data: undefined });
  mocks.listRegressionRuns.mockResolvedValue({
    data: { items: [COMPLETED_RUN] },
  });
  mocks.getRegressionRunResults.mockResolvedValue({ data: { items: [] } });
  mocks.getLatestRegressionRun.mockResolvedValue({
    data: { run: COMPLETED_RUN },
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
  resetLifecycleCoordinatorForTests();
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
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

function button(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim() === text,
    ) ?? null
  );
}

function click(element: Element | null): void {
  expect(element).not.toBeNull();
  act(() => (element as HTMLElement).click());
}

function setControlValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AI regression renderer consumers", () => {
  it("blocks writable fallback settings after load failure and supports an honest retry", async () => {
    mocks.getRegressionSettings
      .mockReset()
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "Settings unavailable" },
      })
      .mockResolvedValueOnce({ data: SETTINGS });

    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Settings unavailable"),
    );

    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.body.textContent).toContain("Announce the launch");
    expect(mocks.updateRegressionSettings).not.toHaveBeenCalled();

    click(button("Retry settings"));
    await waitFor(() =>
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
    );
    expect(mocks.getRegressionSettings).toHaveBeenCalledTimes(2);
  });

  it("keeps golden evidence readable for non-admins without calling admin endpoints", async () => {
    render(<AIRegressionSettings canAdmin={false} />);
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="golden-example-row"]'),
      ).toHaveLength(1),
    );

    expect(document.body.textContent).toContain(
      "Read-only regression evidence",
    );
    expect(document.body.textContent).toContain("Golden reference set");
    expect(mocks.listGoldenExamples).toHaveBeenCalledWith({ limit: 200 });
    expect(mocks.getRegressionSettings).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(button("Archive")).toBeNull();
    expect(mocks.updateRegressionSettings).not.toHaveBeenCalled();
    expect(mocks.triggerRegressionRun).not.toHaveBeenCalled();
    expect(mocks.captureGoldenExample).not.toHaveBeenCalled();
    expect(mocks.archiveGoldenExample).not.toHaveBeenCalled();
  });

  it("does not expose a stale settings baseline after viewer-to-admin reload failure", async () => {
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
    );

    act(() => root?.render(<AIRegressionSettings canAdmin={false} />));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Read-only regression evidence",
      ),
    );
    mocks.getRegressionSettings.mockResolvedValueOnce({
      error: {
        kind: "http",
        status: 503,
        message: "Fresh policy snapshot unavailable",
      },
    });

    act(() => root?.render(<AIRegressionSettings canAdmin />));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Fresh policy snapshot unavailable",
      ),
    );
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(mocks.updateRegressionSettings).not.toHaveBeenCalled();
  });

  it("edits the minimum scored-example policy and exposes eligibility limits", async () => {
    render(<AIRegressionSettings canAdmin />);
    const minimum = await (async (): Promise<HTMLInputElement> => {
      await waitFor(() =>
        expect(
          document.querySelector(
            'input[aria-label="Minimum scored examples for policy evaluation"]',
          ),
        ).not.toBeNull(),
      );
      return document.querySelector<HTMLInputElement>(
        'input[aria-label="Minimum scored examples for policy evaluation"]',
      )!;
    })();

    expect(document.body.textContent).toContain("1 active references loaded");
    expect(document.body.textContent).toContain(
      "below the configured minimum by 4 references",
    );
    expect(minimum.getAttribute("max")).toBe("2147483647");
    setControlValue(minimum, "8");
    act(() => {
      minimum.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", bubbles: true }),
      );
    });
    await waitFor(() =>
      expect(mocks.updateRegressionSettings).toHaveBeenCalledWith({
        ...SETTINGS,
        min_examples_for_gate: 8,
      }),
    );
  });

  it("bounds the operator correlation label without presenting it as runtime identity", async () => {
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(
        document.querySelector(
          'input[aria-label="Operator correlation label"]',
        ),
      ).not.toBeNull(),
    );

    expect(
      document
        .querySelector('input[aria-label="Operator correlation label"]')
        ?.getAttribute("maxlength"),
    ).toBe("160");
    expect(document.body.textContent).toContain("160 character limit");
    expect(document.body.textContent).toContain(
      "label neither selects nor attests a model",
    );
    expect(document.body.textContent).toContain(
      "server-attested runtime identity",
    );
    expect(document.body.textContent).not.toContain(
      "Submit a model version identity",
    );
    expect(document.body.textContent).toContain(
      "scores replayed output against the qualified voice profile",
    );
    expect(document.body.textContent).toContain(
      "not against this approved text",
    );
  });

  it("serializes overlapping setting changes so the newest value reaches the server last", async () => {
    const first = deferred<{ data: typeof SETTINGS }>();
    const second = deferred<{ data: typeof SETTINGS }>();
    mocks.updateRegressionSettings
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
    );

    click(document.querySelector('input[type="checkbox"]'));
    await waitFor(() =>
      expect(mocks.updateRegressionSettings).toHaveBeenCalledTimes(1),
    );
    click(document.querySelector('input[type="checkbox"]'));
    expect(mocks.updateRegressionSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve({ data: { ...SETTINGS, hard_gate_enabled: true } });
      await first.promise;
    });
    await waitFor(() =>
      expect(mocks.updateRegressionSettings).toHaveBeenCalledTimes(2),
    );
    expect(mocks.updateRegressionSettings).toHaveBeenNthCalledWith(2, SETTINGS);
    expect(document.body.textContent).toContain("Saving newer settings…");
    expect(document.body.textContent).not.toContain("Settings saved.");
    expect(
      document
        .querySelector('[data-testid="ai-regression-settings-status"]')
        ?.getAttribute("data-tone"),
    ).toBe("info");

    await act(async () => {
      second.resolve({ data: SETTINGS });
      await second.promise;
    });
    await waitFor(() =>
      expect(
        (document.querySelector('input[type="checkbox"]') as HTMLInputElement)
          .checked,
      ).toBe(false),
    );
    expect(document.body.textContent).toContain("Settings saved.");
    expect(
      document
        .querySelector('[data-testid="ai-regression-settings-status"]')
        ?.getAttribute("data-tone"),
    ).toBe("success");
  });

  it("does not start a queued settings PUT after an admin-to-viewer downgrade", async () => {
    const first = deferred<{ data: typeof SETTINGS }>();
    mocks.updateRegressionSettings.mockReset().mockReturnValue(first.promise);
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
    );
    click(document.querySelector('input[type="checkbox"]'));
    await waitFor(() =>
      expect(mocks.updateRegressionSettings).toHaveBeenCalledTimes(1),
    );
    click(document.querySelector('input[type="checkbox"]'));

    act(() => root?.render(<AIRegressionSettings canAdmin={false} />));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Read-only regression evidence",
      ),
    );
    await act(async () => {
      first.resolve({ data: { ...SETTINGS, hard_gate_enabled: true } });
      await first.promise;
      await Promise.resolve();
    });
    expect(mocks.updateRegressionSettings).toHaveBeenCalledTimes(1);
    await expect(inspectLifecycle(QUIT_INTENT)).resolves.toMatchObject([
      {
        label: "AI regression settings",
        canSave: false,
        canDiscard: true,
      },
    ]);
  });

  it("lets lifecycle Save await the exact queued settings drain", async () => {
    const pending = deferred<{ data: typeof SETTINGS }>();
    mocks.updateRegressionSettings.mockReset().mockReturnValue(pending.promise);
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
    );

    click(document.querySelector('input[type="checkbox"]'));
    await waitFor(() =>
      expect(mocks.updateRegressionSettings).toHaveBeenCalledTimes(1),
    );
    await expect(inspectLifecycle(QUIT_INTENT)).resolves.toMatchObject([
      {
        label: "AI regression settings",
        canSave: true,
        canDiscard: false,
      },
    ]);

    let prepared = false;
    const preparation = prepareLifecycle(QUIT_INTENT).then(() => {
      prepared = true;
    });
    await Promise.resolve();
    expect(prepared).toBe(false);

    await act(async () => {
      pending.resolve({ data: { ...SETTINGS, hard_gate_enabled: true } });
      await preparation;
    });
    expect(prepared).toBe(true);
    await expect(inspectLifecycle(QUIT_INTENT)).resolves.toEqual([]);
  });

  it("finishes the newest queued settings write after the surface unmounts", async () => {
    const first = deferred<{ data: typeof SETTINGS }>();
    const second = deferred<{ data: typeof SETTINGS }>();
    mocks.updateRegressionSettings
      .mockReset()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
    );
    click(document.querySelector('input[type="checkbox"]'));
    await waitFor(() =>
      expect(mocks.updateRegressionSettings).toHaveBeenCalledTimes(1),
    );
    click(document.querySelector('input[type="checkbox"]'));

    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    await act(async () => {
      first.resolve({ data: { ...SETTINGS, hard_gate_enabled: true } });
      await first.promise;
    });
    await waitFor(() =>
      expect(mocks.updateRegressionSettings).toHaveBeenCalledTimes(2),
    );
    expect(mocks.updateRegressionSettings).toHaveBeenNthCalledWith(2, SETTINGS);
    second.resolve({ data: SETTINGS });
    await second.promise;
  });

  it("retains a failed settings draft until explicit lifecycle discard", async () => {
    mocks.updateRegressionSettings.mockResolvedValue({
      error: { kind: "http", status: 503, message: "Save unavailable" },
    });
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
    );
    click(document.querySelector('input[type="checkbox"]'));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Save unavailable"),
    );

    expect(
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    await expect(inspectLifecycle(QUIT_INTENT)).resolves.toMatchObject([
      {
        label: "AI regression settings",
        level: "blocking",
        canDiscard: true,
      },
    ]);

    const proceeded = vi.fn();
    const transition = requestLifecycleTransition(QUIT_INTENT, proceeded);
    await waitFor(() =>
      expect(getLifecycleDecisionState().phase).toBe("review"),
    );
    await act(async () => {
      await discardAndRecheckLifecycleTransition();
      await transition;
    });
    expect(proceeded).toHaveBeenCalledTimes(1);
    expect(
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it("does not fabricate a settings acknowledgement from an empty success body", async () => {
    mocks.updateRegressionSettings.mockResolvedValue({ data: undefined });
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.querySelector('input[type="checkbox"]')).not.toBeNull(),
    );

    click(document.querySelector('input[type="checkbox"]'));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "server returned no settings acknowledgement",
      ),
    );
    expect(document.body.textContent).not.toContain("Settings saved.");
    expect(
      document
        .querySelector('[data-testid="ai-regression-settings-status"]')
        ?.getAttribute("data-tone"),
    ).toBe("danger");
    expect(
      (document.querySelector('input[type="checkbox"]') as HTMLInputElement)
        .checked,
    ).toBe(true);
    await expect(inspectLifecycle(QUIT_INTENT)).resolves.toMatchObject([
      {
        label: "AI regression settings",
        level: "blocking",
        canDiscard: true,
      },
    ]);
  });

  it("never auto-submits replay or golden drafts from lifecycle review", async () => {
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(
        document.querySelector('textarea[aria-label="Golden example brief"]'),
      ).not.toBeNull(),
    );
    const brief = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Golden example brief"]',
    )!;
    const model = document.querySelector<HTMLInputElement>(
      'input[aria-label="Operator correlation label"]',
    )!;
    setControlValue(brief, "A locally authored reference brief");
    setControlValue(model, "model-candidate-v2");

    await expect(inspectLifecycle(QUIT_INTENT)).resolves.toMatchObject([
      {
        label: "AI regression draft",
        canSave: false,
        canDiscard: true,
      },
    ]);
    expect(mocks.captureGoldenExample).not.toHaveBeenCalled();
    expect(mocks.triggerRegressionRun).not.toHaveBeenCalled();

    const proceeded = vi.fn();
    const transition = requestLifecycleTransition(QUIT_INTENT, proceeded);
    await waitFor(() =>
      expect(getLifecycleDecisionState().phase).toBe("review"),
    );
    await act(async () => {
      await discardAndRecheckLifecycleTransition();
      await transition;
    });
    expect(brief.value).toBe("");
    expect(model.value).toBe("");
    expect(mocks.captureGoldenExample).not.toHaveBeenCalled();
    expect(mocks.triggerRegressionRun).not.toHaveBeenCalled();
  });

  it("retains a guarded local draft across an admin-to-read-only downgrade", async () => {
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(
        document.querySelector('textarea[aria-label="Golden example brief"]'),
      ).not.toBeNull(),
    );
    setControlValue(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Golden example brief"]',
      )!,
      "Retain this draft through a role refresh",
    );

    act(() => root?.render(<AIRegressionSettings canAdmin={false} />));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Read-only regression evidence",
      ),
    );
    await expect(inspectLifecycle(QUIT_INTENT)).resolves.toMatchObject([
      {
        label: "AI regression draft",
        canSave: false,
        canDiscard: true,
      },
    ]);
    expect(mocks.updateRegressionSettings).not.toHaveBeenCalled();
    expect(mocks.captureGoldenExample).not.toHaveBeenCalled();

    click(button("Discard retained draft"));
    expect(document.body.textContent).toContain("Discard AI regression draft?");
    click(button("Discard draft"));
    await expect(inspectLifecycle(QUIT_INTENT)).resolves.toEqual([]);
  });

  it("rejects a malformed replay acceptance receipt and retains the operator correlation label", async () => {
    mocks.triggerRegressionRun.mockResolvedValue({ data: undefined });
    render(<AIRegressionSettings canAdmin />);
    const model = await (async (): Promise<HTMLInputElement> => {
      await waitFor(() =>
        expect(
          document.querySelector(
            'input[aria-label="Operator correlation label"]',
          ),
        ).not.toBeNull(),
      );
      return document.querySelector<HTMLInputElement>(
        'input[aria-label="Operator correlation label"]',
      )!;
    })();
    setControlValue(model, "candidate-release-42");
    click(button("Request replay"));

    await waitFor(() =>
      expect(document.body.textContent).toContain("invalid replay receipt"),
    );
    expect(model.value).toBe("candidate-release-42");
    expect(document.body.textContent).not.toContain(
      "Replay request accepted as pending",
    );
    expect(document.body.textContent).toContain(
      "keep the operator correlation label",
    );
  });

  it("keeps the operator label separate from the server-attested runtime receipt", async () => {
    render(<AIRegressionSettings canAdmin />);
    const label = await (async (): Promise<HTMLInputElement> => {
      await waitFor(() =>
        expect(
          document.querySelector(
            'input[aria-label="Operator correlation label"]',
          ),
        ).not.toBeNull(),
      );
      return document.querySelector<HTMLInputElement>(
        'input[aria-label="Operator correlation label"]',
      )!;
    })();
    setControlValue(label, "release-correlation-42");
    click(button("Request replay"));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Server-attested runtime receipt",
      ),
    );
    expect(mocks.triggerRegressionRun).toHaveBeenCalledWith({
      model_version_tag: "release-correlation-42",
    });
    expect(label.value).toBe("");
    const isolatedStatusText = document
      .querySelector('[data-testid="ai-regression-settings-status"]')
      ?.textContent?.replace(/[\u2068\u2069]/gu, "");
    expect(isolatedStatusText).toContain("provider google");
    expect(isolatedStatusText).toContain("model ID model-1");
    expect(isolatedStatusText).toContain("prompt policy prompt-v1");
    expect(
      document
        .querySelector('[data-testid="ai-regression-settings-status"]')
        ?.getAttribute("data-tone"),
    ).toBe("success");
  });

  it("reconciles a capture against a fresh canonical corpus when the initial list is still pending", async () => {
    const initial = deferred<{ data: { items: [typeof GOLDEN] } }>();
    const canonical = deferred<{ data: { items: [typeof GOLDEN] } }>();
    const captured = {
      ...GOLDEN,
      id: "golden-2",
      brief: "Newly captured reference",
    };
    mocks.listGoldenExamples
      .mockReset()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(canonical.promise);
    mocks.captureGoldenExample.mockResolvedValue({ data: captured });
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(mocks.listGoldenExamples).toHaveBeenCalledTimes(1),
    );

    setControlValue(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Golden example brief"]',
      )!,
      "Newly captured reference",
    );
    setControlValue(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Golden example approved output"]',
      )!,
      "Approved new output",
    );
    click(button("Save golden reference"));
    await waitFor(() =>
      expect(mocks.listGoldenExamples).toHaveBeenCalledTimes(2),
    );
    expect(
      document.querySelector('[aria-label="Loading golden references"]'),
    ).not.toBeNull();

    await act(async () => {
      initial.resolve({ data: { items: [GOLDEN] } });
      await initial.promise;
    });
    expect(
      document.querySelector('[aria-label="Loading golden references"]'),
    ).not.toBeNull();

    await act(async () => {
      canonical.resolve({ data: { items: [GOLDEN] } });
      await canonical.promise;
    });
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="golden-example-row"]'),
      ).toHaveLength(2),
    );
    expect(document.body.textContent).toContain("Newly captured reference");
    expect(document.body.textContent).toContain("Announce the launch");
  });

  it("retains a golden-reference form when a success response has no receipt", async () => {
    mocks.captureGoldenExample.mockResolvedValue({ data: undefined });
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(
        document.querySelector('textarea[aria-label="Golden example brief"]'),
      ).not.toBeNull(),
    );
    const brief = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Golden example brief"]',
    )!;
    const output = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Golden example approved output"]',
    )!;
    setControlValue(brief, "Retain this brief");
    setControlValue(output, "Retain this approved output");
    click(button("Save golden reference"));

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "server returned no golden-reference receipt",
      ),
    );
    expect(brief.value).toBe("Retain this brief");
    expect(output.value).toBe("Retain this approved output");
    expect(document.body.textContent).not.toContain("Golden reference saved.");
  });

  it("reuses one capture request id across an ambiguous manual retry", async () => {
    mocks.captureGoldenExample
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          message: "Capture receipt was lost",
        },
      })
      .mockResolvedValueOnce({ data: GOLDEN });
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(
        document.querySelector('textarea[aria-label="Golden example brief"]'),
      ).not.toBeNull(),
    );
    setControlValue(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Golden example brief"]',
      )!,
      "Retry this exact brief",
    );
    setControlValue(
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Golden example approved output"]',
      )!,
      "Retry this exact approved output",
    );

    click(button("Save golden reference"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Capture receipt was lost"),
    );
    click(button("Save golden reference"));
    await waitFor(() =>
      expect(mocks.captureGoldenExample).toHaveBeenCalledTimes(2),
    );
    const firstRequest = mocks.captureGoldenExample.mock.calls[0]?.[0];
    const secondRequest = mocks.captureGoldenExample.mock.calls[1]?.[0];
    expect(firstRequest?.request_id).toMatch(UUID_PATTERN_FOR_TEST);
    expect(secondRequest?.request_id).toBe(firstRequest?.request_id);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Golden reference saved."),
    );
  });

  it("does not translate a missing golden-list envelope into an empty corpus", async () => {
    mocks.listGoldenExamples.mockResolvedValue({ data: undefined });
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "invalid golden-reference receipt",
      ),
    );
    expect(document.body.textContent).not.toContain("No golden references yet");
    expect(document.body.textContent).toContain(
      "Active reference count unavailable",
    );
  });

  it("loads the bounded golden set and archives only after in-app confirmation", async () => {
    const longBrief = `Sensitive brief ${"x".repeat(4000)}`;
    mocks.listGoldenExamples.mockResolvedValue({
      data: { items: [{ ...GOLDEN, brief: longBrief }] },
    });
    render(<AIRegressionSettings canAdmin />);
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="golden-example-row"]'),
      ).toHaveLength(1),
    );

    expect(mocks.listGoldenExamples).toHaveBeenCalledWith({ limit: 200 });
    const archive = button("Archive");
    expect(archive?.getAttribute("aria-label")).toBe(
      "Archive golden reference 1",
    );
    expect(archive?.getAttribute("aria-label")?.length).toBeLessThan(80);
    const briefDisclosure = document.querySelector<HTMLDetailsElement>(
      ".ai-regression-settings__brief",
    );
    click(briefDisclosure?.querySelector("summary") ?? null);
    const briefPane = briefDisclosure?.querySelector("p");
    expect(briefPane?.getAttribute("tabindex")).toBe("0");
    expect(briefPane?.getAttribute("dir")).toBe("auto");
    expect(briefPane?.classList.contains("ai-regression-forensic-block")).toBe(
      true,
    );
    click(archive);
    expect(mocks.archiveGoldenExample).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Archive golden reference?");
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent ?? "",
    ).not.toContain(longBrief);

    click(button("Archive reference"));
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="golden-example-row"]'),
      ).toHaveLength(0),
    );
    expect(mocks.archiveGoldenExample).toHaveBeenCalledWith("golden-1");
    expect(document.body.textContent).toContain("Golden reference archived.");
  });

  it("polls an in-flight changelog run, labels it honestly, and exposes completed details", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:05:00.000Z"));
    mocks.listRegressionRuns
      .mockReset()
      .mockResolvedValueOnce({ data: { items: [PENDING_RUN] } })
      .mockResolvedValueOnce({ data: { items: [COMPLETED_RUN] } });
    mocks.getRegressionRunResults.mockResolvedValue({
      data: { items: SCORED_RESULTS },
    });

    render(<ModelChangelogPanel />);
    await waitFor(() => expect(document.body.textContent).toContain("Queued"));
    expect(mocks.listRegressionRuns).toHaveBeenCalledWith({ limit: 200 });
    const disclosure = button("Review evidence");
    expect(disclosure?.getAttribute("aria-expanded")).toBe("false");
    const regionId = disclosure?.getAttribute("aria-controls");
    expect(regionId).toBeTruthy();
    click(disclosure);
    expect(disclosure?.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(regionId!)).not.toBeNull();
    expect(document.getElementById(regionId!)?.getAttribute("role")).toBe(
      "region",
    );

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("Recorded pass"),
    );
    expect(document.body.textContent).toContain(
      "Operator correlation label: model-v2",
    );
    expect(document.body.textContent).toContain(
      "Server-attested provider: google",
    );
    expect(document.body.textContent).toContain(
      "Server-attested model ID: model-1",
    );
    expect(document.body.textContent).toContain(
      "Server-attested prompt policy: prompt-v1",
    );

    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Launch day is here <script>literal evidence</script> 🚀",
      ),
    );
    expect(mocks.getRegressionRunResults).toHaveBeenCalledWith("run-1");
    expect(document.body.textContent).toContain("Lower-quartile score (p25)");
    expect(document.body.textContent).toContain("Mean-based; p25 is context");
    expect(document.body.textContent).toContain("Advisory mode");
    const outputDisclosure = document.querySelector<HTMLDetailsElement>(
      ".ai-evidence-output",
    );
    expect(outputDisclosure).not.toBeNull();
    expect(
      outputDisclosure?.querySelector("summary")?.getAttribute("title"),
    ).toBeNull();
    expect(
      outputDisclosure?.querySelector("summary")?.getAttribute("aria-label")
        ?.length,
    ).toBeLessThan(80);
    click(outputDisclosure?.querySelector("summary") ?? null);
    expect(outputDisclosure?.open).toBe(true);
    expect(outputDisclosure?.querySelector("pre")?.textContent).toContain(
      "<strong>literal markup</strong> — café 你好 🚀",
    );
    expect(outputDisclosure?.textContent).toContain(
      "Launch day is here <script>literal evidence</script> 🚀",
    );
    expect(outputDisclosure?.querySelectorAll("pre")).toHaveLength(2);
    expect(outputDisclosure?.querySelector("pre strong")).toBeNull();
    expect(outputDisclosure?.querySelector("pre script")).toBeNull();
    expect(
      Array.from(outputDisclosure?.querySelectorAll("pre") ?? []).every(
        (pane) =>
          pane.getAttribute("tabindex") === "0" &&
          pane.getAttribute("dir") === "auto" &&
          pane.classList.contains("ai-regression-forensic-block"),
      ),
    ).toBe(true);
    expect(
      Array.from(document.querySelectorAll("th"), (heading) =>
        heading.textContent?.trim(),
      ),
    ).toContain("Receipt recorded");
    expect(document.body.textContent).not.toContain("Scored at");
    expect(
      document.querySelector(
        'table[aria-label="Per-example regression results"]',
      ),
    ).not.toBeNull();
    const scoreExplanation = document.querySelector<HTMLDetailsElement>(
      ".ai-evidence-score-explanation",
    );
    expect(scoreExplanation).not.toBeNull();
    click(scoreExplanation?.querySelector("summary") ?? null);
    expect(scoreExplanation?.textContent).toContain("Stylistic match90%");
    expect(scoreExplanation?.textContent).not.toContain("Stylistic match10%");
    expect(scoreExplanation?.textContent).toContain(
      "Voice-profile fidelity diagnostics—not similarity",
    );
    const provenance = document.querySelector<HTMLDetailsElement>(
      ".ai-evidence-provenance",
    );
    expect(provenance).not.toBeNull();
    expect(
      provenance?.querySelector("summary")?.getAttribute("aria-label")?.length,
    ).toBeLessThan(80);
    click(provenance?.querySelector("summary") ?? null);
    expect(provenance?.textContent).toContain(
      "does not describe the current mutable golden reference",
    );
    expect(provenance?.textContent).toContain("approval-1");
    expect(provenance?.textContent).toContain("voice-profile-42");
    expect(
      Array.from(
        provenance?.querySelectorAll("bdi.ai-regression-forensic") ?? [],
        (value) => value.textContent,
      ),
    ).toEqual(
      expect.arrayContaining([
        "model-1",
        "voice-profile-42",
        "approval-1",
        "agent-run-1",
      ]),
    );
    expect(provenance?.textContent).toContain(
      "Announce the launch with a concise, warm campaign.",
    );
    expect(
      provenance?.querySelector(".ai-evidence-provenance__brief pre"),
    ).not.toBeNull();
    expect(
      provenance
        ?.querySelector(".ai-evidence-provenance__brief pre")
        ?.getAttribute("dir"),
    ).toBe("auto");
  });

  it("renders the full lifecycle matrix without turning freshness into a server status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:05:00.000Z"));
    mocks.listRegressionRuns.mockResolvedValue({
      data: {
        items: [
          {
            ...PENDING_RUN,
            id: "queued",
            created_at: "2026-07-16T08:00:00.000Z",
          },
          {
            ...PENDING_RUN,
            id: "running",
            status: "running",
            started_at: "2026-07-16T08:04:00.000Z",
          },
          {
            ...PENDING_RUN,
            id: "stale",
            created_at: "2026-07-16T07:00:00.000Z",
            updated_at: "2026-07-16T07:00:00.000Z",
          },
          {
            ...PENDING_RUN,
            id: "failed",
            status: "failed",
            error_message: "Worker receipt recorded a failure",
          },
          {
            ...COMPLETED_RUN,
            id: "incomplete",
            passed_examples: 4,
            scored_examples: 4,
            error_examples: 1,
            gate_result: "pass",
          },
          {
            ...COMPLETED_RUN,
            id: "unscored",
            passed_examples: 0,
            scored_examples: 0,
            error_examples: 5,
            fidelity_score_mean: undefined,
            gate_result: "advisory",
            by_surface: {
              campaign_draft: {
                total: 5,
                scored: 0,
                errors: 5,
                passed: 0,
                mean_score: null,
                gate_result: "advisory",
              },
            },
          },
          { ...COMPLETED_RUN, id: "completed" },
        ],
      },
    });

    render(<ModelChangelogPanel />);
    await waitFor(() =>
      expect(
        document.querySelectorAll('[data-testid="model-changelog-run"]'),
      ).toHaveLength(7),
    );
    for (const state of [
      "queued",
      "running",
      "stale",
      "failed",
      "incomplete",
      "unscored",
      "completed",
    ]) {
      expect(
        document.querySelector(`[data-evidence-state="${state}"]`),
      ).not.toBeNull();
    }
    expect(document.body.textContent).toContain(
      "Server-reported queued or running",
    );
    expect(document.body.textContent).toContain(
      "Server lease expiry or client-age fallback",
    );
    expect(document.body.textContent).not.toContain("upgrade was blocked");
    expect(document.body.textContent).not.toContain("will be blocked");
    expect(
      document.querySelector('[data-evidence-state="incomplete"]')?.textContent,
    ).not.toContain("Recorded pass");
    expect(
      document.querySelector('[data-evidence-state="incomplete"]')?.textContent,
    ).not.toContain("Recorded advisory");
    expect(
      document
        .querySelector('[data-evidence-state="failed"]')
        ?.querySelector('[role="alert"]'),
    ).toBeNull();
  });

  it("does not announce background changelog polling as a user refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:05:00.000Z"));
    const background = deferred<{
      data: { items: (typeof COMPLETED_RUN)[] };
    }>();
    mocks.listRegressionRuns
      .mockReset()
      .mockResolvedValueOnce({ data: { items: [PENDING_RUN] } })
      .mockReturnValueOnce(background.promise);
    render(<ModelChangelogPanel />);
    await waitFor(() => expect(document.body.textContent).toContain("Queued"));

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.listRegressionRuns).toHaveBeenCalledTimes(2),
    );
    expect(document.body.textContent).not.toContain(
      "Refreshing evidence; the current snapshot remains visible",
    );
    expect(document.querySelector(".ai-evidence-refresh-status")).toBeNull();

    await act(async () => {
      background.resolve({ data: { items: [COMPLETED_RUN] } });
      await background.promise;
    });
  });

  it("coalesces a background poll into an unresolved manual changelog refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:05:00.000Z"));
    const manualRefresh = deferred<{
      data: { items: (typeof PENDING_RUN)[] };
    }>();
    mocks.listRegressionRuns
      .mockReset()
      .mockResolvedValueOnce({ data: { items: [PENDING_RUN] } })
      .mockReturnValueOnce(manualRefresh.promise);
    render(<ModelChangelogPanel />);
    await waitFor(() => expect(document.body.textContent).toContain("Queued"));

    click(button("Refresh evidence"));
    await waitFor(() =>
      expect(mocks.listRegressionRuns).toHaveBeenCalledTimes(2),
    );
    await act(async () => {
      vi.advanceTimersByTime(5_500);
      await Promise.resolve();
    });
    expect(mocks.listRegressionRuns).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain(
      "Refreshing evidence; the current snapshot remains visible",
    );

    await act(async () => {
      manualRefresh.resolve({ data: { items: [PENDING_RUN] } });
      await manualRefresh.promise;
    });
    await waitFor(() =>
      expect(document.body.textContent).not.toContain(
        "Refreshing evidence; the current snapshot remains visible",
      ),
    );
  });

  it("moves from a labelled changelog skeleton to an honest empty state", async () => {
    const pending = deferred<{ data: { items: [] } }>();
    mocks.listRegressionRuns.mockReset().mockReturnValue(pending.promise);
    render(<ModelChangelogPanel />);
    expect(
      document.querySelector('[aria-label="Loading AI regression evidence"]'),
    ).not.toBeNull();

    await act(async () => {
      pending.resolve({ data: { items: [] } });
      await pending.promise;
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("No regression runs yet"),
    );
    expect(document.body.textContent).not.toContain("Recorded pass");
  });

  it("does not translate a missing changelog envelope into an empty ledger", async () => {
    mocks.listRegressionRuns.mockResolvedValue({ data: undefined });
    render(<ModelChangelogPanel />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "invalid regression-run receipt",
      ),
    );
    expect(document.body.textContent).not.toContain("No regression runs yet");
  });

  it("retains the current changelog snapshot when a refresh fails", async () => {
    mocks.listRegressionRuns
      .mockReset()
      .mockResolvedValueOnce({ data: { items: [COMPLETED_RUN] } })
      .mockResolvedValueOnce({
        error: { kind: "http", status: 502, message: "Refresh unavailable" },
      });
    render(<ModelChangelogPanel />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Recorded pass"),
    );
    click(button("Refresh evidence"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Refresh failed; retained snapshot shown",
      ),
    );
    expect(document.body.textContent).toContain("model-v2");
    expect(document.body.textContent).toContain("Refresh unavailable");
  });

  it("recovers a per-run result disclosure after an endpoint error", async () => {
    mocks.getRegressionRunResults
      .mockReset()
      .mockResolvedValueOnce({
        error: { kind: "http", status: 503, message: "Results unavailable" },
      })
      .mockResolvedValueOnce({ data: { items: SCORED_RESULTS } });
    render(<ModelChangelogPanel />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Recorded pass"),
    );
    click(button("Review evidence"));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Results unavailable"),
    );
    expect(
      Array.from(document.querySelectorAll('[role="alert"]')).some((alert) =>
        alert.textContent?.includes("Results unavailable"),
      ),
    ).toBe(true);
    click(button("Retry"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Launch day is here <script>literal evidence</script> 🚀",
      ),
    );
    expect(mocks.getRegressionRunResults).toHaveBeenCalledTimes(2);
  });

  it("does not translate a missing result envelope into zero persisted rows", async () => {
    mocks.getRegressionRunResults.mockResolvedValue({ data: undefined });
    render(<ModelChangelogPanel />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Recorded pass"),
    );
    click(button("Review evidence"));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "invalid replay-results receipt",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "No persisted result rows yet",
    );
  });

  it("keeps replay text and safe failure receipts visible for both error shapes", async () => {
    const errorRun = {
      ...COMPLETED_RUN,
      total_examples: 2,
      passed_examples: 0,
      scored_examples: 0,
      error_examples: 2,
      fidelity_score_mean: undefined,
      fidelity_score_p25: undefined,
      gate_result: "advisory" as const,
      by_surface: {
        campaign_draft: {
          total: 2,
          scored: 0,
          errors: 2,
          passed: 0,
          mean_score: null,
          gate_result: "advisory" as const,
        },
      },
    };
    mocks.listRegressionRuns.mockResolvedValue({ data: { items: [errorRun] } });
    mocks.getRegressionRunResults.mockResolvedValue({
      data: {
        items: [
          {
            ...SCORED_RESULTS[0],
            approved_output: "Frozen approved A",
            replayed_output: "Partial replay retained before scoring failed",
            fidelity_score: undefined,
            breakdown: undefined,
            severity: "error" as const,
            error_code: "profile_score_failed",
            error_message: "Voice profile scoring did not complete",
          },
          {
            ...SCORED_RESULTS[1],
            approved_output: "Frozen approved B",
            replayed_output: undefined,
            fidelity_score: undefined,
            breakdown: undefined,
            severity: "error" as const,
            error_code: "generation_failed",
            error_message: "Replay generation did not complete",
          },
        ],
      },
    });

    render(<ModelChangelogPanel />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Unscored"),
    );
    click(button("Review evidence"));
    await waitFor(() =>
      expect(document.querySelectorAll(".ai-evidence-output")).toHaveLength(2),
    );
    const comparisons = Array.from(
      document.querySelectorAll<HTMLDetailsElement>(".ai-evidence-output"),
    );
    for (const comparison of comparisons) {
      click(comparison.querySelector("summary"));
    }
    expect(comparisons[0]?.textContent).toContain(
      "Partial replay retained before scoring failed",
    );
    expect(comparisons[0]?.textContent).toContain(
      "Voice profile scoring did not complete",
    );
    expect(comparisons[1]?.textContent).toContain(
      "No replayed output was retained with this error receipt",
    );
    expect(comparisons[1]?.textContent).toContain(
      "Replay generation did not complete",
    );
    expect(comparisons[1]?.textContent).toContain(
      "legacy result has no complete frozen-input receipt",
    );
    expect(comparisons[1]?.textContent).toContain("Legacy approved output");
    expect(document.body.textContent).toContain(
      "Score explanation unavailable for this legacy or malformed receipt",
    );
    expect(
      Array.from(
        document.querySelectorAll(
          "td, .ai-evidence-coverage__value, .ai-evidence-surface span, .ai-evidence-run__summary span",
        ),
        (node) => node.textContent?.trim(),
      ),
    ).not.toContain("0/100");
  });

  it("polls the latest badge without fabricating an advisory for a pending run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:05:00.000Z"));
    mocks.getLatestRegressionRun
      .mockReset()
      .mockResolvedValueOnce({ data: { run: PENDING_RUN } })
      .mockResolvedValueOnce({ data: { run: COMPLETED_RUN } });
    mocks.getRegressionRunResults.mockResolvedValue({
      data: { items: SCORED_RESULTS },
    });

    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="voice-regression-badge-pending"]',
        ),
      ).not.toBeNull(),
    );
    const pendingBadge = document.querySelector(
      '[data-testid="voice-regression-badge-pending"]',
    );
    expect(pendingBadge?.getAttribute("role")).toBeNull();
    expect(pendingBadge?.getAttribute("aria-live")).toBeNull();
    const progressAnnouncement = pendingBadge?.querySelector(
      '.ai-regression-badge__live-progress[role="status"][aria-live="polite"][aria-atomic="true"]',
    );
    expect(progressAnnouncement?.textContent).toContain(
      "Queued. 0 of 5 processed.",
    );
    expect(progressAnnouncement?.textContent).not.toContain(
      "score and policy outcome",
    );
    expect(pendingBadge?.textContent).toContain(
      "Operator correlation label: model-v2",
    );
    expect(
      pendingBadge?.querySelectorAll("bdi.ai-regression-forensic").length,
    ).toBeGreaterThanOrEqual(4);
    expect(document.body.textContent).not.toContain("Recorded advisory");

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("Recorded policy evaluation"),
    );
    expect(mocks.getLatestRegressionRun).toHaveBeenCalledTimes(2);
    expect(mocks.getRegressionRunResults).toHaveBeenCalledWith("run-1");
    expect(document.body.textContent).toContain(
      "based on 5 scored golden examples",
    );
    expect(document.body.textContent).toContain(
      "no connected deployment-authority receipt",
    );
  });

  it("does not announce visibility-aware badge polling as a user refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:05:00.000Z"));
    const background = deferred<{ data: { run: typeof COMPLETED_RUN } }>();
    mocks.getLatestRegressionRun
      .mockReset()
      .mockResolvedValueOnce({ data: { run: PENDING_RUN } })
      .mockReturnValueOnce(background.promise);
    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-testid="voice-regression-badge-pending"]',
        ),
      ).not.toBeNull(),
    );

    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.getLatestRegressionRun).toHaveBeenCalledTimes(2),
    );
    expect(document.body.textContent).not.toContain(
      "Checking for a newer receipt",
    );

    await act(async () => {
      background.resolve({ data: { run: COMPLETED_RUN } });
      await background.promise;
    });
  });

  it("refreshes terminal evidence after errors and isolates details when the latest run changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:05:00.000Z"));
    const nextRun = {
      ...COMPLETED_RUN,
      id: "run-2",
      model_version_tag: "model-v3",
      passed_examples: 2,
      scored_examples: 2,
      error_examples: 3,
      fidelity_score_mean: 82,
      gate_result: "advisory" as const,
      by_surface: {
        campaign_draft: {
          total: 5,
          scored: 2,
          errors: 3,
          passed: 2,
          mean_score: 82,
          gate_result: "advisory" as const,
        },
      },
    };
    const nextDetails = deferred<{
      data: { items: typeof SCORED_RESULTS };
    }>();
    mocks.getLatestRegressionRun
      .mockReset()
      .mockResolvedValueOnce({ data: { run: COMPLETED_RUN } })
      .mockResolvedValueOnce({
        error: { kind: "http", status: 502, message: "Latest refresh failed" },
      })
      .mockResolvedValueOnce({ data: { run: nextRun } });
    mocks.getRegressionRunResults
      .mockReset()
      .mockResolvedValueOnce({ data: { items: SCORED_RESULTS } })
      .mockReturnValueOnce(nextDetails.promise);

    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("model-v2"),
    );

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("Latest refresh failed"),
    );
    expect(document.body.textContent).toContain("model-v2");

    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(document.body.textContent).toContain("model-v3"),
    );
    expect(
      document.querySelector('[aria-label="Loading per-example detail"]'),
    ).not.toBeNull();
    expect(
      document
        .querySelector('[data-testid="voice-regression-badge"]')
        ?.getAttribute("data-detail-aligned"),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Detail rows disagree with terminal receipt",
    );
    expect(mocks.getRegressionRunResults).toHaveBeenLastCalledWith("run-2");

    const matchingNextRows = [
      SCORED_RESULTS[0],
      SCORED_RESULTS[1],
      ...SCORED_RESULTS.slice(2).map((result) => ({
        ...result,
        fidelity_score: undefined,
        breakdown: undefined,
        severity: "error" as const,
        error_code: "generation_failed",
        error_message: "Replay generation did not complete",
      })),
    ] as typeof SCORED_RESULTS;
    await act(async () => {
      nextDetails.resolve({ data: { items: matchingNextRows } });
      await nextDetails.promise;
    });
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-testid="voice-regression-badge"]')
          ?.getAttribute("data-detail-aligned"),
      ).toBe("true"),
    );
    expect(mocks.getLatestRegressionRun).toHaveBeenCalledTimes(3);
  });

  it("renders a distinct empty badge without requesting result rows", async () => {
    mocks.getLatestRegressionRun.mockReset().mockResolvedValue({
      data: { run: null },
    });
    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("No regression evidence yet"),
    );
    expect(
      document.querySelector('[data-testid="voice-regression-badge-empty"]'),
    ).not.toBeNull();
    expect(mocks.getRegressionRunResults).not.toHaveBeenCalled();
  });

  it("does not translate a missing latest-run envelope into no evidence", async () => {
    mocks.getLatestRegressionRun.mockResolvedValue({ data: undefined });
    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("invalid latest-run receipt"),
    );
    expect(document.body.textContent).not.toContain(
      "No regression evidence yet",
    );
  });

  it("surfaces a missing badge-detail envelope as a contract error", async () => {
    mocks.getRegressionRunResults.mockResolvedValue({ data: undefined });
    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "invalid per-example detail receipt",
      ),
    );
    expect(document.body.textContent).not.toContain(
      "Detail rows disagree with terminal receipt",
    );
  });

  it("uses the frozen run minimum for low-sample confidence", async () => {
    mocks.getLatestRegressionRun.mockReset().mockResolvedValue({
      data: {
        run: { ...COMPLETED_RUN, min_examples_for_gate: 8 },
      },
    });
    mocks.getRegressionRunResults.mockResolvedValue({
      data: { items: SCORED_RESULTS },
    });
    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "low sample — interpret with caution",
      ),
    );
    expect(document.body.textContent).toContain(
      "based on 5 scored golden examples",
    );
  });

  it("labels terminal remainders as unprocessed while matching persisted detail rows", async () => {
    const partialRun = {
      ...COMPLETED_RUN,
      passed_examples: 2,
      scored_examples: 2,
      error_examples: 1,
      fidelity_score_mean: 81,
      gate_result: "advisory" as const,
      by_surface: {
        campaign_draft: {
          total: 5,
          scored: 2,
          errors: 1,
          passed: 2,
          mean_score: 81,
          gate_result: "advisory" as const,
        },
      },
    };
    mocks.getLatestRegressionRun.mockReset().mockResolvedValue({
      data: { run: partialRun },
    });
    mocks.getRegressionRunResults.mockResolvedValue({
      data: {
        items: [
          SCORED_RESULTS[0],
          SCORED_RESULTS[1],
          {
            ...SCORED_RESULTS[2],
            fidelity_score: undefined,
            breakdown: undefined,
            severity: "error" as const,
            error_code: "generation_failed",
            error_message: "Replay generation did not complete",
          },
        ],
      },
    });
    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-testid="voice-regression-badge"]')
          ?.getAttribute("data-detail-aligned"),
      ).toBe("true"),
    );
    expect(document.body.textContent).toContain(
      "3 / 5 processed · 2 unprocessed · no result receipt",
    );
    expect(document.body.textContent).toContain(
      "2 snapshots remain without a persisted result receipt",
    );
    expect(document.body.textContent).not.toContain(
      "Detail rows disagree with terminal receipt",
    );
    expect(document.body.textContent).not.toContain("Recorded advisory");
    expect(document.body.textContent).not.toContain("remaining pending");
  });

  it("renders failed and incomplete runs without converting either into advisory", async () => {
    mocks.getLatestRegressionRun.mockReset().mockResolvedValueOnce({
      data: {
        run: {
          ...PENDING_RUN,
          status: "failed",
          error_message: "Replay worker timed out",
        },
      },
    });
    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Replay worker timed out"),
    );
    expect(document.body.textContent).toContain(
      "5 unprocessed with no result receipt",
    );
    expect(document.body.textContent).not.toContain(
      "remain pending, not failed",
    );
    expect(document.body.textContent).not.toContain("Recorded advisory");

    act(() => root?.unmount());
    root = createRoot(container!);
    mocks.getLatestRegressionRun.mockReset().mockResolvedValueOnce({
      data: {
        run: {
          ...PENDING_RUN,
          status: "completed",
          completed_at: "2026-07-16T08:01:00.000Z",
        },
      },
    });
    act(() => root?.render(<VoiceRegressionBadge />));
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "Regression summary is incomplete",
      ),
    );
    expect(document.body.textContent).not.toContain("Recorded advisory");
    expect(document.body.textContent).not.toContain("Recorded pass");
  });

  it("bases badge confidence on the server receipt and never renders an all-error mean as zero", async () => {
    mocks.getLatestRegressionRun.mockReset().mockResolvedValue({
      data: {
        run: {
          ...COMPLETED_RUN,
          passed_examples: 2,
          scored_examples: 2,
          error_examples: 3,
          fidelity_score_mean: 81,
          gate_result: "advisory",
          by_surface: {
            campaign_draft: {
              total: 5,
              scored: 2,
              errors: 3,
              passed: 2,
              mean_score: 81,
              gate_result: "advisory",
            },
          },
        },
      },
    });
    mocks.getRegressionRunResults.mockResolvedValue({
      data: {
        items: [
          SCORED_RESULTS[0],
          SCORED_RESULTS[1],
          {
            ...SCORED_RESULTS[2],
            fidelity_score: undefined,
            severity: "error",
            error_message: "generation failed",
          },
        ],
      },
    });
    render(<VoiceRegressionBadge />);
    await waitFor(() =>
      expect(document.body.textContent).toContain(
        "based on 2 scored golden examples",
      ),
    );
    expect(document.body.textContent).toContain(
      "low sample — interpret with caution",
    );
    expect(document.body.textContent).toContain("5 / 5 processed");
    expect(document.body.textContent).toContain("2 scored 3 persisted errors");
    expect(document.body.textContent).toContain(
      "Detail rows disagree with terminal receipt",
    );
    expect(document.body.textContent).toContain("3 persisted errors");

    act(() => root?.unmount());
    root = createRoot(container!);
    mocks.getLatestRegressionRun.mockReset().mockResolvedValue({
      data: {
        run: {
          ...COMPLETED_RUN,
          passed_examples: 0,
          scored_examples: 0,
          error_examples: 5,
          fidelity_score_mean: undefined,
          gate_result: "advisory",
          by_surface: {
            campaign_draft: {
              total: 5,
              scored: 0,
              errors: 5,
              passed: 0,
              mean_score: null,
              gate_result: "advisory",
            },
          },
        },
      },
    });
    mocks.getRegressionRunResults.mockResolvedValue({
      data: {
        items: [
          {
            ...SCORED_RESULTS[0],
            fidelity_score: undefined,
            severity: "error",
          },
        ],
      },
    });
    act(() => root?.render(<VoiceRegressionBadge />));
    await waitFor(() =>
      expect(document.body.textContent).toContain("Unscored"),
    );
    expect(document.body.textContent).not.toContain("0/100");
  });

  it("labels old in-flight timestamps as a client freshness warning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T09:00:00.000Z"));
    mocks.listRegressionRuns.mockResolvedValue({
      data: { items: [PENDING_RUN] },
    });
    render(<ModelChangelogPanel />);
    await waitFor(() =>
      expect(document.body.textContent).toContain("Freshness warning"),
    );
    expect(document.body.textContent).toContain(
      "not a server-authored worker state",
    );
    expect(document.body.textContent).toContain(
      "Server lease expiry or client-age fallback",
    );
  });
});
