// @vitest-environment happy-dom

import axe from "axe-core";
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

const mocks = vi.hoisted(() => ({
  canWrite: false,
  canAdmin: false,
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listForms: mocks.list,
    createForm: mocks.create,
    getForm: mocks.get,
    updateForm: mocks.update,
    deleteForm: mocks.remove,
  },
}));
vi.mock("../../lib/store", () => ({
  useCanWrite: () => mocks.canWrite,
  useCanAdmin: () => mocks.canAdmin,
}));
vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
    info: mocks.toastInfo,
  },
}));
vi.mock("../../lib/deep-link", () => ({
  consumePendingDeepLinkTarget: () => null,
  onPendingDeepLinkTarget: () => () => undefined,
}));
vi.mock("../../lib/desktop-task-intents", () => ({
  consumeDesktopTaskIntent: vi.fn(),
}));
vi.mock("../../hooks/useDesktopTaskIntent", () => ({
  useWriteDesktopTaskIntent: () => undefined,
}));
vi.mock("../../lib/lifecycle-coordinator", () => ({
  registerLifecycleGuard: () => () => undefined,
}));
vi.mock("../../components/FormDetailSlideover", () => ({
  FormDetailSlideover: () => <div role="dialog" aria-label="Form detail" />,
}));
vi.mock("../../components/forms/GrowthPanel", () => ({
  GrowthPanel: () => <div role="dialog" aria-label="Growth" />,
}));
vi.mock("../../components/forms/VariantsPanel", () => ({
  VariantsPanel: () => <div role="dialog" aria-label="Variants" />,
}));
vi.mock("../../components/forms/LandingPagesSection", () => ({
  LandingPagesSection: () => <section aria-label="Landing pages" />,
}));
vi.mock("../../components/forms/SocialCaptureSection", () => ({
  SocialCaptureSection: () => <section aria-label="Social capture" />,
}));
vi.mock("../../components/forms/FormsStatStrip", () => ({
  FormsStatStrip: () => <div role="status" aria-label="Form statistics" />,
}));
vi.mock("../../components/PendingSyncStatus", () => ({
  PendingSyncStatus: () => null,
}));

import { Forms } from "../../pages/Forms";

const form = {
  id: "form-1",
  name: "Newsletter",
  slug: "newsletter",
  status: "draft",
  optInMode: "double",
  submissions30d: 12,
  conversionRate: 24,
  visits30d: 50,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.canWrite = false;
  mocks.canAdmin = false;
  for (const key of [
    "list",
    "create",
    "get",
    "update",
    "remove",
    "toastError",
    "toastSuccess",
    "toastInfo",
  ] as const) {
    mocks[key].mockReset();
  }
  mocks.list.mockResolvedValue({ data: [form] });
  mocks.update.mockResolvedValue({ data: form });
  mocks.remove.mockResolvedValue({ data: { ok: true } });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Forms />));
}

function button(label: string): HTMLButtonElement {
  const found = [
    ...document.querySelectorAll<HTMLButtonElement>("button"),
  ].find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function change(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Forms interaction maturity", () => {
  it("keeps viewer actions visible and inert with explicit descriptions and no serious axe findings", async () => {
    render();
    await flush();
    expect(document.body.textContent).toContain("Read-only access");
    expect(document.body.textContent).toContain(
      "require an editor or admin role",
    );
    for (const action of [
      button("New form"),
      button("Use template"),
    ]) {
      expect(action.disabled).toBe(false);
      expect(action.getAttribute("aria-disabled")).toBe("true");
      expect(action.getAttribute("title")).toBeNull();
      act(() => action.click());
    }
    expect(mocks.get).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("Social capture is staged");
    expect(document.body.textContent).toContain(
      "Variants and onsite experiments are not connected to public rendering.",
    );
    expect(document.body.textContent).not.toContain("Duplicate");
    expect(button("All").getAttribute("aria-pressed")).toBe("true");
    expect(
      container?.querySelectorAll(
        "button[title], input[title], select[title], textarea[title], a[title]",
      ),
    ).toHaveLength(0);
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("exposes the three capture surfaces as a keyboard-operable tabset", async () => {
    render();
    await flush();
    const tabs = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ];
    expect(tabs).toHaveLength(3);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");

    act(() => {
      tabs[0]?.focus();
      tabs[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')
        ?.textContent,
    ).toContain("Deployment-qualified delivery");

    act(() => {
      tabs[1]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(tabs[2]?.getAttribute("aria-selected")).toBe("true");
    expect(
      document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')
        ?.textContent,
    ).toContain("Social capture is staged, not live");
  });

  it("retains the last confirmed inventory when refresh fails", async () => {
    render();
    await flush();
    expect(document.body.textContent).toContain("Newsletter");
    mocks.list.mockResolvedValueOnce({
      error: { message: "Gateway unavailable", status: 503 },
    });

    act(() => button("Refresh").click());
    await flush();

    expect(document.body.textContent).toContain("Couldn’t refresh Forms");
    expect(document.body.textContent).toContain(
      "The last confirmed inventory remains available below.",
    );
    expect(document.body.textContent).toContain("Newsletter");
    expect(document.body.textContent).not.toContain(
      "Turn visitors into subscribers.",
    );
  });

  it("does not present malformed collection data as a healthy empty state", async () => {
    mocks.list.mockResolvedValue({ data: { unexpected: true } });
    render();
    await flush();

    expect(document.body.textContent).toContain("Couldn’t load Forms");
    expect(document.body.textContent).toContain("unrecognised Forms response");
    expect(document.body.textContent).not.toContain(
      "Turn visitors into subscribers.",
    );
  });

  it("single-flights form creation and locks dismissal while the request is active", async () => {
    mocks.canWrite = true;
    let resolveCreate!: (value: unknown) => void;
    mocks.create.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    render();
    await flush();
    act(() => button("New form").click());
    const name = document.querySelector<HTMLInputElement>("#form-create-name");
    expect(name).not.toBeNull();
    change(name!, "Launch list");
    const create = button("Create form");
    act(() => {
      create.click();
      create.click();
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(button("Creating…").getAttribute("aria-busy")).toBe("true");
    expect(button("Cancel").disabled).toBe(true);
    await act(async () => {
      resolveCreate({ data: { ...form, id: "form-2", name: "Launch list" } });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.querySelector("#form-create-name")).toBeNull();
  });

  it("keeps pagination boundaries discoverable and guards unavailable directions", async () => {
    mocks.list.mockResolvedValue({
      data: Array.from({ length: 25 }, (_, index) => ({
        ...form,
        id: `form-${index + 1}`,
        name: `Form ${index + 1}`,
      })),
    });
    render();
    await flush();

    const previous = button("Prev");
    const next = button("Next");
    expect(previous.disabled).toBe(false);
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    expect(previous.getAttribute("aria-label")).toBe("Previous page");
    expect(document.body.textContent).toContain("Page 1 of 2");
    act(() => previous.click());
    expect(document.body.textContent).toContain("Page 1 of 2");

    act(() => next.click());
    expect(document.body.textContent).toContain("Page 2 of 2");
    const lastNext = button("Next");
    expect(lastNext.disabled).toBe(false);
    expect(lastNext.getAttribute("aria-disabled")).toBe("true");
    act(() => lastNext.click());
    expect(document.body.textContent).toContain("Page 2 of 2");
    act(() => button("Prev").click());
    expect(document.body.textContent).toContain("Page 1 of 2");
  });

  it("keeps only failed rows selected after a partial bulk update", async () => {
    mocks.canWrite = true;
    mocks.list.mockResolvedValue({
      data: [
        form,
        { ...form, id: "form-2", name: "Waitlist", slug: "waitlist" },
      ],
    });
    mocks.update
      .mockResolvedValueOnce({
        error: { message: "Conflict", status: 409 },
      })
      .mockResolvedValueOnce({ data: { ...form, id: "form-2" } });
    render();
    await flush();

    const selections = [
      ...document.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"][aria-label*="bulk action"]',
      ),
    ];
    expect(selections).toHaveLength(2);
    act(() => {
      selections[0]?.click();
      selections[1]?.click();
    });
    expect(document.body.textContent).toContain("2 selected");

    act(() => button("Publish").click());
    await flush();

    expect(mocks.update).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("1 selected");
    expect(selections[0]?.checked).toBe(true);
    expect(selections[1]?.checked).toBe(false);
  });

  it("blocks invalid lifecycle batches that include an archived form", async () => {
    mocks.canWrite = true;
    mocks.canAdmin = true;
    mocks.list.mockResolvedValue({
      data: [{ ...form, status: "archived" }],
    });
    render();
    await flush();
    const selection = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"][aria-label*="bulk action"]',
    );
    act(() => selection?.click());

    expect(document.body.textContent).toContain("Archived forms are terminal");
    for (const label of ["Publish", "Move to draft", "Archive"]) {
      expect(button(label).getAttribute("aria-disabled")).toBe("true");
      act(() => button(label).click());
    }
    expect(document.body.textContent).not.toContain("Delete");
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("withholds unsafe client-orchestrated bulk deletion", async () => {
    mocks.canWrite = true;
    render();
    await flush();
    const selection = document.querySelector<HTMLInputElement>(
      'input[type="checkbox"][aria-label*="bulk action"]',
    );
    act(() => selection?.click());

    expect(document.body.textContent).toContain("1 selected");
    expect(document.body.textContent).not.toContain("Delete");
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
