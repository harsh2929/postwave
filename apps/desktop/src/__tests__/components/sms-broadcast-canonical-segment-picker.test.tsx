// @vitest-environment happy-dom

import { act, type ReactElement, type ReactNode } from "react";
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
  listSenders: vi.fn(),
  listSmsLists: vi.fn(),
  listSegments: vi.fn(),
  listTags: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  registerLifecycleGuard: vi.fn(() => vi.fn()),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listSMSSenders: mocks.listSenders,
    listTags: mocks.listTags,
  },
  smsBroadcastsApi: {
    create: mocks.createBroadcast,
    update: mocks.updateBroadcast,
  },
}));

vi.mock("../../lib/sms-a2p-api", () => ({
  listSmsLists: mocks.listSmsLists,
}));

vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: mocks.registerLifecycleGuard,
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { list: mocks.listSegments },
}));

vi.mock("../../components/Modal", () => ({
  Modal: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
  }) =>
    open ? (
      <section role="dialog" aria-label={title}>
        {children}
      </section>
    ) : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { BroadcastComposerModal } from "../../components/sms/broadcasts/BroadcastComposerModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSenders.mockResolvedValue({ data: { items: [] } });
  mocks.listSmsLists.mockResolvedValue({ data: { items: [] } });
  mocks.listSegments.mockResolvedValue({
    data: [
      {
        id: "canonical-segment-001",
        name: "Recently engaged subscribers",
        lastCount: 421,
      },
    ],
  });
  mocks.listTags.mockResolvedValue({ data: { items: [] } });
  mocks.createBroadcast.mockResolvedValue({
    data: {
      id: "broadcast-001",
      name: "Launch notice",
      body: "The launch is live.",
      list_ids: [],
      segment_id: "canonical-segment-001",
      tag: "",
      status: "draft",
      sent_count: 0,
      failed_count: 0,
      held_count: 0,
      segments_per_message: 1,
      created_at: "2026-07-18T12:00:00Z",
      updated_at: "2026-07-18T12:00:00Z",
    },
  });
  mocks.updateBroadcast.mockResolvedValue({ data: null });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
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

function setInput(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelect(target: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(target, value);
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function renderComposer(onSaved = vi.fn()): void {
  render(
    <BroadcastComposerModal
      open
      existing={null}
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  );
}

describe("SMS broadcast canonical segment picker", () => {
  it("shows a real loading state before exposing canonical choices", async () => {
    let resolveSegments!: (value: unknown) => void;
    mocks.listSegments.mockReturnValue(
      new Promise((resolve) => {
        resolveSegments = resolve;
      }),
    );
    renderComposer();
    act(() => button("Segment").click());

    expect(document.body.textContent).toContain("Loading canonical segments…");
    expect(document.querySelector('select[aria-label="Segment"]')).toBeNull();

    await act(async () => {
      resolveSegments({
        data: [
          {
            id: "canonical-segment-001",
            name: "Recently engaged subscribers",
            lastCount: 421,
          },
        ],
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    const picker = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Segment"]',
    );
    if (!picker) throw new Error("Missing segment picker");
    expect(Array.from(picker.options).map((option) => option.value)).toEqual([
      "",
      "canonical-segment-001",
    ]);
    expect(picker.textContent).toContain("Recently engaged subscribers (421)");
  });

  it("persists the selected canonical segment id and clears other audiences", async () => {
    const onSaved = vi.fn();
    renderComposer(onSaved);
    await settle();
    act(() => button("Segment").click());

    const name = document.querySelector<HTMLInputElement>(
      'input[placeholder="June flash sale"]',
    );
    const body = document.querySelector<HTMLTextAreaElement>(
      'textarea[placeholder="Type the broadcast message…"]',
    );
    const picker = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Segment"]',
    );
    if (!name || !body || !picker) throw new Error("Missing broadcast fields");
    setInput(name, "Launch notice");
    setInput(body, "The launch is live.");
    setSelect(picker, "canonical-segment-001");

    act(() => button("Create draft").click());
    await settle();

    expect(mocks.createBroadcast).toHaveBeenCalledWith({
      name: "Launch notice",
      body: "The launch is live.",
      sender_profile_id: "",
      list_ids: [],
      segment_id: "canonical-segment-001",
      tag: "",
      scheduled_at: null,
    });
    expect(onSaved).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "broadcast-001",
        segment_id: "canonical-segment-001",
      }),
    );
  });

  it("distinguishes a failed catalog from an empty catalog and retries safely", async () => {
    mocks.listSegments
      .mockResolvedValueOnce({
        error: {
          kind: "network",
          code: "offline",
          message: "private gateway and tenant detail",
        },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: "canonical-segment-002",
            name: "Recovered segment",
          },
        ],
      });
    renderComposer();
    act(() => button("Segment").click());
    await settle();

    expect(document.body.textContent).toContain(
      "Couldn't load canonical segments.",
    );
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private gateway");
    expect(document.body.textContent).not.toContain(
      "No segments available — create one",
    );

    act(() => button("Retry segments").click());
    expect(document.body.textContent).toContain("Loading canonical segments…");
    await settle();

    expect(mocks.listSegments).toHaveBeenCalledTimes(2);
    const picker = document.querySelector<HTMLSelectElement>(
      'select[aria-label="Segment"]',
    );
    if (!picker) throw new Error("Missing recovered segment picker");
    expect(Array.from(picker.options).map((option) => option.value)).toContain(
      "canonical-segment-002",
    );
  });
});
