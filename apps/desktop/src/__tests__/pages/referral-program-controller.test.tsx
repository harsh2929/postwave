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

import type { ReferralProgram } from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  getProgram: vi.fn(),
  setProgram: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getReferralProgram: mocks.getProgram,
    setReferralProgram: mocks.setProgram,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError, success: mocks.toastSuccess },
}));

import {
  type ReferralProgramController,
  useReferralProgramController,
} from "../../pages/referrals/useReferralProgramController";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReferralProgramController | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProgram.mockResolvedValue({ data: program() });
  mocks.setProgram.mockResolvedValue({ data: program() });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function program(overrides: Partial<ReferralProgram> = {}): ReferralProgram {
  return {
    id: "program-1",
    active: true,
    expiresAt: "2026-08-31T23:59:59.000Z",
    updatedAt: "2026-07-16T09:00:00.000Z",
    milestones: [
      {
        count: 3,
        reward_label: "Hoodie",
        reward_kind: "swag",
        reward_value_cents: 2500,
        reward_currency: "USD",
        reward_sku: "hoodie-blue",
      },
      { count: 10, reward_label: "One month", reward_kind: "free" },
    ],
    referee_reward_kind: "custom",
    referee_reward_label: "Welcome credit",
    referee_reward_image_asset_id: "asset-referee",
    reward_value_cents: 500,
    reward_currency: "USD",
    reward_sku: "credit-5",
    verification_window_days: 14,
    ...overrides,
  };
}

function Probe({ canMutate }: { canMutate: boolean }): ReactElement {
  latest = useReferralProgramController(canMutate);
  return (
    <div>
      <span data-testid="loading">{String(latest.state.loading)}</span>
      <span data-testid="empty">{String(latest.state.empty)}</span>
      <span data-testid="error">{latest.state.error ?? "none"}</span>
      <span data-testid="program">{latest.state.program?.id ?? "none"}</span>
      <span data-testid="deleting">{String(latest.deleting)}</span>
      <span data-testid="counts">
        {latest.milestones.map((milestone) => milestone.count).join(",")}
      </span>
    </div>
  );
}

function renderController(canMutate = true): {
  rerender: (nextCanMutate: boolean) => void;
} {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const render = (value: boolean): void => {
    act(() => root?.render(<Probe canMutate={value} />));
  };
  render(canMutate);
  return { rerender: render };
}

function text(testId: string): string | null {
  return (
    document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null
  );
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

async function renderLoaded(canMutate = true): Promise<void> {
  renderController(canMutate);
  await waitFor(() => expect(text("loading")).toBe("false"));
}

describe("referral program controller", () => {
  it("treats only an exact 404 as an empty program", async () => {
    mocks.getProgram.mockResolvedValue({
      error: { kind: "http", status: 404, message: "not found" },
    });
    renderController();
    await waitFor(() => expect(text("loading")).toBe("false"));

    expect(text("empty")).toBe("true");
    expect(text("error")).toBe("none");
    expect(text("program")).toBe("none");
  });

  it("keeps the newest overlapping load and rejects malformed success", async () => {
    const oldRequest = deferred<{ data: ReferralProgram }>();
    mocks.getProgram
      .mockReset()
      .mockReturnValueOnce(oldRequest.promise)
      .mockResolvedValueOnce({ data: program({ id: "new-program" }) });
    renderController();
    act(() => void latest?.load());
    await waitFor(() => expect(text("program")).toBe("new-program"));

    await act(async () => {
      oldRequest.resolve({ data: program({ id: "old-program" }) });
      await oldRequest.promise;
    });
    expect(text("program")).toBe("new-program");

    mocks.getProgram.mockResolvedValueOnce({
      data: { id: "malformed", active: true },
    });
    await act(async () => latest?.load());
    expect(text("program")).toBe("new-program");
    expect(text("error")).toBe("The referral program response was invalid.");
  });

  it("serializes deletion and sends an exact lossless full replacement", async () => {
    const pending = deferred<{ data: ReferralProgram }>();
    mocks.setProgram.mockReturnValue(pending.promise);
    mocks.getProgram
      .mockResolvedValueOnce({ data: program() })
      .mockResolvedValueOnce({
        data: program({
          milestones: [
            { count: 10, reward_label: "One month", reward_kind: "free" },
          ],
        }),
      });
    await renderLoaded();

    let first!: Promise<boolean>;
    act(() => {
      first = latest!.removeMilestone(3);
      void latest?.removeMilestone(3);
    });
    expect(mocks.setProgram).toHaveBeenCalledTimes(1);
    expect(text("deleting")).toBe("true");
    expect(mocks.setProgram).toHaveBeenCalledWith({
      milestones: [
        { count: 10, reward_label: "One month", reward_kind: "free" },
      ],
      expires_at: "2026-08-31T23:59:59.000Z",
      expected_program_id: "program-1",
      referee_reward_kind: "custom",
      referee_reward_label: "Welcome credit",
      referee_reward_image_asset_id: "asset-referee",
      reward_value_cents: 500,
      reward_currency: "USD",
      reward_sku: "credit-5",
      verification_window_days: 14,
    });

    await act(async () => {
      pending.resolve({ data: program() });
      await first;
    });
    expect(text("deleting")).toBe("false");
    expect(text("counts")).toBe("10");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Milestone removed");
  });

  it("fails closed for viewers", async () => {
    await renderLoaded(false);
    await act(async () => latest?.removeMilestone(3));
    expect(mocks.setProgram).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Only workspace admins can delete referral milestones",
    );
  });

  it("refuses to remove the last milestone", async () => {
    mocks.getProgram.mockResolvedValue({
      data: program({
        milestones: [{ count: 3, reward_label: "Hoodie", reward_kind: "swag" }],
      }),
    });
    renderController(true);
    await waitFor(() => expect(text("counts")).toBe("3"));
    await act(async () => latest?.removeMilestone(3));
    expect(mocks.setProgram).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenLastCalledWith(
      "A program needs at least one milestone — use Edit to redefine.",
    );
  });

  it("ignores a pending mutation after role downgrade", async () => {
    const pending = deferred<{ data: ReferralProgram }>();
    mocks.setProgram.mockReturnValue(pending.promise);
    const view = renderController(true);
    await waitFor(() => expect(text("program")).toBe("program-1"));
    act(() => void latest?.removeMilestone(3));
    view.rerender(false);

    await act(async () => {
      pending.resolve({ data: program() });
      await pending.promise;
    });
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.getProgram).toHaveBeenCalledTimes(1);
    expect(text("deleting")).toBe("false");
  });
});
