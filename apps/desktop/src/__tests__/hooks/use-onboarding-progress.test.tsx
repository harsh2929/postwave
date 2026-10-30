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

import type { OnboardingProgress } from "../../hooks/useOnboardingProgress";

const mocks = vi.hoisted(() => ({
  getOnboardingProgress: vi.fn(),
  // The fallback path's resources, hoisted so a test can drive them. They were
  // previously anonymous `vi.fn()`s inside the module factory, which is why
  // nothing noticed when the DMARC branch of `deriveViaFallback` disappeared.
  listCustomDomains: vi.fn(),
  listSubscribers: vi.fn(),
  listCampaigns: vi.fn(),
  getProductEventStats: vi.fn(),
  listDmarcReports: vi.fn(),
  syncGoals: vi.fn(),
  scopeCounter: 0,
  onboarding: {
    ready: true,
    role: "admin",
    state: {
      scopeToken: "progress-test-0",
      goals: {
        completedStepIds: [] as string[],
        fetchedAt: null as number | null,
      },
      surfaces: {
        checklist: {
          outcome: "idle",
          skippedStepIds: [] as string[],
        },
      },
    },
    syncGoals: vi.fn(),
    dismissSurface: vi.fn(),
    resetSurface: vi.fn(),
    skipStep: vi.fn(),
    skipSurface: vi.fn(),
  },
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getOnboardingProgress: mocks.getOnboardingProgress,
    listCustomDomains: mocks.listCustomDomains,
    listSubscribers: mocks.listSubscribers,
    listCampaigns: mocks.listCampaigns,
    getProductEventStats: mocks.getProductEventStats,
    listDmarcReports: mocks.listDmarcReports,
  },
}));

vi.mock("../../hooks/useOnboardingState", () => ({
  useOnboardingState: () => mocks.onboarding,
}));

vi.mock("../../lib/desktop-router", () => ({
  navigateDesktopRoute: vi.fn(),
}));

import { useOnboardingProgress } from "../../hooks/useOnboardingProgress";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: OnboardingProgress | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scopeCounter += 1;
  mocks.onboarding.ready = true;
  mocks.onboarding.role = "admin";
  mocks.onboarding.state.scopeToken = `progress-test-${mocks.scopeCounter}`;
  mocks.onboarding.state.goals.completedStepIds = [];
  mocks.onboarding.state.goals.fetchedAt = null;
  mocks.onboarding.state.surfaces.checklist.outcome = "idle";
  mocks.onboarding.state.surfaces.checklist.skippedStepIds = [];
  mocks.onboarding.syncGoals = mocks.syncGoals;
  latest = null;
});

afterEach(() => {
  if (root) {
    const mounted = root;
    act(() => mounted.unmount());
  }
  root = null;
  container?.remove();
  container = null;
  latest = null;
  document.body.replaceChildren();
});

function Harness(): ReactElement {
  latest = useOnboardingProgress();
  return <div />;
}

function renderHook(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Harness />));
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useOnboardingProgress request states", () => {
  it("exposes an initial failure and retries into a live-confirmed state", async () => {
    mocks.getOnboardingProgress
      .mockRejectedValueOnce(new Error("upstream secret should stay private"))
      .mockResolvedValueOnce({
        data: {
          steps: [
            { key: "verified_sending_identity", completed: true },
            { key: "created_subscriber", completed: false },
          ],
        },
      });

    renderHook();
    await settle();

    expect(latest).toMatchObject({
      loading: false,
      refreshing: false,
      available: false,
      failed: true,
      stale: false,
      liveConfirmed: false,
    });

    act(() => latest?.retry());
    expect(latest?.loading).toBe(true);
    await settle();

    expect(mocks.getOnboardingProgress).toHaveBeenCalledTimes(2);
    expect(mocks.syncGoals).toHaveBeenCalledWith(
      ["verify-domain"],
      expect.any(Number),
      false,
    );
    expect(latest).toMatchObject({
      loading: false,
      refreshing: false,
      available: true,
      failed: false,
      stale: false,
      liveConfirmed: true,
    });
  });

  it("retains a validated cache and marks it stale after refresh failure", async () => {
    mocks.onboarding.state.goals.completedStepIds = ["verify-domain"];
    mocks.onboarding.state.goals.fetchedAt = Date.now() - 31 * 60_000;
    mocks.getOnboardingProgress.mockRejectedValueOnce(
      new Error("transport details must not reach the UI"),
    );

    renderHook();
    expect(latest).toMatchObject({
      loading: false,
      refreshing: true,
      available: true,
    });
    await settle();

    expect(latest).toMatchObject({
      loading: false,
      refreshing: false,
      available: true,
      failed: true,
      stale: true,
      liveConfirmed: false,
      completedStepIds: ["verify-domain"],
    });
    expect(mocks.syncGoals).not.toHaveBeenCalled();
  });
});

describe("the fallback derivation covers every checklist step", () => {
  // When `getOnboardingProgress` answers without a `steps` array, the hook
  // derives done-ness from individual resources. `harden-deliverability` was
  // silently dropped from that path: its old branch probed `.data`/`.results`
  // keys the DMARC handler has never sent, and when `DmarcReportsResponse`
  // was tightened to the real `{items, meta}` envelope those branches became
  // type errors and the whole derivation was deleted rather than corrected.
  // The result was a step that could never read as complete in fallback — the
  // app asking a tenant to redo work it had already done.
  function fallbackApi(): void {
    mocks.getOnboardingProgress.mockResolvedValue({ data: {} });
    mocks.listCustomDomains.mockResolvedValue({ data: [] });
    mocks.listSubscribers.mockResolvedValue({ data: { total: 0, items: [] } });
    mocks.listCampaigns.mockResolvedValue({ data: { items: [] } });
    mocks.getProductEventStats.mockResolvedValue({ data: { totalEvents: 0 } });
  }

  it("marks harden-deliverability complete when DMARC reports exist", async () => {
    fallbackApi();
    // The shape the Go handler actually returns — apps/api/internal/dmarc
    // handlers.go writes `Items []Report \`json:"items"\`` + `meta`.
    mocks.listDmarcReports.mockResolvedValue({
      data: { items: [{ id: "r1" }], meta: {} },
    });

    renderHook();
    await settle();

    expect(mocks.syncGoals).toHaveBeenCalledWith(
      ["harden-deliverability"],
      expect.any(Number),
      false,
    );
  });

  it("leaves it incomplete when no reports have arrived", async () => {
    fallbackApi();
    mocks.listDmarcReports.mockResolvedValue({
      data: { items: [], meta: {} },
    });

    renderHook();
    await settle();

    expect(mocks.syncGoals).toHaveBeenCalledWith(
      [],
      expect.any(Number),
      false,
    );
  });
});
