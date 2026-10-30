// @vitest-environment happy-dom

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import axe from "axe-core";
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
  canAdmin: false,
  listSmsLists: vi.fn(),
  listLists: vi.fn(),
  listSegments: vi.fn(),
  listBroadcasts: vi.fn(),
  broadcastProgress: vi.fn(),
  sendBroadcast: vi.fn(),
  cancelBroadcast: vi.fn(),
  removeBroadcast: vi.fn(),
  listRoutines: vi.fn(),
  runRoutine: vi.fn(),
  updateRoutine: vi.fn(),
  removeRoutine: vi.fn(),
  listRoutineRuns: vi.fn(),
}));

vi.mock("../../lib/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/store")>()),
  useCanAdmin: () => mocks.canAdmin,
  useCanWrite: () => mocks.canAdmin,
}));

vi.mock("../../hooks/usePoller", () => ({
  usePoller: () => undefined,
}));

vi.mock("../../components/sms/broadcasts/BroadcastComposerModal", () => ({
  BroadcastComposerModal: () => null,
}));

vi.mock("../../components/segments/segmentsClient", () => ({
  segmentsClient: { list: mocks.listSegments },
}));

vi.mock("../../lib/sms-a2p-api", () => ({
  listSmsLists: mocks.listSmsLists,
}));

vi.mock("../../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api-client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      listLists: mocks.listLists,
    },
    smsBroadcastsApi: {
      ...actual.smsBroadcastsApi,
      list: mocks.listBroadcasts,
      progress: mocks.broadcastProgress,
      send: mocks.sendBroadcast,
      cancel: mocks.cancelBroadcast,
      remove: mocks.removeBroadcast,
    },
    agentRoutinesApi: {
      ...actual.agentRoutinesApi,
      list: mocks.listRoutines,
      run: mocks.runRoutine,
      update: mocks.updateRoutine,
      remove: mocks.removeRoutine,
      listRuns: mocks.listRoutineRuns,
    },
  };
});

import { RoutinesPanel } from "../../components/ai/RoutinesPanel";
import { BroadcastsPanel } from "../../components/sms/broadcasts/BroadcastsPanel";
import type { Campaign, SmsBroadcast } from "../../lib/api-client";
import { CampaignListView } from "../../pages/campaigns/CampaignListView";
import type { CampaignsController } from "../../pages/campaigns/useCampaignsController";

const DESKTOP_DIR = process.cwd();
const SCOPED_FILES = [
  "components/sms/broadcasts/BroadcastsPanel.tsx",
  "components/TemplateDetailSlideover.tsx",
  "pages/campaigns/CampaignListView.tsx",
  "components/ai/RoutinesPanel.tsx",
  "components/gifts/GiftHistoryWorkspace.tsx",
  "pages/Assets.tsx",
] as const;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canAdmin = false;
  Object.entries(mocks).forEach(([key, value]) => {
    if (key !== "canAdmin" && typeof value === "function") value.mockReset();
  });
  mocks.listLists.mockResolvedValue({ data: { results: [] } });
  mocks.listSmsLists.mockResolvedValue({ data: { items: [] } });
  mocks.listSegments.mockResolvedValue({ data: [] });
  mocks.listBroadcasts.mockResolvedValue({
    data: {
      tenantId: "10000000-0000-4000-8000-000000000001",
      items: [broadcast()],
      snapshotAt: "2026-08-21T12:00:00Z",
      broadcastDispatchAvailable: true,
    },
  });
  mocks.broadcastProgress.mockResolvedValue({
    data: { status: "draft", sent: 0, failed: 0, held: 0, total: 0 },
  });
  mocks.sendBroadcast.mockResolvedValue({
    data: {
      broadcast: broadcast(),
      progress: { status: "sending", sent: 0, failed: 0, held: 0, total: 1 },
      enqueued: 1,
    },
  });
  mocks.cancelBroadcast.mockResolvedValue({ data: broadcast() });
  mocks.removeBroadcast.mockResolvedValue({ data: { ok: true } });
  mocks.listRoutines.mockResolvedValue({ data: { items: [routine()] } });
  mocks.runRoutine.mockResolvedValue({
    data: { run_id: "run-1", status: "running" },
  });
  mocks.updateRoutine.mockResolvedValue({ data: routine() });
  mocks.removeRoutine.mockResolvedValue({ data: { ok: true } });
  mocks.listRoutineRuns.mockResolvedValue({ data: { items: [] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function render(element: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
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
  if (!match) throw new Error(`Missing button ${label}`);
  return match;
}

function seriousViolations(result: axe.AxeResults): axe.Result[] {
  return result.violations.filter((violation) =>
    ["serious", "critical"].includes(violation.impact ?? ""),
  );
}

describe("interactive title remediation wave 2", () => {
  it("keeps the six scoped source owners at zero and preserves semantic replacements", () => {
    const output = execFileSync(
      process.execPath,
      ["scripts/interactive-title-inventory.mjs", "--json"],
      { cwd: DESKTOP_DIR, encoding: "utf8" },
    );
    const inventory = JSON.parse(output) as {
      findings: Array<{ file: string }>;
    };
    expect(
      inventory.findings.filter((finding) =>
        SCOPED_FILES.includes(finding.file as (typeof SCOPED_FILES)[number]),
      ),
    ).toEqual([]);

    const expectedContracts: Record<(typeof SCOPED_FILES)[number], string[]> = {
      "components/sms/broadcasts/BroadcastsPanel.tsx": [
        "sms-broadcast-admin-reason",
        "aria-disabled",
        "useSingleFlightOperation",
      ],
      "components/TemplateDetailSlideover.tsx": [
        "template-action-guidance",
        "aria-disabled",
        "useSingleFlightOperation",
      ],
      "pages/campaigns/CampaignListView.tsx": [
        "campaign-list-admin-guidance",
        "aria-disabled",
        "aria-label",
      ],
      "components/ai/RoutinesPanel.tsx": [
        "routine-action-guidance",
        "aria-expanded",
        "useSingleFlightOperation",
      ],
      "components/gifts/GiftHistoryWorkspace.tsx": [
        "gift-history",
        "Lifecycle archive",
        "Refresh evidence",
        "aria-label",
      ],
      "pages/Assets.tsx": [
        "Retry filters",
        "newFolderRequestRef",
        "loadRequestRef",
      ],
    };
    for (const [file, tokens] of Object.entries(expectedContracts)) {
      const source = readFileSync(`${DESKTOP_DIR}/src/${file}`, "utf8");
      tokens.forEach((token) => expect(source).toContain(token));
    }
  });

  it("makes non-writer Move natively unavailable while preserving guidance", async () => {
    const { controller, cloneCampaign, openResend, setMoveTarget } =
      campaignController();
    render(<CampaignListView controller={controller} />);

    const clone = button("Clone");
    const resend = button("Resend");
    const move = button("Move");
    for (const control of [clone, resend]) {
      expect(control.disabled).toBe(true);
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.getAttribute("aria-describedby")).toMatch(
        /campaign-list-admin-guidance/,
      );
    }
    expect(move.disabled).toBe(true);
    expect(move.getAttribute("aria-disabled")).toBe("true");
    expect(move.getAttribute("aria-describedby")).toBe(
      "campaign-list-write-guidance",
    );
    act(() => {
      clone.click();
      resend.click();
      move.click();
    });
    expect(cloneCampaign).not.toHaveBeenCalled();
    expect(openResend).not.toHaveBeenCalled();
    expect(setMoveTarget).not.toHaveBeenCalled();
    expect(
      document.querySelector('[aria-label^="Name, sorted ascending"]'),
    ).not.toBeNull();
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(seriousViolations(await axe.run(container!))).toEqual([]);
  });

  it("gates broadcast rows before protected reads for a non-admin role", async () => {
    render(<BroadcastsPanel />);
    await settle();

    expect(document.body.textContent).toContain(
      "no protected broadcast requests were started",
    );
    expect(mocks.listBroadcasts).not.toHaveBeenCalled();
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("resolves broadcast segment audiences from canonical segment ids", async () => {
    mocks.canAdmin = true;
    mocks.listSegments.mockResolvedValue({
      data: [
        {
          id: "canonical-segment-001",
          name: "Recently engaged subscribers",
        },
      ],
    });
    mocks.listBroadcasts.mockResolvedValue({
      data: {
        tenantId: "10000000-0000-4000-8000-000000000001",
        items: [
          broadcast({
            segment_id: "canonical-segment-001",
            tag: "",
          }),
        ],
        snapshotAt: "2026-08-21T12:00:00Z",
        broadcastDispatchAvailable: true,
      },
    });

    render(<BroadcastsPanel />);
    await settle();

    expect(mocks.listSegments).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain(
      "Segment: Recently engaged subscribers",
    );
    expect(document.body.textContent).not.toContain("canonical…");
  });

  it("holds broadcast dispatch before POST and labels sent counters as provider accepted", async () => {
    mocks.canAdmin = true;
    mocks.listBroadcasts.mockResolvedValue({
      data: {
        tenantId: "10000000-0000-4000-8000-000000000001",
        items: [broadcast({ sent_count: 7 })],
        snapshotAt: "2026-08-21T12:00:00Z",
        broadcastDispatchAvailable: false,
        broadcastDispatchUnavailableReason:
          "sms_broadcast_dispatch_release_held",
      },
    });

    render(<BroadcastsPanel />);
    await settle();

    expect(document.body.textContent).toContain(
      "durable provider reconciliation and budget settlement are unavailable",
    );
    expect(document.body.textContent).toContain("7 accepted");
    expect(document.body.textContent).not.toMatch(/7 delivered/iu);
    const send = button("Send now");
    expect(send.disabled).toBe(true);
    act(() => send.click());
    expect(mocks.sendBroadcast).not.toHaveBeenCalled();
  });

  it("keeps viewer routine mutations focusable, described, and inert", async () => {
    render(<RoutinesPanel />);
    await settle();

    const runNow = button("Run now");
    expect(runNow.disabled).toBe(false);
    expect(runNow.getAttribute("aria-disabled")).toBe("true");
    const descriptionIds =
      runNow.getAttribute("aria-describedby")?.split(/\s+/u) ?? [];
    expect(descriptionIds).toContain("routine-action-guidance");
    expect(descriptionIds.length).toBeGreaterThanOrEqual(2);
    for (const id of descriptionIds) {
      expect(document.getElementById(id)?.textContent?.trim()).toBeTruthy();
    }
    act(() => {
      runNow.focus();
      runNow.click();
    });
    expect(document.activeElement).toBe(runNow);
    expect(mocks.runRoutine).not.toHaveBeenCalled();
    expect(document.querySelectorAll("button[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);
  });

  it("owns a routine run from the first same-tick click through thrown settlement", async () => {
    mocks.canAdmin = true;
    let rejectRun!: (error: Error) => void;
    mocks.runRoutine.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectRun = reject;
      }),
    );
    render(<RoutinesPanel />);
    await settle();

    const runNow = button("Run now");
    expect(runNow.getAttribute("aria-describedby")).toBe(
      "routine-action-guidance",
    );
    act(() => {
      runNow.click();
      runNow.click();
    });
    expect(mocks.runRoutine).toHaveBeenCalledTimes(1);
    expect(button("Starting…").disabled).toBe(true);
    expect(document.querySelectorAll("[title]")).toHaveLength(0);
    expect(
      seriousViolations(
        await axe.run(container!, { rules: { region: { enabled: false } } }),
      ),
    ).toEqual([]);

    await act(async () => {
      rejectRun(new Error("agent gateway offline"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(button("Run now").disabled).toBe(false);
  });
});

function broadcast(overrides: Partial<SmsBroadcast> = {}): SmsBroadcast {
  return {
    id: "broadcast-1",
    tenant_id: "10000000-0000-4000-8000-000000000001",
    name: "July update",
    body: "Hello from Moosewave",
    list_ids: [],
    tag: "vip",
    status: "draft",
    sent_count: 0,
    failed_count: 0,
    held_count: 0,
    segments_per_message: 1,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
    ...overrides,
  };
}

function routine() {
  return {
    id: "routine-1",
    name: "Weekly digest",
    prompt: "Draft this week's digest",
    kind: "draft_campaign" as const,
    schedule: "weekly" as const,
    require_approval: true,
    enabled: true,
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-01T10:00:00Z",
  };
}

function campaignController(): {
  controller: CampaignsController;
  cloneCampaign: ReturnType<typeof vi.fn>;
  openResend: ReturnType<typeof vi.fn>;
  setMoveTarget: ReturnType<typeof vi.fn>;
} {
  const row = {
    id: "campaign-1",
    name: "July launch",
    subject: "July launch",
    status: "sent",
    sent_at: "2026-07-01T10:00:00Z",
    open_rate: 0.42,
    click_rate: 0.08,
  } as Campaign;
  const cloneCampaign = vi.fn();
  const openResend = vi.fn();
  const setMoveTarget = vi.fn();
  const controller = {
    canAdminMutate: false,
    canMutate: false,
    canAdminMutateCampaignSnapshot: false,
    canMutateCampaignSnapshot: false,
    campaignAdminMutationUnavailableReason:
      "Ask a workspace admin to clone or resend campaigns.",
    campaignMutationUnavailableReason:
      "Ask a workspace editor or admin for edit access.",
    state: {
      viewMode: "list",
      loading: false,
      rows: [row],
      query: "",
      selected: null,
      selectedIds: new Set<string>(),
      sortBy: "name",
      sortDir: "asc",
      cloningId: null,
      page: 1,
      setPage: vi.fn(),
      setAbModalCampaign: vi.fn(),
      setAbMetric: vi.fn(),
      setMoveTarget,
      setMovePick: vi.fn(),
      setSelected: vi.fn(),
    },
    view: {
      allPageSelected: false,
      pageRows: [row],
      totalPages: 1,
    },
    creation: {
      pendingCampaignCreates: [],
      failedCampaignCreates: [],
      openCreate: vi.fn(),
    },
    bulkActions: {
      toggleSelectAll: vi.fn(),
      toggleSort: vi.fn(),
      toggleSelect: vi.fn(),
    },
    rowActions: {
      cloneCampaign,
      openResend,
    },
  } as unknown as CampaignsController;
  return { controller, cloneCampaign, openResend, setMoveTarget };
}
