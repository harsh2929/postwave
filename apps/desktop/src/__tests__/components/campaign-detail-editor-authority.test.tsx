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

import type {
  CampaignDetail,
  SubjectLabScoredVariant,
} from "../../lib/api-client";
import {
  type CampaignEditorController,
  useCampaignEditorController,
} from "../../components/campaigns/useCampaignEditorController";
import {
  inspectLifecycle,
  resetLifecycleCoordinatorForTests,
  type LifecycleIntent,
} from "../../lib/lifecycle-coordinator";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  freeze: vi.fn(),
  createAB: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  track: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    updateCampaign: mocks.update,
    freezeCampaignAudience: mocks.freeze,
  },
  createABTestCampaign: mocks.createAB,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    info: mocks.toastInfo,
    success: mocks.toastSuccess,
  },
}));

vi.mock("../../lib/telemetry", () => ({ track: mocks.track }));

const quitIntent: LifecycleIntent = {
  kind: "quit-app",
  disposition: "exit",
  title: "Quit Moosewave?",
  description: "Review active work.",
  confirmLabel: "Quit",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let editor: CampaignEditorController;
let setCanMutate: (value: boolean) => void;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({ data: campaign() });
  mocks.freeze.mockResolvedValue({ data: { frozen_members: 12 } });
  mocks.createAB.mockResolvedValue({ data: { children: [{ id: "arm-1" }] } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

describe("campaign editor live authority", () => {
  it("preserves an open local draft but blocks every stale mutation callback after role downgrade", async () => {
    renderHarness();
    act(() => {
      editor.openEdit();
      editor.setDraft((current) => ({ ...current, subject: "Local subject" }));
      editor.setConfirmModeSwitch(true);
      editor.setTranslateOpen(true);
      editor.setUtmOpen(true);
    });
    act(() => setCanMutate(false));

    const preservedDraft = editor.draft;
    act(() => {
      editor.setDraft((current) => ({ ...current, subject: "Forbidden" }));
      editor.setEditorMode("blocks");
      editor.setBlockInstances([{ block_id: "hero", fields: {} }] as never);
      editor.setLastComposedMjml("<mjml>forbidden</mjml>");
    });
    await act(async () => {
      await editor.saveEdit();
      await editor.freezeAudience();
      await editor.pickSubjectFromLab("Forbidden AI subject");
      await editor.runSubjectBandit(scoredVariants());
    });

    expect(editor.editing).toBe(true);
    expect(editor.draft).toEqual(preservedDraft);
    expect(editor.editorMode).toBe("html");
    expect(editor.blockInstances).toEqual([]);
    expect(editor.lastComposedMjml).toBe("");
    expect(editor.confirmModeSwitch).toBe(true);
    expect(editor.translateOpen).toBe(true);
    expect(editor.utmOpen).toBe(true);
    expect(editor.saveErr).toContain("role changed");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.freeze).not.toHaveBeenCalled();
    expect(mocks.createAB).not.toHaveBeenCalled();

    act(() => editor.discardEdit());
    expect(editor.editing).toBe(false);
  });

  it("blocks direct setters, save, discard, and AI actions for the full audience-freeze operation", async () => {
    const freeze = deferred<{ data: { frozen_members: number } }>();
    mocks.freeze.mockReturnValue(freeze.promise);
    renderHarness();
    act(() => {
      editor.openEdit();
      editor.setDraft((current) => ({
        ...current,
        subject: "Keep during freeze",
        audienceMode: "static",
      }));
    });

    let freezeOperation!: Promise<void>;
    act(() => {
      freezeOperation = editor.freezeAudience();
    });
    expect(editor.freezingAudience).toBe(true);
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Campaign changes",
        level: "blocking",
        canDiscard: false,
      },
    ]);

    act(() => {
      editor.setDraft((current) => ({ ...current, subject: "Forbidden" }));
      editor.setEditorMode("blocks");
      editor.setTranslateOpen(true);
      editor.discardEdit();
    });
    await act(async () => {
      await editor.saveEdit();
      await editor.pickSubjectFromLab("Forbidden AI subject");
      await editor.runSubjectBandit(scoredVariants());
    });

    expect(editor.editing).toBe(true);
    expect(editor.draft.subject).toBe("Keep during freeze");
    expect(editor.editorMode).toBe("html");
    expect(editor.translateOpen).toBe(false);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.createAB).not.toHaveBeenCalled();

    freeze.resolve({ data: { frozen_members: 12 } });
    await act(async () => freezeOperation);
    expect(editor.freezingAudience).toBe(false);
    expect(mocks.freeze).toHaveBeenCalledWith("campaign-1");
  });
});

function renderHarness(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<EditorHarness />));
}

function EditorHarness(): ReactElement | null {
  const [detail, setDetail] = useState(campaign());
  const [canMutate, setCanMutateState] = useState(true);
  setCanMutate = setCanMutateState;
  editor = useCampaignEditorController({
    id: detail.id,
    detail,
    setDetail,
    savedFromEmail: "sender@example.com",
    canMutate,
    onChange: () => undefined,
  });
  return null;
}

function campaign(): CampaignDetail {
  return {
    id: "campaign-1",
    name: "Launch",
    subject: "Original subject",
    status: "draft",
    body_html: "<p>Hello</p>",
    audience_mode: "dynamic",
  } as CampaignDetail;
}

function scoredVariants(): SubjectLabScoredVariant[] {
  return ["One", "Two", "Three"].map((text) => ({
    text,
    axis: "length",
    predicted_open: 0.4,
    ci_low: 0.3,
    ci_high: 0.5,
    matched_n: 100,
    low_confidence: false,
    below_baseline: false,
  }));
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
