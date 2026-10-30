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
  list: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  rotate: vi.fn(),
  writeClipboardText: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  api: {
    listApiKeys: mocks.list,
    createApiKey: mocks.create,
    deleteApiKey: mocks.remove,
    rotateApiKey: mocks.rotate,
  },
}));

vi.mock("../../lib/store", () => ({
  useCanAdmin: () => true,
}));

vi.mock("../../lib/clipboard", () => ({
  clipboardSuccessDetail: () => "Clipboard clears after 60 seconds.",
  writeClipboardText: mocks.writeClipboardText,
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { ApiKeysSection } from "../../components/settings/ApiKeysSection";
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.list.mockResolvedValue({ data: { items: [] } });
  mocks.create.mockResolvedValue({
    data: { plaintext: "pw_one_time_secret" },
  });
  mocks.remove.mockResolvedValue({ data: { ok: true } });
  mocks.rotate.mockResolvedValue({
    data: { plaintext: "pw_rotated_secret" },
  });
  mocks.writeClipboardText.mockResolvedValue({
    ok: true,
    clearScheduled: true,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  resetLifecycleCoordinatorForTests();
});

function render(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<ApiKeysSection />));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!found) throw new Error(`Expected button: ${label}`);
  return found;
}

function setLabel(value: string): void {
  const input = document.querySelector<HTMLInputElement>("#apikey-label");
  if (!input) throw new Error("Expected API-key label input");
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function selectFirstScope(): void {
  const checkbox = document.querySelector<HTMLInputElement>(
    'input[type="checkbox"][aria-label^="read:subscribers"]',
  );
  if (!checkbox) throw new Error("Expected API-key scope checkbox");
  act(() => checkbox.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("workspace API-key sensitive lifecycle", () => {
  it("renders visible key consequences without title-only actions or serious axe findings", async () => {
    mocks.list.mockResolvedValueOnce({
      data: {
        items: [
          {
            id: "key-1",
            label: "Automation",
            prefix: "pw_live",
            scopes: ["read:subscribers"],
            lastUsedAt: null,
            revokedAt: null,
          },
        ],
      },
    });
    render();
    await flush();

    for (const label of ["Rotate", "Revoke"]) {
      const action = button(label);
      expect(action.getAttribute("title")).toBeNull();
      const described =
        action.getAttribute("aria-describedby")?.split(" ") ?? [];
      expect(
        described
          .map((id) => document.getElementById(id)?.textContent)
          .join(" "),
      ).toContain("cannot be undone");
    }
    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("keeps create drafts discard-only and confirms local cancellation", async () => {
    render();
    await flush();
    act(() => button("+ Create key").click());
    setLabel("Automation key");
    selectFirstScope();

    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      {
        label: "Workspace API-key draft",
        level: "warning",
        canSave: false,
        canDiscard: true,
      },
    ]);
    expect(mocks.create).not.toHaveBeenCalled();

    act(() => button("Cancel").click());
    expect(button("Discard draft")).toBeTruthy();
    act(() => button("Keep editing").click());
    expect(
      document.querySelector<HTMLInputElement>("#apikey-label")?.value,
    ).toBe("Automation key");
    act(() => button("Cancel").click());
    act(() => button("Discard draft").click());
    await flush();
    expect(document.querySelector("#apikey-label")).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("keeps failed copies protected and zeroizes on explicit acknowledgement", async () => {
    render();
    await flush();
    act(() => button("+ Create key").click());
    setLabel("Automation key");
    selectFirstScope();
    act(() => button("Create key").click());
    await flush();

    expect(document.body.textContent).toContain("pw_one_time_secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toMatchObject([
      { label: "Workspace API key", level: "blocking" },
    ]);

    mocks.writeClipboardText.mockResolvedValueOnce({
      ok: false,
      message: "clipboard denied",
    });
    act(() => button("Copy").click());
    await flush();
    expect(document.body.textContent).toContain("pw_one_time_secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toHaveLength(1);

    act(() => button("I've saved it").click());
    await flush();
    expect(document.body.textContent).not.toContain("pw_one_time_secret");
    await expect(inspectLifecycle(quitIntent)).resolves.toEqual([]);
  });
});
