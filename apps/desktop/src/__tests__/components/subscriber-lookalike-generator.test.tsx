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

import type { SubscriberLookalikeAudience } from "../../lib/api/subscriber-lookalike";
import { resetLifecycleCoordinatorForTests } from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  export: vi.fn(),
  listDestinations: vi.fn(),
  listLookalikes: vi.fn(),
  listSegments: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  waitForTerminal: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  audienceDestinationsApi: { list: mocks.listDestinations },
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { list: mocks.listSegments },
}));

vi.mock("../../lib/api/subscriber-lookalike", () => ({
  lookalikeApi: {
    create: mocks.create,
    export: mocks.export,
    list: mocks.listLookalikes,
    remove: mocks.remove,
    waitForTerminal: mocks.waitForTerminal,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import { LookalikeGeneratorModal } from "../../components/subscribers/LookalikeGeneratorModal";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function audience(
  overrides: Partial<SubscriberLookalikeAudience> = {},
): SubscriberLookalikeAudience {
  return {
    id: "audience-1",
    name: "Readers alike",
    seed_segment_id: "eligible",
    size_requested: 1_000,
    member_count: 42,
    seed_count: 75,
    confidence_threshold: 0.8,
    model_version: "first-party-v1",
    status: "ready",
    payload: {
      candidate_count: 500,
      scored: 42,
      bands: { high: 12, medium: 30, low: 0 },
      feature_dims: [
        "email_domain",
        "signup_source",
        "engagement",
        "retention",
      ],
    },
    created_at: "2026-07-18T08:00:00Z",
    updated_at: "2026-07-18T08:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSegments.mockResolvedValue({
    data: [
      { id: "unknown", name: "Never evaluated" },
      { id: "small", name: "Tiny", lastCount: 49 },
      { id: "eligible", name: "Engaged readers", lastCount: 75 },
    ],
  });
  mocks.listLookalikes.mockResolvedValue({ data: { items: [] } });
  mocks.listDestinations.mockResolvedValue({ data: { items: [] } });
  mocks.remove.mockResolvedValue({ data: undefined });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function acknowledge(): void {
  const checkbox = document.querySelector<HTMLInputElement>(
    ".lookalike-acknowledgement input",
  );
  if (!checkbox) throw new Error("Missing data-use acknowledgement");
  act(() => checkbox.click());
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLSelectElement.prototype,
      "value",
    )?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }
  throw last;
}

describe("subscriber lookalike generator", () => {
  it("gates generation on eligible live-size guidance and explicit data-use acknowledgement", async () => {
    mocks.create.mockResolvedValue({ data: audience() });
    render(
      <LookalikeGeneratorModal
        open
        canMutate
        selectedCount={3}
        onClose={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.getElementById("lookalike-seed")).not.toBeNull();
    });
    const options = Array.from(
      document.querySelectorAll<HTMLOptionElement>("#lookalike-seed option"),
    );
    expect(options.map((option) => option.value)).toEqual(["eligible"]);
    expect(document.body.textContent).toContain(
      "3 selected rows are not the seed",
    );
    expect(document.body.textContent).toContain(
      "Ranked subscriber identifiers and emails are materialized",
    );
    expect(button("Generate audience").getAttribute("aria-disabled")).toBe(
      "true",
    );

    act(() => button("Generate audience").click());
    expect(mocks.create).not.toHaveBeenCalled();
    acknowledge();
    act(() => button("Generate audience").click());

    await waitFor(() => {
      expect(mocks.create).toHaveBeenCalledWith({
        name: "Lookalike of 3 selected",
        seed_segment_id: "eligible",
        size: 1_000,
        confidence_threshold: 0.8,
        data_use_acknowledged: true,
      });
      expect(document.body.textContent).toContain("Aggregate model evidence");
      expect(document.body.textContent).toContain("Email domain");
    });
    expect(mocks.waitForTerminal).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private@example.com");
  });

  it("stops only status polling, preserves the server job, and resumes without duplicate generation", async () => {
    let firstSignal: AbortSignal | undefined;
    mocks.create.mockResolvedValue({
      data: audience({ status: "pending", member_count: 0 }),
    });
    mocks.waitForTerminal
      .mockImplementationOnce(
        async (_id: string, options: { signal?: AbortSignal }) => {
          firstSignal = options.signal;
          return new Promise((resolve) => {
            options.signal?.addEventListener(
              "abort",
              () =>
                resolve({
                  error: {
                    code: "aborted",
                    message: "stopped",
                    kind: "network",
                  },
                }),
              { once: true },
            );
          });
        },
      )
      .mockResolvedValueOnce({ data: audience() });
    render(<LookalikeGeneratorModal open canMutate onClose={vi.fn()} />);
    await waitFor(() => {
      expect(document.getElementById("lookalike-seed")).not.toBeNull();
    });
    acknowledge();
    act(() => button("Generate audience").click());

    await waitFor(() => expect(button("Stop checking")).not.toBeNull());
    act(() => button("Stop checking").click());
    await waitFor(() => {
      expect(firstSignal?.aborted).toBe(true);
      expect(document.body.textContent).toContain(
        "This did not cancel the server-side job",
      );
      expect(button("Check status")).not.toBeNull();
    });

    act(() => button("Check status").click());
    await waitFor(() => {
      expect(document.body.textContent).toContain("Audience materialized");
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.waitForTerminal).toHaveBeenCalledTimes(2);
  });

  it("records only configured destinations with honest delivery copy and supports confirmed deletion", async () => {
    const ready = audience();
    const handedOff = audience({ exported_destination_id: "destination-1" });
    mocks.listLookalikes.mockResolvedValue({ data: { items: [ready] } });
    mocks.listDestinations.mockResolvedValue({
      data: {
        items: [
          {
            id: "destination-1",
            tenant_id: "tenant-1",
            provider: "meta",
            status: "active",
            config: {},
            created_at: "2026-07-18T08:00:00Z",
            updated_at: "2026-07-18T08:00:00Z",
          },
        ],
      },
    });
    mocks.export.mockResolvedValue({ data: handedOff });
    render(<LookalikeGeneratorModal open canMutate onClose={vi.fn()} />);

    await waitFor(() => {
      expect(document.querySelector(".lookalike-recent-item")).not.toBeNull();
    });
    act(() =>
      document
        .querySelector<HTMLButtonElement>(".lookalike-recent-item")!
        .click(),
    );
    choose(
      document.getElementById("lookalike-destination") as HTMLSelectElement,
      "destination-1",
    );
    act(() => button("Record destination").click());

    await waitFor(() => {
      expect(mocks.export).toHaveBeenCalledWith("audience-1", "destination-1");
      expect(document.body.textContent).toContain(
        "This screen does not claim that subscriber data was delivered",
      );
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      "Destination recorded. Provider delivery has not started; run and monitor it from Audience Syncs.",
    );

    act(() => button("Delete audience").click());
    const confirmDelete = document.querySelector<HTMLButtonElement>(
      '[role="alertdialog"] .btn-danger',
    );
    if (!confirmDelete) throw new Error("Missing delete confirmation");
    act(() => confirmDelete.click());
    await waitFor(() => {
      expect(mocks.remove).toHaveBeenCalledWith("audience-1");
      expect(document.body.textContent).toContain("Generate audience");
    });
  });
});
