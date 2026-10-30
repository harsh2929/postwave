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

const mocks = vi.hoisted(() => ({
  createFeedback: vi.fn(),
  deleteTranslation: vi.fn(),
  listFeedback: vi.fn(),
  listTranslations: vi.fn(),
  resolveFeedback: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  upsertTranslation: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    createCampaignFeedback: mocks.createFeedback,
    deleteCampaignTranslation: mocks.deleteTranslation,
    listCampaignFeedback: mocks.listFeedback,
    listCampaignTranslations: mocks.listTranslations,
    resolveCampaignFeedback: mocks.resolveFeedback,
    upsertCampaignTranslation: mocks.upsertTranslation,
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { CampaignFeedback } from "../../components/CampaignFeedback";
import { CampaignTranslationsPanel } from "../../components/campaigns/CampaignTranslationsPanel";
import {
  inspectLifecycle,
  prepareLifecycle,
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let setFeedbackCanMutate: (value: boolean) => void;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listFeedback.mockResolvedValue({ data: { items: [] } });
  mocks.createFeedback.mockResolvedValue({
    data: {
      id: "feedback-1",
      body: "Review this",
      author_label: "Reviewer",
      created_at: "2026-07-16T09:00:00.000Z",
    },
  });
  mocks.resolveFeedback.mockResolvedValue({ data: undefined });
  mocks.listTranslations.mockResolvedValue({
    data: { translations: [] },
  });
  mocks.upsertTranslation.mockResolvedValue({
    data: { locale: "fr", subject: "Bonjour", body_html: "<p>Salut</p>" },
  });
  mocks.deleteTranslation.mockResolvedValue({ data: undefined });
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

function input(selector: string): HTMLInputElement | HTMLTextAreaElement {
  const element = document.querySelector(selector);
  if (
    !(element instanceof HTMLInputElement) &&
    !(element instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`Missing input: ${selector}`);
  }
  return element;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  act(() => {
    const descriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      "value",
    );
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("campaign content lifecycle behavior", () => {
  it("keeps feedback drafts discard-only and never posts during prepare", async () => {
    render(<CampaignFeedback campaignID="campaign-1" canMutate />);
    await flush();
    setValue(input("textarea"), "Review this before launch");

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Campaign feedback draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);
    await act(async () => prepareLifecycle(quitIntent));
    expect(mocks.createFeedback).not.toHaveBeenCalled();
  });

  it("keeps a feedback draft read-only and blocks stale post authority after downgrade", async () => {
    render(<FeedbackAuthorityHarness />);
    await flush();
    const draft = input("textarea");
    setValue(draft, "Keep this local review note");

    act(() => setFeedbackCanMutate(false));

    expect(draft.value).toBe("Keep this local review note");
    expect(draft.readOnly).toBe(true);
    const post = Array.from(document.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Post comment",
    ) as HTMLButtonElement | undefined;
    expect(post?.disabled).toBe(true);
    post?.click();
    expect(mocks.createFeedback).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Feedback is read-only");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Campaign feedback draft", canDiscard: true },
    ]);
  });

  it("keeps unrouted locale variants inspectable but read-only", async () => {
    render(<CampaignTranslationsPanel campaignId="campaign-1" canMutate />);
    await flush();

    expect(document.body.textContent).toContain(
      "Language variants are read-only until routing is available",
    );
    expect(document.body.textContent).toContain(
      "Adding, editing, and deleting variants is disabled",
    );
    expect(document.body.textContent).not.toContain("+ Add language");
    expect(mocks.upsertTranslation).not.toHaveBeenCalled();
    expect(mocks.deleteTranslation).not.toHaveBeenCalled();
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});

function FeedbackAuthorityHarness(): ReactElement {
  const [canMutate, setCanMutate] = useState(true);
  setFeedbackCanMutate = setCanMutate;
  return <CampaignFeedback campaignID="campaign-1" canMutate={canMutate} />;
}
