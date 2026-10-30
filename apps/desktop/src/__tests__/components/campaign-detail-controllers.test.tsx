// @vitest-environment happy-dom

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

import type { CampaignDetail } from "../../lib/api-client";
import {
  type CampaignLifecycleController,
  useCampaignLifecycleController,
} from "../../components/campaigns/useCampaignLifecycleController";
import {
  type CampaignScheduleController,
  useCampaignScheduleController,
} from "../../components/campaigns/useCampaignScheduleController";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

const mocks = vi.hoisted(() => ({
  getChecklist: vi.fn(),
  send: vi.fn(),
  create: vi.fn(),
  saveTemplate: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  patchPsto: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  celebrate: vi.fn(),
  track: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getCampaignChecklist: mocks.getChecklist,
    sendCampaign: mocks.send,
    createCampaign: mocks.create,
    saveCampaignAsTemplate: mocks.saveTemplate,
    deleteCampaign: mocks.remove,
    updateCampaign: mocks.update,
    patchCampaignPSTO: mocks.patchPsto,
  },
}));

vi.mock("../../lib/sms-a2p-api", () => ({
  pauseCampaign: mocks.pause,
  resumeCampaign: mocks.resume,
  cancelCampaign: mocks.cancel,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/Celebrate", () => ({
  celebrate: mocks.celebrate,
}));

vi.mock("../../lib/telemetry", () => ({
  track: mocks.track,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let lifecycle: CampaignLifecycleController;
let schedule: CampaignScheduleController;
let currentDetail: CampaignDetail;
let currentBusy = false;
let setAuthority: (next: {
  canMutate: boolean;
  canAdmin: boolean;
  authoringLocked: boolean;
}) => void;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  localStorage.clear();
  mocks.getChecklist.mockResolvedValue({
    data: {
      campaign_id: "campaign-1",
      ready: true,
      checks: [
        {
          key: "subject_set",
          label: "Subject set",
          status: "pass",
          detail: "Subject is present",
        },
      ],
    },
  });
  mocks.send.mockResolvedValue({ data: { status: "queued" } });
  mocks.create.mockResolvedValue({ data: { id: "copy-1" } });
  mocks.saveTemplate.mockResolvedValue({ data: { name: "Launch template" } });
  mocks.remove.mockResolvedValue({ data: {} });
  mocks.update.mockResolvedValue({ data: detail({ status: "scheduled" }) });
  mocks.patchPsto.mockResolvedValue({
    data: detail({ per_recipient_optimize: true }),
  });
  mocks.pause.mockResolvedValue({ data: { status: "paused" } });
  mocks.resume.mockResolvedValue({ data: { status: "sending" } });
  mocks.cancel.mockResolvedValue({ data: { status: "cancelled" } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
  vi.useRealTimers();
});

describe("campaign detail lifecycle controller", () => {
  it("keeps approval-required sends non-sending and skips celebration", async () => {
    const onChange = vi.fn<(value: CampaignDetail | null) => void>();
    mocks.send.mockResolvedValue({
      data: { status: "approval_required", message: "Needs approval" },
    });
    renderHarness(detail(), onChange);
    await authorizeLifecycleSend();

    await act(async () => lifecycle.send());

    expect(currentDetail.status).toBe("draft");
    expect(onChange).toHaveBeenCalledWith(currentDetail);
    expect(mocks.toastInfo).toHaveBeenCalledWith("Needs approval");
    expect(mocks.celebrate).not.toHaveBeenCalled();
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("optimistically marks successful sends and celebrates once", async () => {
    const onChange = vi.fn<(value: CampaignDetail | null) => void>();
    renderHarness(detail(), onChange);
    await authorizeLifecycleSend();

    await act(async () => lifecycle.send());

    expect(currentDetail.status).toBe("sending");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "sending" }),
    );
    expect(mocks.celebrate).toHaveBeenCalledTimes(1);
    expect(mocks.track).toHaveBeenCalledWith("campaign_sent", {
      source: "slideover",
    });
  });

  it("never calls send when exact semantic poll preparation is unresolved", async () => {
    const beforeSend = vi
      .fn<() => Promise<void>>()
      .mockRejectedValue(new Error("poll revision unresolved"));
    renderHarness(detail(), vi.fn(), () => undefined, { beforeSend });
    await authorizeLifecycleSend();

    await act(async () => lifecycle.send());

    expect(beforeSend).toHaveBeenCalledOnce();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(currentDetail.status).toBe("draft");
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("poll revision unresolved"),
    );
  });

  it("preserves pause, resume, and terminal cancel transitions", async () => {
    const onChange = vi.fn<(value: CampaignDetail | null) => void>();
    renderHarness(detail({ status: "sending" }), onChange);

    await act(async () => lifecycle.runControl("pause"));
    await act(async () => lifecycle.runControl("resume"));
    await act(async () => lifecycle.runControl("cancel"));

    expect(mocks.pause).toHaveBeenCalledWith("campaign-1");
    expect(mocks.resume).toHaveBeenCalledWith("campaign-1");
    expect(mocks.cancel).toHaveBeenCalledWith("campaign-1");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("keeps duplicate, template, and delete payloads exact", async () => {
    const onChange = vi.fn<(value: CampaignDetail | null) => void>();
    const onClose = vi.fn();
    renderHarness(detail(), onChange, onClose);

    await act(async () => lifecycle.duplicate());
    act(() => lifecycle.openSaveAsTemplate());
    expect(lifecycle.tplSlug).toBe("launch");
    expect(lifecycle.tplName).toBe("Launch template");
    await act(async () => lifecycle.commitSaveAsTemplate());
    await act(async () => lifecycle.remove());

    expect(mocks.create).toHaveBeenCalledWith({
      name: "Launch (copy)",
      subject: "Ship it",
      from_email: "sender@example.com",
      body: "<p>Hello</p>",
    });
    expect(mocks.saveTemplate).toHaveBeenCalledWith("campaign-1", {
      slug: "launch",
      name: "Launch template",
    });
    expect(mocks.remove).toHaveBeenCalledWith("campaign-1");
    expect(onChange).toHaveBeenLastCalledWith(null);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("re-checks live write authority after destructive dialogs have opened", async () => {
    renderHarness(detail({ status: "sending" }), vi.fn());
    act(() => {
      lifecycle.setConfirmCancelOpen(true);
      lifecycle.setConfirmDeleteOpen(true);
      lifecycle.openSaveAsTemplate();
      setAuthority({
        canMutate: false,
        canAdmin: false,
        authoringLocked: false,
      });
    });

    expect(lifecycle.confirmCancelOpen).toBe(true);
    expect(lifecycle.confirmDeleteOpen).toBe(true);
    expect(lifecycle.tplModalOpen).toBe(true);
    await act(async () => {
      await lifecycle.runControl("cancel");
      await lifecycle.remove();
      await lifecycle.duplicate();
      await lifecycle.commitSaveAsTemplate();
      lifecycle.setConfirmSendOpen(true);
    });

    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.saveTemplate).not.toHaveBeenCalled();
    expect(lifecycle.confirmSendOpen).toBe(false);
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("current role"),
    );
  });

  it("blocks persisted campaign actions while the local editor is open", async () => {
    renderHarness(detail(), vi.fn());
    act(() => {
      setAuthority({
        canMutate: true,
        canAdmin: true,
        authoringLocked: true,
      });
    });
    act(() => {
      lifecycle.setConfirmSendOpen(true);
      lifecycle.setConfirmDeleteOpen(true);
      lifecycle.openSaveAsTemplate();
    });

    await act(async () => {
      await lifecycle.send();
      await lifecycle.duplicate();
      await lifecycle.remove();
      await lifecycle.commitSaveAsTemplate();
    });

    expect(lifecycle.confirmSendOpen).toBe(false);
    expect(lifecycle.confirmDeleteOpen).toBe(false);
    expect(lifecycle.tplModalOpen).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.saveTemplate).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("open campaign editor"),
    );
  });

  it("keeps an open template draft but revokes save when admin authority changes", async () => {
    renderHarness(detail(), vi.fn());
    act(() => {
      lifecycle.openSaveAsTemplate();
      setAuthority({
        canMutate: true,
        canAdmin: false,
        authoringLocked: false,
      });
    });

    const nameBeforeDowngrade = lifecycle.tplName;
    act(() => lifecycle.setTplName("should not replace local input"));
    await act(async () => lifecycle.commitSaveAsTemplate());

    expect(lifecycle.tplModalOpen).toBe(true);
    expect(lifecycle.tplName).toBe(nameBeforeDowngrade);
    expect(mocks.saveTemplate).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("admin-only"),
    );
  });
});

async function authorizeLifecycleSend(): Promise<void> {
  await act(async () => {
    lifecycle.setConfirmSendOpen(true);
    await Promise.resolve();
  });
  act(() => {
    lifecycle.setAudiencePreviewEvidence({
      status: "ready",
      campaignId: "campaign-1",
      requestId: 1,
      preview: {
        campaign_id: "campaign-1",
        audience_kind: "segment",
        recipients: 10,
        suppressed_excluded: 1,
        deliverable: 9,
        tier_cap_today: 100,
        tier_cap_remaining: 100,
        tier_cap_remaining_after: 91,
        over_cap: false,
        counted_at: "2026-07-20T10:00:00Z",
      },
    });
  });
}

describe("campaign detail schedule controller", () => {
  it("fails closed when programmatic callers try to open or submit scheduling", async () => {
    renderHarness(detail(), vi.fn());
    act(() => {
      schedule.setScheduleAt("2026-07-20T09:00:00Z");
      schedule.setScheduleOpen(true);
    });

    expect(schedule.scheduleOpen).toBe(false);
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
    await act(async () => schedule.schedule());
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Scheduling is temporarily unavailable"),
    );
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("also blocks personalized-window mutations beneath the disabled UI", async () => {
    renderHarness(detail(), vi.fn());
    act(() => {
      schedule.setPstoOn(true);
      schedule.setPstoWindowStart("2026-07-20T09:00:00Z");
      schedule.setPstoWindowEnd("2026-07-20T17:00:00Z");
    });

    await act(async () => schedule.schedule());

    expect(mocks.patchPsto).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(schedule.pstoSaving).toBe(false);
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining("Scheduling is temporarily unavailable"),
    );
  });
});

function renderHarness(
  initialDetail: CampaignDetail,
  onChange: (value: CampaignDetail | null) => void,
  onClose: () => void = () => undefined,
  preflight: {
    beforeSend?: () => Promise<void>;
    beforeSchedule?: () => Promise<void>;
  } = {},
): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const node: ReactElement = (
    <ControllerHarness
      initialDetail={initialDetail}
      onChange={onChange}
      onClose={onClose}
      beforeSend={preflight.beforeSend}
      beforeSchedule={preflight.beforeSchedule}
    />
  );
  act(() => root?.render(node));
}

function ControllerHarness({
  initialDetail,
  onChange,
  onClose,
  beforeSend,
  beforeSchedule,
}: {
  initialDetail: CampaignDetail;
  onChange: (value: CampaignDetail | null) => void;
  onClose: () => void;
  beforeSend: (() => Promise<void>) | undefined;
  beforeSchedule: (() => Promise<void>) | undefined;
}): null {
  const [state, setState] = useState(initialDetail);
  const [busy, setBusy] = useState(false);
  const [authority, setAuthorityState] = useState({
    canMutate: true,
    canAdmin: true,
    authoringLocked: false,
  });
  setAuthority = setAuthorityState;
  currentDetail = state;
  currentBusy = busy;
  lifecycle = useCampaignLifecycleController({
    id: state.id,
    detail: state,
    setDetail: setState,
    savedFromEmail: "sender@example.com",
    isDraft: state.status === "draft",
    canMutate: authority.canMutate,
    canAdmin: authority.canAdmin,
    authoringLocked: authority.authoringLocked,
    setBusy,
    onChange,
    onClose,
    beforeSend,
  });
  schedule = useCampaignScheduleController({
    id: state.id,
    detail: state,
    setDetail: setState,
    setBusy,
    onChange,
    beforeSchedule,
  });
  void currentBusy;
  return null;
}

function detail(overrides: Partial<CampaignDetail> = {}): CampaignDetail {
  return {
    id: "campaign-1",
    name: "Launch",
    subject: "Ship it",
    status: "draft",
    body_html: "<p>Hello</p>",
    ...overrides,
  } as CampaignDetail;
}
