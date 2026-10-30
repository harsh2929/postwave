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
  navigateDesktopRoute: vi.fn(),
  setCommandOpen: vi.fn(),
  setSection: vi.fn(),
}));

vi.mock("../../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/store")>();
  return {
    ...actual,
    setCommandOpen: mocks.setCommandOpen,
    setSection: mocks.setSection,
    setTheme: vi.fn(),
    toggleTheme: vi.fn(),
    useCommandOpen: () => true,
    useMe: () => ({ user: "user-1", tenant: "tenant-1" }),
    useRole: () => "admin",
    useRoleStatus: () => "resolved",
    useTheme: () => "dark",
  };
});
vi.mock("../../lib/desktop-router", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/desktop-router")>();
  return { ...actual, navigateDesktopRoute: mocks.navigateDesktopRoute };
});
vi.mock("../../lib/online-manager", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/online-manager")>();
  return { ...actual, useOnline: () => "online" };
});
vi.mock("../../lib/auditScopes", () => ({
  useAuditScopes: () => ({
    loading: false,
    isAdmin: true,
    scopes: new Set<string>(["admin"]),
    error: null,
  }),
}));
vi.mock("../../lib/capability-observations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../lib/capability-observations")>();
  return {
    ...actual,
    getCapabilityObservation: () => null,
    useCapabilityObservationsRevision: () => 0,
  };
});
vi.mock("../../hooks/useDialogStack", () => ({
  useDialogStack: () => ({ isTop: true }),
}));
vi.mock("../../lib/dialog-accessibility", () => ({
  isolateDialogBackground: () => () => undefined,
  lockDocumentBodyScroll: () => () => undefined,
}));
vi.mock("../../lib/dialogStack", () => ({
  pushDialog: vi.fn(),
  popDialog: vi.fn(),
  topDialog: () => null,
}));

import { CommandPalette } from "../../components/CommandPalette";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.navigateDesktopRoute.mockReset();
  mocks.setCommandOpen.mockReset();
  mocks.setSection.mockReset();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("CommandPalette accessibility", () => {
  it("uses one active-descendant listbox model and opens a synonym result", () => {
    render(<CommandPalette />);
    const input = commandInput();
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    setInput(input, "/2FA");

    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    const options = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    );
    expect(listbox?.id).toBe(input.getAttribute("aria-controls"));
    expect(options).toHaveLength(1);
    expect(options[0]?.getAttribute("aria-label")).toContain("Security");
    expect(options[0]?.tabIndex).toBe(-1);
    expect(input.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    expect(document.activeElement).toBe(input);

    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
    });
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    act(() => {
      input.dispatchEvent(composingEnter);
    });
    expect(mocks.navigateDesktopRoute).not.toHaveBeenCalled();

    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });
    expect(options[0]?.dispatchEvent(down)).toBe(false);
    expect(document.activeElement).toBe(input);
    act(() => options[0]?.click());
    expect(mocks.navigateDesktopRoute).toHaveBeenCalledWith({
      section: "settings",
      settingsAnchor: "security",
    });
    expect(mocks.setCommandOpen).toHaveBeenCalledWith(false);
  });

  it("keeps no-result arrow navigation bounded and announces the count", () => {
    render(<CommandPalette />);
    const input = commandInput();
    setInput(input, "/definitely-not-a-destination");
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "0 results",
    );
  });

  it("dispatches a named action to its exact routed task", () => {
    render(<CommandPalette />);
    setInput(commandInput(), ">new campaign");
    const option = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
    ).find((candidate) => candidate.textContent?.includes("New campaign"));
    expect(option).toBeDefined();
    act(() => option?.click());
    expect(mocks.navigateDesktopRoute).toHaveBeenCalledWith({
      section: "campaigns",
      overlay: { name: "create" },
    });
    expect(mocks.setSection).not.toHaveBeenCalled();
    expect(mocks.setCommandOpen).toHaveBeenCalledWith(false);
  });
});

function render(node: ReactElement): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
}

function commandInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>(
    'input[aria-label="Search commands"]',
  );
  if (!input) throw new Error("Missing command input");
  return input;
}

function setInput(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
