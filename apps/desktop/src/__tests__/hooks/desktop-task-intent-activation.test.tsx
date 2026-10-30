// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  route: { section: "forms", overlay: { name: "create" } } as {
    section: string;
    overlay?: { name: string };
  },
  roleStatus: "resolved" as "loading" | "resolved" | "unavailable",
  replaceOverlay: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/desktop-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/desktop-router")>();
  return {
    ...actual,
    useDesktopRoute: () => mocks.route,
    getDesktopRoute: () => mocks.route,
    replaceDesktopRouteAfterExplicitOverlayClose: mocks.replaceOverlay,
  };
});
vi.mock("../../lib/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/store")>();
  return { ...actual, useRoleStatus: () => mocks.roleStatus };
});
vi.mock("../../components/Toast", () => ({
  toast: { error: mocks.toastError },
}));

import { useWriteDesktopTaskIntent } from "../../hooks/useDesktopTaskIntent";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.route = { section: "forms", overlay: { name: "create" } };
  mocks.roleStatus = "resolved";
  mocks.replaceOverlay.mockReset();
  mocks.replaceOverlay.mockReturnValue(true);
  mocks.toastError.mockReset();
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function Probe(props: {
  open: boolean;
  canMutate: boolean;
  onOpen: () => void;
  onRouteExit: () => void;
}): ReactElement | null {
  useWriteDesktopTaskIntent({ intent: "new-form", ...props });
  return null;
}

function renderProbe(props: Parameters<typeof Probe>[0]): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(<Probe {...props} />));
}

describe("routed desktop task activation", () => {
  it("opens one exact task once across rerenders", () => {
    const onOpen = vi.fn();
    const onRouteExit = vi.fn();
    renderProbe({ open: false, canMutate: true, onOpen, onRouteExit });
    renderProbe({ open: false, canMutate: true, onOpen, onRouteExit });
    renderProbe({ open: true, canMutate: true, onOpen, onRouteExit });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRouteExit).not.toHaveBeenCalled();
  });

  it("waits for role resolution and rejects a forged viewer task", () => {
    const onOpen = vi.fn();
    const onRouteExit = vi.fn();
    mocks.roleStatus = "loading";
    renderProbe({ open: false, canMutate: false, onOpen, onRouteExit });
    expect(onOpen).not.toHaveBeenCalled();
    expect(mocks.replaceOverlay).not.toHaveBeenCalled();

    mocks.roleStatus = "resolved";
    renderProbe({ open: false, canMutate: false, onOpen, onRouteExit });
    expect(onOpen).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.replaceOverlay).toHaveBeenCalledWith("forms", "create");
  });

  it("fails closed when role authority is unavailable", () => {
    const onOpen = vi.fn();
    mocks.roleStatus = "unavailable";
    renderProbe({
      open: false,
      canMutate: true,
      onOpen,
      onRouteExit: vi.fn(),
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledTimes(1);
    expect(mocks.replaceOverlay).toHaveBeenCalledWith("forms", "create");
  });

  it("closes local UI after a history-approved route exit", () => {
    const onOpen = vi.fn();
    const onRouteExit = vi.fn();
    renderProbe({ open: true, canMutate: true, onOpen, onRouteExit });
    mocks.route = { section: "forms" };
    renderProbe({ open: true, canMutate: true, onOpen, onRouteExit });
    expect(onRouteExit).toHaveBeenCalledTimes(1);
    expect(mocks.replaceOverlay).not.toHaveBeenCalled();
  });
});
