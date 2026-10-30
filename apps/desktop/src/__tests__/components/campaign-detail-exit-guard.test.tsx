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

const mocks = vi.hoisted(() => ({
  behavior: vi.fn(),
  discardEdit: vi.fn(),
  editor: {
    discardEdit: vi.fn(),
    draftDirty: true,
    saving: false,
    // The slide-over now also derives the ECO-03 draft checkpoint from the
    // editor's live draft, so these stubs describe the real controller shape
    // rather than only the two fields this test asserts on.
    draft: {
      name: "Campaign one",
      subject: "Subject",
      fromName: "",
      fromEmail: "sender@example.com",
      body: "<p>draft</p>",
      previewText: "",
      goalEvent: "",
      goalWindowHours: 0,
      audienceMode: "dynamic",
    },
    editing: true,
    editorMode: "html" as const,
    openEdit: vi.fn(),
    setDraft: vi.fn(),
  },
}));

vi.mock("../../hooks/useSlideoverBehavior", () => ({
  useSlideoverBehavior: mocks.behavior,
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => true,
  useCanWrite: () => true,
}));

vi.mock("../../components/campaigns/useCampaignDetailData", async () => {
  const actual = await vi.importActual<
    typeof import("../../components/campaigns/useCampaignDetailData")
  >("../../components/campaigns/useCampaignDetailData");
  return {
    ...actual,
    // `detail` and `savedFromEmail` were omitted while nothing read them. The
    // checkpoint derives its content from the saved record, so the stub now
    // carries one. `updated_at` is deliberately ABSENT: without the saved
    // record's timestamp the checkpoint hook cannot tell whether a stored
    // draft is newer, so it stays dormant and this file keeps testing the exit
    // guard rather than the network.
    useCampaignDetailData: () => ({
      id: "campaign-1",
      detail: {
        id: "campaign-1",
        name: "Campaign one",
        subject: "Subject",
        status: "draft",
        body_html: "<p>saved</p>",
        delivery_settings: { from_email: "sender@example.com" },
      },
      savedFromEmail: "sender@example.com",
      isDraft: true,
    }),
  };
});

vi.mock("../../components/campaigns/useCampaignEditorController", async () => {
  const actual = await vi.importActual<
    typeof import("../../components/campaigns/useCampaignEditorController")
  >("../../components/campaigns/useCampaignEditorController");
  // Only the controller hook is stubbed. `draftFromDetail` stays real: the
  // checkpoint compares a stored draft against what the SAVED record would put
  // in the editor, and a stubbed mapping would make that comparison meaningless.
  return { ...actual, useCampaignEditorController: () => mocks.editor };
});

vi.mock("../../components/campaigns/useCampaignLifecycleController", () => ({
  useCampaignLifecycleController: () => ({}),
}));

vi.mock("../../components/campaigns/useCampaignScheduleController", () => ({
  useCampaignScheduleController: () => ({}),
}));

vi.mock("../../components/CampaignDetailPresentation", () => ({
  CampaignDetailPresentation: ({
    closeDisabled,
    onCancelEdit,
    onClose,
  }: {
    closeDisabled: boolean;
    onCancelEdit: () => void;
    onClose: () => void;
  }): ReactElement => (
    <div>
      <button type="button" disabled={closeDisabled} onClick={onClose}>
        Close detail
      </button>
      <button type="button" onClick={onClose}>
        Backdrop
      </button>
      <button type="button" onClick={onCancelEdit}>
        Cancel edit
      </button>
    </div>
  ),
}));

vi.mock("../../components/ConfirmModal", () => ({
  ConfirmModal: ({
    open,
    title,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onClose,
  }: {
    open: boolean;
    title: string;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: () => void;
    onClose: () => void;
  }): ReactElement | null =>
    open ? (
      <div role="alertdialog" aria-label={title}>
        <button type="button" onClick={onClose}>
          {cancelLabel}
        </button>
        <button type="button" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    ) : null,
}));

import { CampaignDetailSlideover } from "../../components/CampaignDetailSlideover";

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
  vi.clearAllMocks();
  mocks.editor.discardEdit = mocks.discardEdit;
  mocks.editor.draftDirty = true;
  mocks.editor.saving = false;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function renderDetail(onClose: () => void = vi.fn()): () => void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <CampaignDetailSlideover
        campaign={{ id: "campaign-1", status: "draft" }}
        onClose={onClose}
      />,
    );
  });
  return onClose;
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return match;
}

describe("campaign detail local exit guard", () => {
  it("keeps edits on close cancellation and discards before closing", () => {
    const onClose = renderDetail();

    act(() => button("Close detail").click());
    expect(document.body.textContent).toContain("Keep editing");
    expect(document.body.textContent).toContain("Discard changes");

    act(() => button("Keep editing").click());
    expect(mocks.discardEdit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    act(() => button("Backdrop").click());
    act(() => button("Discard changes").click());
    expect(mocks.discardEdit).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("discards editor Cancel without closing the detail workspace", () => {
    const onClose = renderDetail();

    act(() => button("Cancel edit").click());
    expect(
      document
        .querySelector('[role="alertdialog"]')
        ?.getAttribute("aria-label"),
    ).toBe("Discard campaign changes?");
    act(() => button("Discard changes").click());

    expect(mocks.discardEdit).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("routes Escape through the same guard and blocks every exit while saving", () => {
    const onClose = renderDetail();
    const behavior = mocks.behavior.mock.calls.at(-1)?.[0] as {
      disableEscape: boolean;
      onClose: () => void;
    };
    expect(behavior.disableEscape).toBe(false);

    act(() => behavior.onClose());
    expect(
      document
        .querySelector('[role="alertdialog"]')
        ?.getAttribute("aria-label"),
    ).toBe("Discard changes and close?");
    expect(onClose).not.toHaveBeenCalled();

    act(() => button("Keep editing").click());
    mocks.editor.saving = true;
    act(() => {
      root?.render(
        <CampaignDetailSlideover
          campaign={{ id: "campaign-1", status: "draft" }}
          onClose={onClose}
        />,
      );
    });

    expect(button("Close detail").disabled).toBe(true);
    const savingBehavior = mocks.behavior.mock.calls.at(-1)?.[0] as {
      disableEscape: boolean;
      onClose: () => void;
    };
    expect(savingBehavior.disableEscape).toBe(true);
    act(() => {
      savingBehavior.onClose();
      button("Backdrop").click();
      button("Cancel edit").click();
    });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});
