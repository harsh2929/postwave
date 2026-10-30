// @vitest-environment happy-dom

import { act } from "react";
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
import type { ReferralProgramState } from "../../pages/referrals/useReferralProgramController";

const mocks = vi.hoisted(() => ({
  controllerCanMutate: [] as boolean[],
  editorRender: vi.fn(),
  leaderboardRender: vi.fn(),
  load: vi.fn(),
  overviewRender: vi.fn(),
  payoutRender: vi.fn(),
  removeMilestone: vi.fn(),
  role: "viewer" as "admin" | "editor" | "viewer",
  state: null as ReferralProgramState | null,
  statsRender: vi.fn(),
}));

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  useCanAdmin: () => mocks.role === "admin",
}));

vi.mock("../../pages/referrals/useReferralProgramController", () => ({
  useReferralProgramController: (canMutate: boolean) => {
    mocks.controllerCanMutate.push(canMutate);
    if (!mocks.state) throw new Error("Missing test referral state");
    return {
      deleting: false,
      load: mocks.load,
      milestones: mocks.state.program?.milestones ?? [],
      removeMilestone: mocks.removeMilestone,
      state: mocks.state,
    };
  },
}));

vi.mock("../../components/referrals/ReferralStatsCards", () => ({
  ReferralStatsCards: () => {
    mocks.statsRender();
    return <div data-testid="stats-read">Historical stats</div>;
  },
}));

vi.mock("../../components/referrals/LeaderboardCard", () => ({
  LeaderboardCard: () => {
    mocks.leaderboardRender();
    return <div data-testid="leaderboard-read">Masked leaders</div>;
  },
}));

vi.mock("../../pages/referrals/ReferralProgramOverview", () => ({
  ReferralProgramOverview: ({ canMutate }: { canMutate: boolean }) => {
    mocks.overviewRender(canMutate);
    return (
      <div data-testid="program-read">
        Program mutation: {String(canMutate)}
      </div>
    );
  },
}));

vi.mock("../../components/referrals/PayoutChecklist", () => ({
  PayoutChecklist: () => {
    mocks.payoutRender();
    return <div data-testid="unsafe-payout">Unsafe payout queue</div>;
  },
}));

vi.mock("../../pages/referrals/ProgramEditor", () => ({
  ProgramEditor: ({
    canMutate,
    open,
  }: {
    canMutate: boolean;
    open: boolean;
  }) => {
    mocks.editorRender({ canMutate, open });
    return (
      <div
        data-testid="program-editor"
        data-can-mutate={String(canMutate)}
        data-open={String(open)}
      />
    );
  },
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Delete milestone</div> : null,
}));

import { Referrals } from "../../pages/Referrals";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

const program: ReferralProgram = {
  id: "program-route-1",
  active: true,
  milestones: [{ count: 5, reward_label: "Field guide" }],
  updatedAt: "2026-07-25T10:00:00.000Z",
};

function activeState(
  overrides: Partial<ReferralProgramState> = {},
): ReferralProgramState {
  return {
    empty: false,
    error: null,
    loading: false,
    program,
    ...overrides,
  };
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.role = "viewer";
  mocks.state = activeState();
  mocks.controllerCanMutate.length = 0;
  for (const value of Object.values(mocks)) {
    if (typeof value === "function") value.mockReset();
  }
  mocks.load.mockResolvedValue(undefined);
  mocks.removeMilestone.mockResolvedValue(false);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.clearAllMocks();
});

function renderRoute(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Referrals />);
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent?.replace(/\s+/g, " ").trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

describe("Referrals route release boundaries", () => {
  it.each(["editor", "viewer"] as const)(
    "contains every activation path for a %s",
    (role) => {
      mocks.role = role;
      renderRoute();

      expect(document.body.textContent).toContain("Read-only access");
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (candidate) => candidate.textContent?.trim() === "Edit program",
        ),
      ).toBe(false);
      expect(
        document.querySelector(
          "table[aria-label='Stored referral program milestones']",
        ),
      ).not.toBeNull();
      expect(mocks.overviewRender).not.toHaveBeenCalled();
      expect(
        document
          .querySelector("[data-testid='program-editor']")
          ?.getAttribute("data-can-mutate"),
      ).toBe("false");
      expect(mocks.controllerCanMutate.every((value) => value === false)).toBe(
        true,
      );
      expect(mocks.payoutRender).not.toHaveBeenCalled();
      expect(
        document.querySelector("[data-testid='unsafe-payout']"),
      ).toBeNull();
    },
  );

  it("keeps admin program, payout, and widget mutations fail-closed", () => {
    mocks.role = "admin";
    renderRoute();

    const edit = button("Edit program");
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    act(() => edit.click());
    expect(
      document
        .querySelector("[data-testid='program-editor']")
        ?.getAttribute("data-open"),
    ).toBe("false");
    expect(
      document
        .querySelector("[data-testid='program-editor']")
        ?.getAttribute("data-can-mutate"),
    ).toBe("false");
    expect(mocks.controllerCanMutate.every((value) => value === false)).toBe(
      true,
    );

    act(() => button("Install on website").click());
    expect(document.querySelector("[role='dialog']")).toBeNull();
    const tabs = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    );
    act(() => tabs[2]?.click());
    expect(document.body.textContent).toContain(
      "zero payout reads and zero payout mutation controls",
    );
    expect(mocks.payoutRender).not.toHaveBeenCalled();
    expect(mocks.removeMilestone).not.toHaveBeenCalled();
  });

  it("shows an inert create affordance for a verified empty admin state", () => {
    mocks.role = "admin";
    mocks.state = {
      empty: true,
      error: null,
      loading: false,
      program: null,
    };
    renderRoute();

    const create = button("Create program");
    expect(create.getAttribute("aria-disabled")).toBe("true");
    act(() => create.click());
    expect(
      document
        .querySelector("[data-testid='program-editor']")
        ?.getAttribute("data-open"),
    ).toBe("false");
    expect(document.body.textContent).toContain(
      "Program changes are review-gated.",
    );
  });

  it("keeps last-good inspection visible and refresh available after failure", async () => {
    mocks.role = "admin";
    mocks.state = activeState({ error: "Gateway timeout" });
    renderRoute();

    expect(document.body.textContent).toContain("Last verified");
    expect(document.body.textContent).toContain(
      "showing the last verified program",
    );
    expect(document.body.textContent).toContain("Gateway timeout");
    expect(
      Array.from(document.querySelectorAll("button")).some(
        (candidate) => candidate.textContent?.trim() === "Edit program",
      ),
    ).toBe(false);
    await act(async () => button("Refresh program").click());
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.payoutRender).not.toHaveBeenCalled();
  });
});
