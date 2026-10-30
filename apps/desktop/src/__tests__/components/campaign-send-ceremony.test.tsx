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

import { CampaignSendConfirmationModal } from "../../components/CampaignDetailActionModals";
import {
  type CampaignLifecycleController,
  useCampaignLifecycleController,
} from "../../components/campaigns/useCampaignLifecycleController";
import type {
  CampaignChecklist,
  CampaignDetail,
  CampaignSendPreview,
} from "../../lib/api-client";

const mocks = vi.hoisted(() => ({
  getChecklist: vi.fn(),
  getPreview: vi.fn(),
  send: vi.fn(),
  create: vi.fn(),
  saveTemplate: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    getCampaignChecklist: mocks.getChecklist,
    getCampaignSendPreview: mocks.getPreview,
    sendCampaign: mocks.send,
    createCampaign: mocks.create,
    saveCampaignAsTemplate: mocks.saveTemplate,
    deleteCampaign: mocks.remove,
  },
}));

vi.mock("../../lib/sms-a2p-api", () => ({
  pauseCampaign: vi.fn(),
  resumeCampaign: vi.fn(),
  cancelCampaign: vi.fn(),
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../components/Celebrate", () => ({ celebrate: vi.fn() }));
vi.mock("../../lib/telemetry", () => ({ track: vi.fn() }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let lifecycle: CampaignLifecycleController;
let switchCampaign: (campaignId: string) => void;
let currentBusy = false;

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
  mocks.getChecklist.mockResolvedValue({ data: checklist("campaign-1") });
  mocks.getPreview.mockResolvedValue({ data: preview("campaign-1") });
  mocks.send.mockResolvedValue({ data: { status: "queued" } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

describe("campaign send ceremony", () => {
  it("fails closed on a checklist timeout, explains why, focuses retry, and recovers", async () => {
    mocks.getChecklist
      .mockResolvedValueOnce({
        error: {
          kind: "timeout",
          code: "request_timeout",
          message: "Request timed out. Check your connection and try again.",
        },
      })
      .mockResolvedValueOnce({ data: checklist("campaign-1") });
    renderHarness();

    await openAndSettle();

    const sendButton = button("Send now");
    const retryButton = button("Retry pre-send checklist");
    expect(lifecycle.checklistEvidence).toMatchObject({
      status: "error",
      campaignId: "campaign-1",
    });
    expect(sendButton.disabled).toBe(true);
    expect(sendButton.getAttribute("aria-disabled")).toBe("true");
    expect(describedText(sendButton)).toContain(
      "Retry the failed pre-send checklist",
    );
    expect(document.activeElement).toBe(retryButton);
    sendButton.click();
    expect(mocks.send).not.toHaveBeenCalled();

    await clickAndSettle(retryButton);

    expect(lifecycle.checklistEvidence).toMatchObject({ status: "ready" });
    expect(button("Send now").disabled).toBe(false);
  });

  it("keeps failed checklist items non-overrideable even after audience recovery", async () => {
    mocks.getChecklist.mockResolvedValue({
      data: checklist("campaign-1", false),
    });
    mocks.getPreview
      .mockResolvedValueOnce({
        error: {
          status: 500,
          code: "internal_error",
          message: "Audience service unavailable",
        },
      })
      .mockResolvedValueOnce({ data: preview("campaign-1") });
    renderHarness();

    await openAndSettle();

    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.body.textContent).toContain(
      "Failed checklist items cannot be overridden.",
    );

    const lockedSend = button("Send now");
    expect(lockedSend.disabled).toBe(true);
    expect(describedText(lockedSend)).toContain(
      "Resolve every failed pre-send check",
    );
    expect(document.body.textContent).toContain("Audience verification failed");
    lockedSend.click();
    expect(mocks.send).not.toHaveBeenCalled();

    const retry = button("Retry audience verification");
    expect(document.activeElement).toBe(retry);
    await clickAndSettle(retry);

    const stillLockedSend = button("Send now");
    expect(stillLockedSend.disabled).toBe(true);
    expect(describedText(stillLockedSend)).toContain(
      "Resolve every failed pre-send check",
    );
    stillLockedSend.click();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  });

  it("closes an open ceremony on campaign switch and requires a fresh ceremony for the new identity", async () => {
    const oldChecklist = deferred<{
      data: CampaignChecklist;
    }>();
    const oldPreview = deferred<{ data: CampaignSendPreview }>();
    mocks.getChecklist.mockImplementation((campaignId: string) =>
      campaignId === "campaign-1"
        ? oldChecklist.promise
        : Promise.resolve({ data: checklist("campaign-2") }),
    );
    mocks.getPreview.mockImplementation((campaignId: string) =>
      campaignId === "campaign-1"
        ? oldPreview.promise
        : Promise.resolve({
            data: preview("campaign-2", {
              recipients: 22,
              suppressed_excluded: 2,
              deliverable: 20,
              tier_cap_remaining_after: 80,
            }),
          }),
    );
    renderHarness();
    await openAndSettle();

    await act(async () => {
      switchCampaign("campaign-2");
      await settle();
    });
    expect(lifecycle.confirmSendOpen).toBe(false);
    expect(lifecycle.checklistEvidence).toMatchObject({
      status: "idle",
      campaignId: null,
    });
    expect(document.body.textContent).not.toContain("22 recipients");

    await act(async () => {
      oldChecklist.resolve({ data: checklist("campaign-1", false) });
      oldPreview.resolve({
        data: preview("campaign-1", {
          recipients: 999,
          suppressed_excluded: 0,
          deliverable: 999,
          tier_cap_today: -1,
          tier_cap_remaining: -1,
          tier_cap_remaining_after: -1,
        }),
      });
      await settle();
    });

    expect(lifecycle.confirmSendOpen).toBe(false);
    expect(lifecycle.checklistEvidence).toMatchObject({
      status: "idle",
      campaignId: null,
    });
    expect(document.body.textContent).not.toContain("999 recipients");

    await openAndSettle();
    expect(lifecycle.checklistEvidence).toMatchObject({
      status: "ready",
      campaignId: "campaign-2",
    });
    expect(lifecycle.audiencePreviewEvidence).toMatchObject({
      status: "ready",
      campaignId: "campaign-2",
    });
    expect(document.body.textContent).toContain("22 recipients");
    await clickAndSettle(button("Send now"));
    expect(mocks.send).toHaveBeenCalledWith("campaign-2");
  });

  it("rejects mismatched and unavailable evidence instead of treating it as ready", async () => {
    mocks.getChecklist.mockResolvedValueOnce({
      data: checklist("different-campaign"),
    });
    mocks.getPreview.mockResolvedValueOnce({
      data: preview("campaign-1", {
        suppressed_excluded: -1,
        deliverable: 10,
      }),
    });
    renderHarness();

    await openAndSettle();

    expect(lifecycle.checklistEvidence).toMatchObject({
      status: "error",
      message: "The checklist result belongs to a different campaign.",
    });
    expect(lifecycle.audiencePreviewEvidence).toMatchObject({
      status: "error",
      message: "Suppression exclusions could not be verified.",
    });
    expect(button("Send now").disabled).toBe(true);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("uses native disabled semantics while evidence is loading", async () => {
    const pendingChecklist = deferred<{ data: CampaignChecklist }>();
    const pendingPreview = deferred<{ data: CampaignSendPreview }>();
    mocks.getChecklist.mockReturnValue(pendingChecklist.promise);
    mocks.getPreview.mockReturnValue(pendingPreview.promise);
    renderHarness();

    await openAndSettle();

    const checkingButton = button("Checking…");
    expect(checkingButton.disabled).toBe(true);
    expect(checkingButton.getAttribute("aria-disabled")).toBe("true");
    expect(describedText(checkingButton)).toMatch(
      /Wait for the current|Wait for recipient/u,
    );
    checkingButton.focus();
    checkingButton.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    checkingButton.click();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("serializes same-tick activation and prevents every dismissal path while sending", async () => {
    const pendingSend = deferred<{ data: { status: string } }>();
    mocks.send.mockReturnValue(pendingSend.promise);
    renderHarness();
    await openAndSettle();

    const sendButton = button("Send now");
    const closeButton =
      document.querySelector<HTMLButtonElement>(".modal-close");
    const cancelButton = button("Cancel");
    act(() => {
      sendButton.click();
      sendButton.click();
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      document
        .querySelector<HTMLElement>(".modal-backdrop")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      closeButton?.click();
      cancelButton.click();
    });
    expect(mocks.send).toHaveBeenCalledOnce();
    expect(currentBusy).toBe(true);
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    expect(closeButton?.disabled).toBe(true);
    expect(cancelButton.disabled).toBe(true);
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      document
        .querySelector<HTMLElement>(".modal-backdrop")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      closeButton?.click();
      cancelButton.click();
    });
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();

    await act(async () => {
      pendingSend.resolve({ data: { status: "queued" } });
      await settle();
    });
    expect(currentBusy).toBe(false);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});

function renderHarness(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<SendHarness />));
}

function SendHarness(): ReactElement {
  const [detailState, setDetailState] = useState<CampaignDetail>(
    detail("campaign-1"),
  );
  const [busy, setBusy] = useState(false);
  currentBusy = busy;
  switchCampaign = (campaignId) => {
    setDetailState(detail(campaignId));
  };
  lifecycle = useCampaignLifecycleController({
    id: detailState.id,
    detail: detailState,
    setDetail: setDetailState,
    savedFromEmail: "sender@example.com",
    isDraft: detailState.status === "draft",
    canMutate: true,
    canAdmin: true,
    authoringLocked: false,
    setBusy,
    onChange: () => undefined,
    onClose: () => undefined,
  });

  return (
    <>
      <button type="button" onClick={() => lifecycle.setConfirmSendOpen(true)}>
        Open send confirmation
      </button>
      <CampaignSendConfirmationModal
        confirmSendOpen={lifecycle.confirmSendOpen}
        setConfirmSendOpen={lifecycle.setConfirmSendOpen}
        detail={detailState}
        id={detailState.id}
        checklistEvidence={lifecycle.checklistEvidence}
        retryChecklist={lifecycle.retryChecklist}
        audiencePreviewEvidence={lifecycle.audiencePreviewEvidence}
        setAudiencePreviewEvidence={lifecycle.setAudiencePreviewEvidence}
        checklistFailureOverride={lifecycle.checklistFailureOverride}
        setChecklistFailureOverride={lifecycle.setChecklistFailureOverride}
        busy={busy}
        canMutate
        authoringLocked={false}
        detailErr={null}
        send={lifecycle.send}
      />
    </>
  );
}

async function openAndSettle(): Promise<void> {
  await clickAndSettle(button("Open send confirmation"));
}

async function clickAndSettle(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await settle();
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function button(name: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === name);
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}

function describedText(element: HTMLElement): string {
  const descriptionId = element.getAttribute("aria-describedby");
  return descriptionId
    ? (document.getElementById(descriptionId)?.textContent ?? "")
    : "";
}

function checklist(campaignId: string, ready = true): CampaignChecklist {
  return {
    campaign_id: campaignId,
    ready,
    checks: [
      {
        key: "subject_set",
        label: "Subject set",
        status: ready ? "pass" : "fail",
        detail: ready ? "Subject is present" : "Subject is missing",
      },
    ],
  };
}

function preview(
  campaignId: string,
  overrides: Partial<CampaignSendPreview> = {},
): CampaignSendPreview {
  return {
    campaign_id: campaignId,
    audience_kind: "segment",
    segment_label: "Recent buyers",
    recipients: 10,
    suppressed_excluded: 1,
    deliverable: 9,
    tier_cap_today: 100,
    tier_cap_remaining: 100,
    tier_cap_remaining_after: 91,
    over_cap: false,
    counted_at: "2026-07-20T10:00:00Z",
    ...overrides,
  };
}

function detail(campaignId: string): CampaignDetail {
  return {
    id: campaignId,
    name: campaignId === "campaign-1" ? "Launch" : "Follow-up",
    subject: "Ship it",
    status: "draft",
    body_html: "<p>Hello</p>",
    segment_id: `segment-${campaignId}`,
  } as CampaignDetail;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
