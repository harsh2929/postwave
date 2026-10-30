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

import type { List, ListHealthResult } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  canWrite: { value: true },
  getListHealth: vi.fn(),
}));

vi.mock("../../hooks/useSlideoverBehavior", () => ({
  useSlideoverBehavior: vi.fn(),
}));

vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite.value,
}));

vi.mock("../../lib/api-client", () => ({
  api: { getListHealth: mocks.getListHealth },
}));

vi.mock("../../components/lists/tabs/OverviewTab", () => ({
  OverviewTab: ({
    health,
  }: {
    health: { grade?: string } | null | undefined;
  }) => (
    <div data-testid="overview-health">
      {health === undefined
        ? "health:loading"
        : health === null
          ? "health:none"
          : `health:${health.grade ?? "unknown"}`}
    </div>
  ),
}));

vi.mock("../../components/lists/tabs/MembersTab", () => ({
  MembersTab: ({
    onTotalChange,
  }: {
    onTotalChange?: (total: number) => void;
  }) => (
    <button type="button" onClick={() => onTotalChange?.(4321)}>
      Set member total
    </button>
  ),
}));

vi.mock("../../components/lists/tabs/SettingsTab", () => ({
  SettingsTab: ({
    list,
    onUpdated,
    onDraftStateChange,
  }: {
    list: List;
    onUpdated: (next: List) => void;
    onDraftStateChange?: (state: {
      dirty: boolean;
      operationActive: boolean;
    }) => void;
  }) => (
    <>
      <button
        type="button"
        onClick={() => onUpdated({ ...list, name: "Renamed audience" })}
      >
        Rename from settings
      </button>
      <button
        type="button"
        onClick={() =>
          onDraftStateChange?.({ dirty: true, operationActive: false })
        }
      >
        Mark settings dirty
      </button>
      <button
        type="button"
        onClick={() =>
          onDraftStateChange?.({ dirty: true, operationActive: true })
        }
      >
        Mark settings saving
      </button>
    </>
  ),
}));

vi.mock("../../components/lists/tabs/ActivityTab", () => ({
  ActivityTab: () => <div>activity</div>,
}));

vi.mock("../../components/lists/tabs/AnalyticsTab", () => ({
  AnalyticsTab: () => <div>analytics</div>,
}));

vi.mock("../../components/lists/tabs/AutomationsTab", () => ({
  AutomationsTab: () => <div>automations</div>,
}));

vi.mock("../../components/lists/tabs/FormsTab", () => ({
  FormsTab: () => <div>forms</div>,
}));

vi.mock("../../components/lists/tabs/InboxRealityTab", () => ({
  InboxRealityTab: () => <div>inbox</div>,
}));

vi.mock("../../components/lists/tabs/MergeFieldsTab", () => ({
  MergeFieldsTab: () => <div>merge</div>,
}));

vi.mock("../../components/lists/tabs/SuppressionTab", () => ({
  SuppressionTab: () => <div>suppression</div>,
}));

vi.mock("../../components/lists/tabs/WebhooksTab", () => ({
  WebhooksTab: () => <div>webhooks</div>,
}));

import { ListDetailSlideover } from "../../components/lists/ListDetailSlideover";

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
  mocks.canWrite.value = true;
  mocks.getListHealth.mockReset();
  mocks.getListHealth.mockResolvedValue({ data: health() });
});

afterEach(() => {
  if (root) {
    const currentRoot = root;
    act(() => currentRoot.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  vi.clearAllMocks();
});

function list(overrides: Partial<List> = {}): List {
  return {
    id: 7,
    name: "Newsletter",
    type: "public",
    optin: "double",
    description: "Weekly product notes",
    subscriber_count: 12,
    created_at: "2026-07-01T08:00:00.000Z",
    updated_at: "2026-07-15T08:00:00.000Z",
    ...overrides,
  };
}

function health(overrides: Partial<ListHealthResult> = {}): ListHealthResult {
  return {
    tag: "Newsletter",
    window_days: 90,
    total_subscribers: 12,
    active_subscribers: 10,
    engaged_subscribers: 8,
    blocklisted_count: 0,
    bounces: 0,
    complaints: 0,
    unsubscribes: 1,
    bounce_rate: 0,
    complaint_rate: 0,
    unsubscribe_rate: 0.01,
    engagement_rate: 0.8,
    suppression_rate: 0.01,
    score: 94,
    grade: "A",
    notes: [],
    ...overrides,
  };
}

function component({
  selected = list(),
  onClose = vi.fn(),
  onEdit = vi.fn(),
  onDelete = vi.fn(),
}: {
  selected?: List;
  onClose?: () => void;
  onEdit?: (value: List) => void;
  onDelete?: (value: List) => void;
} = {}): ReactElement {
  return (
    <ListDetailSlideover
      list={selected}
      onClose={onClose}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

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

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function tabButton(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".pw-list-slideover-tab"),
  ).find((candidate) => candidate.querySelector("span")?.textContent === label);
  if (!match) throw new Error(`Missing tab: ${label}`);
  return match;
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
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("ListDetailSlideover", () => {
  it("requires explicit discard before a dirty settings tab is dismissed", async () => {
    const onClose = vi.fn();
    render(component({ onClose }));
    act(() => tabButton("Settings").click());
    act(() => button("Mark settings dirty").click());

    act(() => tabButton("Overview").click());
    expect(button("Discard changes")).toBeTruthy();
    expect(tabButton("Settings").getAttribute("aria-selected")).toBe("true");
    act(() => button("Cancel").click());
    expect(tabButton("Settings").getAttribute("aria-selected")).toBe("true");

    act(() =>
      document
        .querySelector<HTMLButtonElement>(".pw-list-slideover-close")
        ?.click(),
    );
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => button("Discard changes").click());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("waits instead of dismissing settings while their save is active", async () => {
    const onClose = vi.fn();
    render(component({ onClose }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("health:A"),
    );
    act(() => tabButton("Settings").click());
    act(() => button("Mark settings saving").click());

    const close = document.querySelector<HTMLButtonElement>(
      ".pw-list-slideover-close",
    )!;
    expect(close.disabled).toBe(true);
    expect(tabButton("Overview").disabled).toBe(true);
    act(() => close.click());
    expect(onClose).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(
      "Discard list settings changes?",
    );
  });

  it("keeps viewer mutations hidden and rejects fabricated zero-signal health", async () => {
    mocks.canWrite.value = false;
    mocks.getListHealth.mockResolvedValueOnce({
      data: health({ total_subscribers: 0, score: 100, grade: "A" }),
    });
    render(component());

    await waitFor(() => {
      expect(document.body.textContent).toContain("health:none");
    });
    expect(document.body.textContent).not.toContain("Edit");
    expect(document.body.textContent).not.toContain("Delete");
    expect(document.body.textContent).not.toContain("Copy public URL");
    expect(
      document.querySelector('[title^="Public in the audience service"]'),
    ).not.toBeNull();
  });

  it("uses a settings update for header actions and renders genuine health", async () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(component({ onEdit, onDelete }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("health:A"),
    );

    act(() => button("Settings").click());
    await act(async () => {
      button("Rename from settings").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("Renamed audience");
    expect(mocks.getListHealth).toHaveBeenCalledTimes(2);
    act(() => button("Edit").click());
    act(() => button("Delete").click());

    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, name: "Renamed audience" }),
    );
    expect(onDelete).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, name: "Renamed audience" }),
    );
  });

  it("refetches same-name list switches, resets the tab, and ignores stale health", async () => {
    const first = deferred<{ data: ListHealthResult }>();
    const second = deferred<{ data: ListHealthResult }>();
    mocks.getListHealth
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = render(component({ selected: list({ id: 1 }) }));
    act(() => tabButton("Members").click());
    expect(document.body.textContent).toContain("Set member total");

    view.rerender(component({ selected: list({ id: 2 }) }));
    await waitFor(() => expect(mocks.getListHealth).toHaveBeenCalledTimes(2));
    expect(document.body.textContent).toContain("health:loading");

    first.resolve({ data: health({ grade: "F" }) });
    second.resolve({ data: health({ grade: "B" }) });
    await waitFor(() =>
      expect(document.body.textContent).toContain("health:B"),
    );
    expect(document.body.textContent).not.toContain("health:F");
  });

  it("updates the header and tab count from the members endpoint total", async () => {
    render(component());
    await waitFor(() =>
      expect(document.body.textContent).toContain("health:A"),
    );
    act(() => tabButton("Members").click());
    act(() => button("Set member total").click());

    expect(tabButton("Members").textContent).toContain("4,321");
    expect(document.body.textContent).toContain("4,321 subscribers");
  });

  it("does not query tag health for an unnamed list", async () => {
    render(component({ selected: list({ name: "" }) }));
    await waitFor(() =>
      expect(document.body.textContent).toContain("health:none"),
    );
    expect(mocks.getListHealth).not.toHaveBeenCalled();
  });
});
