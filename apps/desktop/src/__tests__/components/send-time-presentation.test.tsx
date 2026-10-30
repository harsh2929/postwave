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
  setSection: vi.fn(),
}));

vi.mock("../../lib/store", () => ({ setSection: mocks.setSection }));

import { SendTimeAudiencePanel } from "../../components/sendtime/SendTimeAudiencePanel";
import { SendTimeHeatmap } from "../../components/sendtime/SendTimeHeatmap";
import { SendTimeSubscriberInspector } from "../../components/sendtime/SendTimeSubscriberInspector";
import { SendTimeWorkspacePolicy } from "../../components/sendtime/SendTimeWorkspacePolicy";
import { TZ_PREF_KEY } from "../../components/sendtime/tz";
import {
  type AudienceSignalState,
  type SegmentCatalogState,
  type SubscriberLookupState,
  type WorkspaceSettingState,
  useSendTimeAudienceSignals,
  useSendTimeWorkspaceSetting,
  useSubscriberSendTimeLookup,
} from "../../components/sendtime/useSendTimeControllers";
import type { Segment } from "../../components/segments/segmentsClient";
import type {
  BestSendTime,
  SegmentBestSendTime,
  SegmentHeatmapResponse,
  SubscriberOpenPattern,
} from "../../lib/api-client";

type AudienceController = ReturnType<typeof useSendTimeAudienceSignals>;
type SubscriberController = ReturnType<typeof useSubscriberSendTimeLookup>;
type WorkspaceController = ReturnType<typeof useSendTimeWorkspaceSetting>;

const SEGMENT: Segment = {
  id: "segment-engaged",
  name: "Engaged readers",
  lastCount: 1_284,
};
const SUBSCRIBER_ID = "11111111-1111-4111-8111-111111111111";

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
  mocks.setSection.mockReset();
  localStorage.clear();
  class ResizeObserverStub {
    observe(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal(
    "ResizeObserver",
    ResizeObserverStub as unknown as typeof ResizeObserver,
  );
});

afterEach(() => {
  if (root) {
    const mountedRoot = root;
    act(() => mountedRoot.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SendTimeAudiencePanel presentation", () => {
  it("renders a disabled, truthful catalog-loading state without inventing analysis", () => {
    render(
      <SendTimeAudiencePanel
        controller={audienceController({
          catalog: { kind: "loading" },
          signal: { kind: "unscoped" },
        })}
      />,
    );

    const scope = select("send-time-segment");
    expect(scope.disabled).toBe(true);
    expect(scope.textContent).toContain("Loading segments…");
    expect(text()).toContain("Waiting for a scope");
    expect(text()).toContain("Choose the audience you want to understand.");
    expect(document.querySelector(".stx-stat-strip")).toBeNull();
  });

  it("keeps a failed segment catalog distinct and wires its retry action", () => {
    const loadSegments = vi.fn(async () => undefined);
    render(
      <SendTimeAudiencePanel
        controller={audienceController({
          catalog: {
            kind: "error",
            message: "[segments_unavailable] Catalog offline.",
          },
          signal: { kind: "unscoped" },
          loadSegments,
        })}
      />,
    );

    expect(alert().textContent).toContain(
      "We couldn’t establish a safe audience scope.",
    );
    expect(alert().textContent).toContain(
      "[segments_unavailable] Catalog offline.",
    );
    click("Retry segments");
    expect(loadSegments).toHaveBeenCalledOnce();
  });

  it("explains an empty catalog and routes the operator to segment creation", () => {
    render(
      <SendTimeAudiencePanel
        controller={audienceController({
          catalog: { kind: "ready", segments: [] },
          signal: { kind: "unscoped" },
        })}
      />,
    );

    expect(select("send-time-segment").textContent).toContain(
      "No saved segments",
    );
    expect(text()).toContain("There are no saved segments to analyze yet.");
    click("Create a segment");
    expect(mocks.setSection).toHaveBeenLastCalledWith("segments");
  });

  it("labels the selected audience while its measured signal is loading", () => {
    render(
      <SendTimeAudiencePanel
        controller={audienceController({
          selectedSegment: SEGMENT,
          selectedSegmentId: SEGMENT.id,
          signal: { kind: "loading" },
        })}
      />,
    );

    const status = role("status");
    expect(status.getAttribute("aria-label")).toBe("Analyzing Engaged readers");
    expect(status.textContent).toContain(
      "Loading engagement pattern for Engaged readers.",
    );
    expect(document.querySelector(".stx-stat-strip")).toBeNull();
  });

  it("explains insufficient signal and wires recheck and segment-review actions", () => {
    const reloadSignal = vi.fn(async () => undefined);
    render(
      <SendTimeAudiencePanel
        controller={audienceController({
          selectedSegment: SEGMENT,
          selectedSegmentId: SEGMENT.id,
          signal: {
            kind: "insufficient",
            message: "Only 18 members currently have qualifying engagement.",
          },
          reloadSignal,
        })}
      />,
    );

    const status = role("status");
    expect(status.textContent).toContain("The pattern is still taking shape.");
    expect(status.textContent).toContain("at least 30 members");
    click("Check again");
    expect(reloadSignal).toHaveBeenCalledOnce();
    click("Review segment");
    expect(mocks.setSection).toHaveBeenLastCalledWith("segments");
  });

  it("announces an analysis failure and retries only the selected signal", () => {
    const reloadSignal = vi.fn(async () => undefined);
    render(
      <SendTimeAudiencePanel
        controller={audienceController({
          selectedSegment: SEGMENT,
          selectedSegmentId: SEGMENT.id,
          signal: {
            kind: "error",
            message: "[temporarily_unavailable] Model offline.",
          },
          reloadSignal,
        })}
      />,
    );

    expect(alert().textContent).toContain(
      "The audience analysis could not be loaded.",
    );
    expect(alert().textContent).toContain(
      "[temporarily_unavailable] Model offline.",
    );
    click("Retry analysis");
    expect(reloadSignal).toHaveBeenCalledOnce();
  });

  it("renders measured statistics, model caveats, warning metadata, and contextual actions", () => {
    const setSelectedSegmentId = vi.fn();
    render(
      <SendTimeAudiencePanel
        controller={audienceController({
          selectedSegment: SEGMENT,
          selectedSegmentId: SEGMENT.id,
          setSelectedSegmentId,
          signal: {
            kind: "ready",
            heatmap: audienceHeatmap(),
            best: segmentBest(),
            bestWarning: "Coverage service returned a stale snapshot.",
          },
        })}
      />,
    );

    expect(text()).toContain("Measured recommendation");
    expect(text()).toContain("Engaged readers · 1,284 total members");
    expect(text()).toContain("Tue · 9 AM");
    expect(text()).toContain("76%");
    expect(text()).toContain("842");
    expect(text()).toContain("Thu · 2 PM");
    expect(role("status").textContent).toContain(
      "Coverage service returned a stale snapshot.",
    );
    expect(text()).toContain("Recommendations describe past behavior");
    expect(text()).toContain("UTC source buckets · local projection available");
    expect(document.querySelector("table.data-table")).not.toBeNull();

    click("Manage");
    expect(mocks.setSection).toHaveBeenLastCalledWith("segments");

    const scope = select("send-time-segment");
    act(() => {
      scope.value = "";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(setSelectedSegmentId).toHaveBeenLastCalledWith("");
  });
});

describe("SendTimeSubscriberInspector presentation", () => {
  it("renders an idle privacy-safe lookup and routes to subscriber discovery", () => {
    render(<SendTimeSubscriberInspector controller={subscriberController()} />);

    expect(text()).toContain("Ready for a precise lookup");
    expect(text()).toContain("Confidential");
    expect(input("send-time-subscriber-id").getAttribute("autocomplete")).toBe(
      "off",
    );
    expect(text()).toContain(
      "The analysis endpoint accepts a UUID, not an email address.",
    );
    click("Find a subscriber");
    expect(mocks.setSection).toHaveBeenLastCalledWith("subscribers");
  });

  it("locks duplicate input while loading and exposes a polite busy state", () => {
    render(
      <SendTimeSubscriberInspector
        controller={subscriberController({
          lookupId: SUBSCRIBER_ID,
          state: { kind: "loading", lookupKey: SUBSCRIBER_ID },
        })}
      />,
    );

    const section = document.querySelector(".stx-inspector");
    expect(section?.getAttribute("aria-busy")).toBe("true");
    expect(input("send-time-subscriber-id").disabled).toBe(true);
    expect(button("Inspecting…").disabled).toBe(true);
    expect(role("status").textContent).toContain(
      "Loading subscriber send-time recommendation.",
    );
  });

  it("presents malformed input as an associated field error", () => {
    render(
      <SendTimeSubscriberInspector
        controller={subscriberController({
          lookupId: "reader@example.com",
          inputError:
            "Enter a full subscriber UUID (8-4-4-4-12 hexadecimal format).",
        })}
      />,
    );

    const lookup = input("send-time-subscriber-id");
    expect(lookup.getAttribute("aria-invalid")).toBe("true");
    expect(lookup.getAttribute("aria-describedby")).toBe(
      "send-time-subscriber-error",
    );
    expect(alert().textContent).toContain("full subscriber UUID");
  });

  it("submits on Enter but ignores an IME composition Enter", () => {
    const submit = vi.fn(async () => undefined);
    render(
      <SendTimeSubscriberInspector
        controller={subscriberController({
          lookupId: SUBSCRIBER_ID,
          submit,
        })}
      />,
    );
    const lookup = input("send-time-subscriber-id");

    act(() => {
      lookup.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          isComposing: true,
        }),
      );
    });
    expect(submit).not.toHaveBeenCalled();

    act(() => {
      lookup.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(submit).toHaveBeenCalledOnce();
  });

  it("clears an entered identifier through its named control", () => {
    const clear = vi.fn();
    render(
      <SendTimeSubscriberInspector
        controller={subscriberController({
          lookupId: SUBSCRIBER_ID,
          clear,
        })}
      />,
    );

    click("Clear subscriber lookup", "aria-label");
    expect(clear).toHaveBeenCalledOnce();
  });

  it("distinguishes a cold model without fabricating a send window", () => {
    render(
      <SendTimeSubscriberInspector
        controller={subscriberController({
          lookupId: SUBSCRIBER_ID,
          state: { kind: "cold", lookupKey: SUBSCRIBER_ID },
        })}
      />,
    );

    const status = role("status");
    expect(status.textContent).toContain(
      "Still learning this subscriber’s rhythm",
    );
    expect(status.textContent).toContain("at least 5 qualifying engagement");
    expect(status.textContent).toContain("…11111111");
    expect(status.textContent).not.toContain("Recommended UTC window");
  });

  it("announces lookup failure and wires a retry", () => {
    const submit = vi.fn(async () => undefined);
    render(
      <SendTimeSubscriberInspector
        controller={subscriberController({
          lookupId: SUBSCRIBER_ID,
          state: {
            kind: "error",
            message: "[temporarily_unavailable] Recommendation offline.",
          },
          submit,
        })}
      />,
    );

    expect(alert().textContent).toContain("Recommendation unavailable");
    expect(alert().textContent).toContain(
      "[temporarily_unavailable] Recommendation offline.",
    );
    click("Try again");
    expect(submit).toHaveBeenCalledOnce();
  });

  it("renders a complete recommendation with masked identity and inspectable weekly data", () => {
    render(
      <SendTimeSubscriberInspector
        controller={subscriberController({
          lookupId: SUBSCRIBER_ID,
          state: {
            kind: "ready",
            lookupKey: SUBSCRIBER_ID,
            recommendation: recommendation(),
            pattern: subscriberPattern(),
            patternWarning: null,
          },
        })}
      />,
    );

    expect(text()).toContain("Recommended UTC window");
    expect(text()).toContain("9:00 AM");
    expect(text()).toContain("Tuesday");
    expect(text()).toContain("37 events");
    expect(text()).toContain("al…@example.com");
    expect(text()).not.toContain("alice.sensitive@example.com");
    expect(text()).toContain("Weekly engagement pattern");
    expect(text()).toContain("up to 2,000 events · 37 used");
    expect(document.querySelector("table.data-table")).not.toBeNull();
    expect(text()).toContain("Moosewave subscriber engagement-pattern API");
  });

  it("keeps a scalar recommendation usable when detailed pattern loading warns", () => {
    render(
      <SendTimeSubscriberInspector
        controller={subscriberController({
          lookupId: SUBSCRIBER_ID,
          state: {
            kind: "ready",
            lookupKey: SUBSCRIBER_ID,
            recommendation: recommendation(),
            pattern: null,
            patternWarning:
              "[pattern_unavailable] Detailed distribution offline.",
          },
        })}
      />,
    );

    expect(text()).toContain("9:00 AM");
    expect(role("status").textContent).toContain(
      "[pattern_unavailable] Detailed distribution offline.",
    );
    expect(text()).toContain(
      "The cached UTC recommendation above remains available",
    );
    expect(document.querySelector("table.data-table")).toBeNull();
  });
});

describe("SendTimeHeatmap presentation", () => {
  it("persists timezone selection and accurately discloses local projection limits", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);
    render(<SendTimeHeatmap {...heatmapProps()} />);

    expect(
      button("Show hours in UTC", "aria-label").getAttribute("aria-pressed"),
    ).toBe("true");
    click("Show hours in this device's timezone", "aria-label");

    expect(
      button("Show hours in this device's timezone", "aria-label").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(localStorage.getItem(TZ_PREF_KEY)).toBe("local");
    expect(text()).toContain(
      "Current device offset; historical DST is not re-bucketed",
    );
    expect(document.querySelector("thead")?.textContent).toContain("5:30 AM");
  });

  it("provides an equivalent native table, summary, provenance, and confidential export control", () => {
    render(<SendTimeHeatmap {...heatmapProps()} />);

    const disclosure = document.querySelector("details.pw-chart-data");
    const table = document.querySelector("table.data-table");
    expect(disclosure).not.toBeNull();
    expect(table?.querySelectorAll("thead th")).toHaveLength(25);
    expect(table?.querySelectorAll("tbody tr")).toHaveLength(7);
    expect(table?.querySelector("caption")?.textContent).toBe(
      "Test engagement density data",
    );
    expect(text()).toContain("Peak Tuesday at 9 AM UTC");
    expect(text()).toContain("Moosewave model fixture");
    expect(text()).toContain("Saved segment · trailing 180 days");
    expect(text()).toContain("Weighted engagement fixture.");
    expect(
      button("Export Test engagement density data as CSV", "aria-label"),
    ).not.toBeNull();
  });

  it("switches a measured narrow container to the ranked mobile representation", () => {
    let observerCallback: ResizeObserverCallback | null = null;
    class ControlledResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal(
      "ResizeObserver",
      ControlledResizeObserver as unknown as typeof ResizeObserver,
    );

    render(<SendTimeHeatmap {...heatmapProps()} />);
    expect(text()).not.toContain("Top send times");
    act(() => {
      observerCallback?.(
        [
          {
            contentRect: { width: 420 },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    });

    expect(text()).toContain("Top send times");
    expect(text()).toContain("Tuesday · 9 AM");
    expect(document.querySelector("table.data-table")).not.toBeNull();
  });
});

describe("SendTimeWorkspacePolicy presentation", () => {
  it("renders a non-interactive checking state for an admin", () => {
    render(
      <SendTimeWorkspacePolicy
        canAdmin
        controller={workspaceController({ state: { kind: "loading" } })}
      />,
    );

    expect(text()).toContain("Checking");
    expect(text()).toContain("Reading the server-owned workspace setting.");
    const control = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(control?.disabled).toBe(true);
    expect(control?.getAttribute("aria-checked")).toBe("false");
  });

  it("fails closed when policy verification errors and wires a reload", () => {
    const load = vi.fn(async () => undefined);
    render(
      <SendTimeWorkspacePolicy
        canAdmin
        controller={workspaceController({
          state: {
            kind: "error",
            message: "[policy_unavailable] Setting offline.",
          },
          load,
        })}
      />,
    );

    expect(alert().textContent).toContain(
      "[policy_unavailable] Setting offline.",
    );
    expect(text()).toContain("must not be assumed");
    expect(document.querySelector('[role="switch"]')).toBeNull();
    click("Retry");
    expect(load).toHaveBeenCalledOnce();
  });

  it("shows verified policy semantics as protected read-only state to viewers", () => {
    render(
      <SendTimeWorkspacePolicy
        canAdmin={false}
        controller={workspaceController({
          state: { kind: "ready", enabled: true },
        })}
      />,
    );

    expect(text()).toContain("Enabled");
    expect(text()).toContain(
      "New campaigns start with a 24-hour personalized delivery window.",
    );
    expect(text()).toContain("Existing campaigns and analysis are unchanged.");
    expect(text()).toContain("Read only · an admin controls this setting");
    expect(text()).toContain("Protected");
    expect(document.querySelector('[role="switch"]')).toBeNull();
  });

  it("gives admins a semantic switch and sends the inverse verified state", () => {
    const setEnabled = vi.fn(async () => undefined);
    const view = render(
      <SendTimeWorkspacePolicy
        canAdmin
        controller={workspaceController({
          state: { kind: "ready", enabled: true },
          setEnabled,
        })}
      />,
    );

    let control = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(control?.getAttribute("aria-checked")).toBe("true");
    expect(control?.getAttribute("aria-label")).toContain(
      "by default for new campaigns",
    );
    expect(text()).toContain("Admin control · applies to every operator");
    act(() => control?.click());
    expect(setEnabled).toHaveBeenCalledWith(false);

    view.rerender(
      <SendTimeWorkspacePolicy
        canAdmin
        controller={workspaceController({
          state: { kind: "ready", enabled: false },
          saving: true,
          setEnabled,
        })}
      />,
    );
    control = document.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(control?.disabled).toBe(true);
    expect(control?.getAttribute("aria-checked")).toBe("false");
    expect(control?.textContent).toContain("Saving…");
  });
});

function audienceController(
  overrides: Partial<AudienceController> = {},
): AudienceController {
  const catalog: SegmentCatalogState = {
    kind: "ready",
    segments: [SEGMENT],
  };
  const signal: AudienceSignalState = { kind: "unscoped" };
  return {
    catalog,
    selectedSegment: null,
    selectedSegmentId: "",
    setSelectedSegmentId: vi.fn(),
    signal,
    loadSegments: vi.fn(async () => undefined),
    reloadSignal: vi.fn(async () => undefined),
    ...overrides,
  };
}

function subscriberController(
  overrides: Partial<SubscriberController> = {},
): SubscriberController {
  const state: SubscriberLookupState = { kind: "idle" };
  return {
    lookupId: "",
    setLookupId: vi.fn(),
    inputError: null,
    state,
    submit: vi.fn(async () => undefined),
    clear: vi.fn(),
    ...overrides,
  };
}

function workspaceController(
  overrides: Partial<WorkspaceController> = {},
): WorkspaceController {
  const state: WorkspaceSettingState = { kind: "ready", enabled: false };
  return {
    state,
    saving: false,
    load: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    enabled: state.kind === "ready" && state.enabled,
    ...overrides,
  };
}

function audienceHeatmap(): SegmentHeatmapResponse {
  const grid = weeklyGrid();
  grid[2]![9] = 42;
  grid[4]![14] = 31;
  return {
    segment_id: SEGMENT.id,
    subscribers_with_data: 842,
    grid,
    best_dow: 2,
    best_hour: 9,
    secondary_dow: 4,
    secondary_hour: 14,
    has_secondary_window: true,
    computed_at: "2026-07-26T10:00:00.000Z",
  };
}

function segmentBest(): SegmentBestSendTime {
  return {
    best_hour_utc: "09:00",
    confidence: 0.756,
    sample_size: 842,
    computed_at: "2026-07-26T10:00:00.000Z",
  };
}

function recommendation(): BestSendTime {
  return {
    email: "alice.sensitive@example.com",
    best_hour_utc: 57,
    computed_at: "2026-07-26T10:00:00.000Z",
    sample_size: 29,
  };
}

function subscriberPattern(): SubscriberOpenPattern {
  const grid = weeklyGrid();
  grid[2]![9] = 18;
  grid[4]![14] = 11;
  return {
    sample_size: 37,
    grid,
    best_dow: 2,
    best_hour: 9,
    secondary_dow: 4,
    secondary_hour: 14,
    bimodal: true,
    computed_at: "2026-07-26T10:00:00.000Z",
  };
}

function heatmapProps() {
  const grid = weeklyGrid();
  grid[2]![9] = 42;
  grid[4]![14] = 21;
  return {
    title: "Test engagement density",
    hint: "842 members with signal",
    grid,
    primary: { dow: 2, hour: 9 },
    secondary: { dow: 4, hour: 14 },
    provenance: {
      source: "Moosewave model fixture",
      asOf: "2026-07-26T10:00:00.000Z",
      scope: "Saved segment · trailing 180 days",
      note: "Weighted engagement fixture.",
    },
    exportFileName: "send-time-test.csv",
    exportPrivacy: "confidential" as const,
  };
}

function weeklyGrid(): number[][] {
  return Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
}

function render(node: ReactElement): {
  rerender: (next: ReactElement) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return {
    rerender: (next) => act(() => root?.render(next)),
  };
}

function text(): string {
  return document.body.textContent ?? "";
}

function role(name: string): HTMLElement {
  const match = document.querySelector<HTMLElement>(`[role="${name}"]`);
  if (!match) throw new Error(`Missing role: ${name}`);
  return match;
}

function alert(): HTMLElement {
  return role("alert");
}

function button(
  label: string,
  source: "text" | "aria-label" = "text",
): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) =>
    source === "aria-label"
      ? candidate.getAttribute("aria-label") === label
      : candidate.textContent?.includes(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function click(label: string, source: "text" | "aria-label" = "text"): void {
  act(() => button(label, source).click());
}

function input(id: string): HTMLInputElement {
  const match = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!match) throw new Error(`Missing input: ${id}`);
  return match;
}

function select(id: string): HTMLSelectElement {
  const match = document.querySelector<HTMLSelectElement>(`#${id}`);
  if (!match) throw new Error(`Missing select: ${id}`);
  return match;
}
