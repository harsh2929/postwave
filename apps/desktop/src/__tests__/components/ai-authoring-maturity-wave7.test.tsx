// @vitest-environment happy-dom

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import axe from "axe-core";
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

const mocks = vi.hoisted(() => ({
  canAdmin: true,
  tenantId: "tenant-1",
  aiSubjectLinesTopPerformers: vi.fn(),
  aiSubjectLinesGenerate: vi.fn(),
  buckets: vi.fn(),
  score: vi.fn(),
  streamAIGenerate: vi.fn(),
  listApiKeys: vi.fn(),
  createApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  getVoiceProfile: vi.fn(),
  listVoiceSources: vi.fn(),
  createVoiceSource: vi.fn(),
  ingestVoiceSource: vi.fn(),
  deleteVoiceSource: vi.fn(),
  buildVoiceProfile: vi.fn(),
  listMCPExecutions: vi.fn(),
  getBrandVoiceProfile: vi.fn(),
  putBrandVoiceProfile: vi.fn(),
  aiComposeBroadcast: vi.fn(),
  aiComposeVariants: vi.fn(),
  presendGet: vi.fn(),
  presendPreview: vi.fn(),
  presendClear: vi.fn(),
  writeClipboardText: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => mocks.canAdmin,
  useMe: () => ({
    user: "user-1",
    tenant: mocks.tenantId,
    role: mocks.canAdmin ? "admin" : "editor",
    effectiveRole: mocks.canAdmin ? "admin" : "editor",
  }),
}));

vi.mock("../../lib/context-epoch", () => ({
  onContextEpochObserved: () => () => undefined,
  readContextEpoch: () => "epoch-1",
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: mocks.navigate,
}));

vi.mock("../../lib/clipboard", () => ({
  clipboardSuccessDetail: () => "Clipboard auto-clears after 60 seconds.",
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/ai/TonePicker", () => ({
  TonePicker: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: "" | "friendly") => void;
  }) => (
    <div role="radiogroup" aria-label="Tone">
      <button
        type="button"
        role="radio"
        aria-checked={value === ""}
        onClick={() => onChange("")}
      >
        Auto
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value === "friendly"}
        onClick={() => onChange("friendly")}
      >
        Friendly
      </button>
    </div>
  ),
}));

vi.mock("../../lib/ai-client", () => ({
  streamAIGenerate: mocks.streamAIGenerate,
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    aiSubjectLinesTopPerformers: mocks.aiSubjectLinesTopPerformers,
    aiSubjectLinesGenerate: mocks.aiSubjectLinesGenerate,
    listApiKeys: mocks.listApiKeys,
    createApiKey: mocks.createApiKey,
    deleteApiKey: mocks.deleteApiKey,
    getVoiceProfile: mocks.getVoiceProfile,
    listVoiceSources: mocks.listVoiceSources,
    createVoiceSource: mocks.createVoiceSource,
    ingestVoiceSource: mocks.ingestVoiceSource,
    deleteVoiceSource: mocks.deleteVoiceSource,
    buildVoiceProfile: mocks.buildVoiceProfile,
    listMCPExecutions: mocks.listMCPExecutions,
    getBrandVoiceProfile: mocks.getBrandVoiceProfile,
    putBrandVoiceProfile: mocks.putBrandVoiceProfile,
    aiComposeBroadcast: mocks.aiComposeBroadcast,
    aiComposeVariants: mocks.aiComposeVariants,
  },
  subjectAnalyzerApi: {
    buckets: mocks.buckets,
    score: mocks.score,
  },
  presendRefineApi: {
    get: mocks.presendGet,
    preview: mocks.presendPreview,
    clear: mocks.presendClear,
  },
}));

import { PreSendRefinePanel } from "../../components/PreSendRefinePanel";
import { SubjectLineAssistant } from "../../components/SubjectLineAssistant";
import { SubjectLineSuggestions } from "../../components/SubjectLineSuggestions";
import { AgentKeyCard } from "../../components/ai/AgentKeyCard";
import { BrandVoicePanel } from "../../components/ai/BrandVoicePanel";
import { ComposeBroadcastForm } from "../../components/ai/ComposeBroadcastForm";
import { RecentExecutionsStrip } from "../../components/ai/RecentExecutionsStrip";
import { VoiceProfileCard } from "../../components/ai/VoiceProfileCard";

const DESKTOP_DIR = process.cwd();
const SCOPED_FILES = [
  "components/SubjectLineAssistant.tsx",
  "components/SubjectLineSuggestions.tsx",
  "components/PreSendRefinePanel.tsx",
  "components/ai/AgentKeyCard.tsx",
  "components/ai/VoiceProfileCard.tsx",
  "components/ai/RecentExecutionsStrip.tsx",
  "components/ai/BrandVoicePanel.tsx",
  "components/ai/ComposeBroadcastForm.tsx",
] as const;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = true;
  mocks.tenantId = "tenant-1";
  Object.entries(mocks).forEach(([key, value]) => {
    if (key !== "canAdmin" && typeof value === "function") value.mockReset();
  });
  mocks.aiSubjectLinesTopPerformers.mockResolvedValue({ data: { top: [] } });
  mocks.buckets.mockResolvedValue({
    data: { campaigns_total: 0, window_days: 90, buckets: [] },
  });
  mocks.score.mockResolvedValue({
    data: {
      subject: "Generated subject",
      attributes: {
        length: 17,
        length_bucket: "short",
        word_count: 2,
        emoji_count: 0,
        has_question: false,
        has_personalize: false,
        all_caps: false,
      },
      expected_open: 0.42,
      expected_click: 0.08,
      matched_history: 12,
      suggestions: ["Lead with the benefit"],
    },
  });
  mocks.listApiKeys.mockResolvedValue({ data: { items: [] } });
  mocks.getVoiceProfile.mockResolvedValue({
    error: { status: 404, message: "None" },
  });
  mocks.listVoiceSources.mockResolvedValue({ data: { items: [] } });
  mocks.listMCPExecutions.mockResolvedValue({
    data: {
      tenantId: "tenant-1",
      rows: [],
      detailPolicy: "minimized_v1",
      evidenceClass: "best_effort_observability",
    },
  });
  mocks.getBrandVoiceProfile.mockResolvedValue({
    data: {
      descriptors: ["warm"],
      writing_rules: [],
      sample_snippets: [],
    },
  });
  mocks.presendGet.mockResolvedValue({
    data: refinement({ excluded_count: 0 }),
  });
  mocks.presendPreview.mockResolvedValue({ data: refinement() });
  mocks.presendClear.mockResolvedValue({ data: { cleared: 4 } });
  mocks.writeClipboardText.mockResolvedValue({ ok: true, method: "clipboard" });
});

afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
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

async function settle(): Promise<void> {
  await act(async () => {
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

function setInput(
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

function refinement(overrides: Record<string, unknown> = {}) {
  return {
    campaign_id: "campaign-1",
    churn_threshold: 80,
    cooling_off_hours: 24,
    excluded_count: 4,
    cooling_off_count: 3,
    dry_run: true,
    exclude_recently_paused: false,
    affected_subscribers_sample: [
      {
        subscriber_id: "subscriber-1",
        email: "very-long-risk-address@example.test",
        churn_score: 96,
        reason: "churn_risk",
      },
    ],
    ...overrides,
  };
}

function AgentHarness(): ReactElement {
  const [plaintext, setPlaintext] = useState<string | null>(null);
  return (
    <AgentKeyCard
      activePlaintext={plaintext}
      onMintedPlaintext={setPlaintext}
      onPlaintextResolved={() => setPlaintext(null)}
    />
  );
}

describe("AI authoring maturity wave 7", () => {
  it("keeps both title inventories at zero and pins the durable source contracts", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/interactive-title-inventory.mjs", "--json"],
      { cwd: DESKTOP_DIR, encoding: "utf8" },
    );
    const inventory = JSON.parse(output) as {
      findings: Array<{ file: string }>;
      nonInteractiveFindings: Array<{ file: string }>;
    };
    const scoped = new Set<string>(SCOPED_FILES);
    expect(
      inventory.findings.filter((finding) => scoped.has(finding.file)),
    ).toEqual([]);
    expect(
      inventory.nonInteractiveFindings.filter((finding) =>
        scoped.has(finding.file),
      ),
    ).toEqual([]);

    const contracts: Record<(typeof SCOPED_FILES)[number], string[]> = {
      "components/SubjectLineAssistant.tsx": [
        "generatingRef.current",
        "aria-controls={contentId}",
        "<caption>",
      ],
      "components/SubjectLineSuggestions.tsx": [
        "requestRef.current !== requestId",
        "handle.abort()",
        "No variant returned for this slot.",
      ],
      "components/PreSendRefinePanel.tsx": [
        "operationRef.current",
        "Clear exclusions and send anyway",
        "Saved state unavailable",
        'activeStatus !== "ready"',
        "Retry saved state",
      ],
      "components/ai/AgentKeyCard.tsx": [
        "useSingleFlightOperation",
        "aria-pressed={selected}",
        "Admin is privileged.",
      ],
      "components/ai/VoiceProfileCard.tsx": [
        "mutationRef.current",
        "validSourceUrl",
        "aria-invalid",
      ],
      "components/ai/RecentExecutionsStrip.tsx": [
        "inFlightRef.current",
        "visibilitychange",
        "<table",
      ],
      "components/ai/BrandVoicePanel.tsx": [
        "saveRef.current",
        "savedSnapshotRef.current",
        "useDiscardOnlyDraftLifecycle",
        "validationError",
      ],
      "components/ai/ComposeBroadcastForm.tsx": [
        "operationRef.current",
        "requestRef.current !== requestId",
        "aria-pressed={selected}",
      ],
    };
    for (const [file, tokens] of Object.entries(contracts)) {
      const source = readFileSync(`${DESKTOP_DIR}/src/${file}`, "utf8");
      tokens.forEach((token) => expect(source).toContain(token));
    }
  });

  it("guards subject generation in the same tick and renders scored evidence semantically", async () => {
    const generation = deferred<{
      data: { candidates: string[]; generated_at: string };
    }>();
    mocks.aiSubjectLinesGenerate.mockReturnValue(generation.promise);
    mocks.aiSubjectLinesTopPerformers.mockResolvedValue({
      data: {
        top: [
          {
            campaign_id: "top-1",
            name: "July launch",
            subject: "Our best subject",
            sent_at: "2026-07-01T00:00:00Z",
            recipients: 1200,
            opens: 600,
            clicks: 120,
            open_rate: 0.5,
            click_rate: 0.1,
          },
        ],
      },
    });
    render(
      <SubjectLineAssistant
        onPickSubject={vi.fn()}
        onAutoPopulateAB={vi.fn()}
      />,
    );
    await settle();

    const generate = button("Generate");
    expect(generate.disabled).toBe(false);
    expect(generate.getAttribute("aria-disabled")).toBe("true");
    const brief = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!brief) throw new Error("Missing subject brief");
    setInput(brief, "Launch the annual plan");
    act(() => {
      generate.click();
      generate.click();
    });
    expect(mocks.aiSubjectLinesGenerate).toHaveBeenCalledTimes(1);
    expect(button("Generating…").disabled).toBe(true);

    generation.resolve({
      data: {
        candidates: ["Save on annual", "One year, one better price"],
        generated_at: "2026-07-17T00:00:00Z",
      },
    });
    await settle();
    expect(document.body.textContent).toContain("Lead with the benefit");
    expect(document.body.textContent).toContain("1,200 recipients");
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("discards a subject response when its exact brief changes", async () => {
    const generation = deferred<{
      data: { candidates: string[]; generated_at: string };
    }>();
    mocks.aiSubjectLinesGenerate.mockReturnValue(generation.promise);
    render(<SubjectLineAssistant onPickSubject={vi.fn()} />);
    await settle();
    const brief = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!brief) throw new Error("Missing subject brief");
    setInput(brief, "Original launch brief");
    act(() => button("Generate").click());
    setInput(brief, "Updated launch brief");
    generation.resolve({
      data: {
        candidates: ["Stale subject"],
        generated_at: "2026-07-17T00:00:00Z",
      },
    });
    await settle();
    expect(document.body.textContent).not.toContain("Stale subject");
  });

  it("aborts stale subject streams and exposes a retryable honest error", async () => {
    vi.useFakeTimers();
    const streams: Array<{
      callbacks: {
        onDelta: (chunk: string) => void;
        onDone: () => void;
        onError: (message: string) => void;
      };
      abort: ReturnType<typeof vi.fn>;
    }> = [];
    mocks.streamAIGenerate.mockImplementation(
      (_input: unknown, callbacks: (typeof streams)[number]["callbacks"]) => {
        const handle = { callbacks, abort: vi.fn() };
        streams.push(handle);
        return { abort: handle.abort };
      },
    );
    const view = render(
      <SubjectLineSuggestions
        currentSubject="First complete subject"
        onPickVariant={vi.fn()}
        onOpenLab={vi.fn()}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(500));
    view.rerender(
      <SubjectLineSuggestions
        currentSubject="Second complete subject"
        onPickVariant={vi.fn()}
        onOpenLab={vi.fn()}
      />,
    );
    expect(streams[0]?.abort).toHaveBeenCalledTimes(1);
    act(() => streams[0]?.callbacks.onDelta("1. Stale variant\n"));
    await act(async () => vi.advanceTimersByTimeAsync(500));
    act(() => streams[1]?.callbacks.onError("voice service offline"));
    expect(document.body.textContent).not.toContain("Stale variant");
    expect(document.body.textContent).toContain("voice service offline");
    expect(button("Retry")).toBeTruthy();
  });

  it("natively disables unavailable refinement actions and keeps the reason accessible", async () => {
    mocks.presendGet.mockResolvedValue({ data: refinement() });
    mocks.presendPreview.mockResolvedValue({ data: refinement() });
    render(<PreSendRefinePanel campaignID="campaign-1" canMutate={false} />);
    await settle();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 275));
    });
    const apply = button("Apply refinement");
    const clear = button("Send anyway");
    expect(apply.disabled).toBe(true);
    expect(apply.getAttribute("aria-describedby")).toBeTruthy();
    expect(clear.disabled).toBe(true);
    expect(clear.getAttribute("aria-describedby")).toBeTruthy();
    act(() => {
      apply.click();
      clear.click();
    });
    expect(mocks.presendClear).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "very-long-risk-address@example.test",
    );
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("owns agent-key minting from the first click and blocks secret replacement visibly", async () => {
    mocks.listApiKeys.mockResolvedValue({
      data: {
        items: [
          {
            id: "key-1",
            label: "Production agent key with a long descriptive label",
            prefix: "pw_agent",
            scopes: ["read:campaigns"],
          },
        ],
      },
    });
    const mint = deferred<{ data: { plaintext: string } }>();
    mocks.createApiKey.mockReturnValue(mint.promise);
    render(<AgentHarness />);
    await settle();
    act(() => button("+ Mint key").click());
    expect(document.body.textContent).toContain("Admin is privileged");
    expect(
      document.querySelector('[aria-pressed="false"]')?.textContent,
    ).toContain("admin");
    const mintAction = button("Mint key");
    act(() => {
      mintAction.click();
      mintAction.click();
    });
    expect(mocks.createApiKey).toHaveBeenCalledTimes(1);
    expect(button("Minting…").disabled).toBe(true);

    mint.resolve({ data: { plaintext: "pw_secret_once" } });
    await settle();
    expect(document.body.textContent).toContain("pw_secret_once");
    const replace = button("+ Mint key");
    expect(replace.disabled).toBe(false);
    expect(replace.getAttribute("aria-disabled")).toBe("true");
    const revoke = button("Revoke");
    expect(revoke.disabled).toBe(false);
    expect(revoke.getAttribute("aria-disabled")).toBe("true");
    act(() => revoke.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("keeps voice-source permissions discoverable and guards ingest in the same tick", async () => {
    mocks.canAdmin = false;
    mocks.getVoiceProfile.mockResolvedValue({
      data: {
        description: "Voice grounded in product documentation",
        generated_at: "2026-07-01T00:00:00Z",
        version: 2,
      },
    });
    mocks.listVoiceSources.mockResolvedValue({
      data: {
        items: [
          {
            id: "source-1",
            params: {
              FeedURL:
                "https://docs.example.test/a/very/long/source/path/that-wraps",
            },
            last_ingested_at: "2026-07-01T00:00:00Z",
            last_item_count: 12,
          },
        ],
      },
    });
    const view = render(<VoiceProfileCard />);
    await settle();
    const rebuild = button("Rebuild from sources");
    expect(rebuild.disabled).toBe(false);
    expect(rebuild.getAttribute("aria-disabled")).toBe("true");
    const reingest = button("Re-ingest");
    act(() => reingest.click());
    expect(mocks.ingestVoiceSource).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Admin access is required");

    mocks.canAdmin = true;
    const ingest = deferred<{ data: { ok: boolean } }>();
    mocks.ingestVoiceSource.mockReturnValue(ingest.promise);
    view.rerender(<VoiceProfileCard />);
    const adminIngest = button("Re-ingest");
    act(() => {
      adminIngest.click();
      adminIngest.click();
    });
    expect(mocks.ingestVoiceSource).toHaveBeenCalledTimes(1);
    ingest.resolve({ data: { ok: true } });
    await settle();
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("renders recent execution details as a non-color-only semantic table", async () => {
    mocks.listMCPExecutions.mockResolvedValue({
      data: {
        tenantId: "tenant-1",
        rows: [
          {
            id: 101,
            tenantId: "tenant-1",
            toolName: "campaign_report",
            method: "POST",
            path: "/api/v1/reports/campaigns/launch",
            statusCode: 503,
            latencyMs: 420,
            costMicros: 0,
            calledAt: "2026-07-17T00:00:00Z",
            userAgent: "postwave-mcp-server/0.1.0",
          },
        ],
        detailPolicy: "minimized_v1",
        evidenceClass: "best_effort_observability",
      },
    });
    render(<RecentExecutionsStrip />);
    await settle();
    expect(document.querySelector("table")).not.toBeNull();
    expect(document.body.textContent).toContain("Server error · 503");
    expect(document.body.textContent).toContain(
      "POST /api/v1/reports/campaigns/launch",
    );
    act(() => button("Full history →").click());
    expect(mocks.navigate).toHaveBeenCalledWith({
      section: "mcp",
      tab: "history",
    });
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("validates brand voice inline and owns one exact save through settlement", async () => {
    const save = deferred<{
      data: {
        descriptors: string[];
        writing_rules: string[];
        sample_snippets: string[];
        updated_at: string;
      };
    }>();
    mocks.putBrandVoiceProfile.mockReturnValue(save.promise);
    render(<BrandVoicePanel />);
    await settle();
    const descriptors = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!descriptors) throw new Error("Missing descriptors field");
    setInput(descriptors, "warm\nprecise");
    const saveButton = button("Save profile");
    expect(saveButton.getAttribute("aria-disabled")).toBeNull();
    act(() => {
      saveButton.click();
      saveButton.click();
    });
    expect(mocks.putBrandVoiceProfile).toHaveBeenCalledTimes(1);
    expect(button("Saving…").disabled).toBe(true);
    save.resolve({
      data: {
        descriptors: ["warm", "precise"],
        writing_rules: [],
        sample_snippets: [],
        updated_at: "2026-07-17T00:00:00Z",
      },
    });
    await settle();
    expect(button("Save profile").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain("matches the saved version");
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
  });

  it("discards stale broadcast composition and exposes complete selectable results", async () => {
    const first = deferred<{
      data: {
        primary: { name: string; subject: string; body: string };
        subject_variants: string[];
      };
    }>();
    const useDraft = vi.fn();
    mocks.aiComposeBroadcast.mockReturnValueOnce(first.promise);
    render(<ComposeBroadcastForm onUseDraft={useDraft} />);
    const brief = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!brief) throw new Error("Missing compose brief");
    const compose = button("Compose");
    expect(compose.disabled).toBe(false);
    expect(compose.getAttribute("aria-disabled")).toBe("true");
    setInput(brief, "Original product launch");
    act(() => {
      compose.click();
      compose.click();
    });
    expect(mocks.aiComposeBroadcast).toHaveBeenCalledTimes(1);
    setInput(brief, "Updated product launch");
    first.resolve({
      data: {
        primary: { name: "Old", subject: "Stale", body: "Stale body" },
        subject_variants: ["Stale"],
      },
    });
    await settle();
    expect(document.body.textContent).not.toContain("Stale body");
    expect(document.body.textContent).toContain("stale response was discarded");

    mocks.aiComposeBroadcast.mockResolvedValueOnce({
      data: {
        primary: {
          name: "Launch",
          subject: "The primary launch subject",
          body: "A complete generated body",
          preview_text: "A concise inbox preview",
        },
        subject_variants: [
          "The primary launch subject",
          "A considerably longer alternative launch subject that must wrap",
        ],
      },
    });
    act(() => button("Compose").click());
    await settle();
    const choices = document.querySelectorAll<HTMLButtonElement>(
      ".ai-compose-subject[aria-pressed]",
    );
    expect(choices).toHaveLength(2);
    expect(choices[0]?.getAttribute("aria-pressed")).toBe("true");
    act(() => choices[1]?.click());
    expect(choices[1]?.getAttribute("aria-pressed")).toBe("true");
    act(() => button("Use as draft → Campaigns").click());
    expect(useDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        subject:
          "A considerably longer alternative launch subject that must wrap",
      }),
    );
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("binds new variants to the selected subject and fail-closes stale handoff", async () => {
    const useDraft = vi.fn();
    mocks.aiComposeBroadcast.mockResolvedValueOnce({
      data: {
        primary: {
          name: "Launch",
          subject: "Primary subject",
          body: "<p>Hello <strong>team</strong>.</p><p>Review the launch.</p>",
          preview_text: "A concise preview",
        },
        subject_variants: ["Primary subject", "Selected alternate"],
      },
    });
    mocks.aiComposeVariants.mockResolvedValueOnce({
      data: { subject_variants: ["Fresh selected-subject variant"] },
    });

    render(<ComposeBroadcastForm onUseDraft={useDraft} canMutate />);
    const brief = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!brief) throw new Error("Missing compose brief");
    setInput(brief, "Launch the new workspace");
    act(() => button("Compose").click());
    await settle();

    expect(document.body.textContent).toContain("AI-generated");
    expect(document.body.textContent).toContain("Hello team.");
    expect(document.body.textContent).not.toContain("<strong>");
    const choices = document.querySelectorAll<HTMLButtonElement>(
      ".ai-compose-subject[aria-pressed]",
    );
    act(() => choices[1]?.click());
    act(() => button("+ More subject variants").click());
    await settle();
    expect(mocks.aiComposeVariants).toHaveBeenCalledWith({
      subject: "Selected alternate",
      body: "Hello team.\n\nReview the launch.",
      variant_count: 3,
    });

    setInput(brief, "A changed launch brief");
    const handoff = button("Use as draft → Campaigns");
    expect(handoff.disabled).toBe(true);
    expect(document.body.textContent).toContain("compose again before handoff");
    act(() => handoff.click());
    expect(useDraft).not.toHaveBeenCalled();
  });

  it("makes viewer authority explicit and never renders raw service errors", async () => {
    const useDraft = vi.fn();
    const view = render(
      <ComposeBroadcastForm onUseDraft={useDraft} canMutate={false} />,
    );
    const brief = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!brief) throw new Error("Missing compose brief");
    setInput(brief, "A viewer brief");
    expect(button("Compose").disabled).toBe(true);
    expect(document.body.textContent).toContain("View-only access");
    expect(mocks.aiComposeBroadcast).not.toHaveBeenCalled();

    view.rerender(<ComposeBroadcastForm onUseDraft={useDraft} canMutate />);
    const writableBrief =
      document.querySelector<HTMLTextAreaElement>("textarea");
    if (!writableBrief) throw new Error("Missing writable compose brief");
    setInput(writableBrief, "A writable brief");
    mocks.aiComposeBroadcast.mockResolvedValueOnce({
      error: {
        status: 503,
        message: "postgres password=do-not-render provider trace",
      },
    });
    act(() => button("Compose").click());
    await settle();
    expect(document.body.textContent).toContain(
      "AI service is temporarily unavailable",
    );
    expect(document.body.textContent).not.toContain("password=do-not-render");
  });
});
