// @vitest-environment happy-dom

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

const mocks = vi.hoisted(() => ({ openUrl: vi.fn() }));

vi.mock("../../lib/tauri", () => ({
  tauriApi: { openUrl: mocks.openUrl },
}));

import { LegalLinks } from "../../components/LegalLinks";
import { LEGAL_URLS } from "../../lib/config";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.openUrl.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<LegalLinks />));
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
  vi.resetAllMocks();
});

function link(label: string): HTMLButtonElement {
  const found = Array.from(
    container?.querySelectorAll<HTMLButtonElement>("button") ?? [],
  ).find((candidate) => candidate.textContent?.trim() === label);
  expect(found).toBeDefined();
  return found!;
}

describe("LegalLinks", () => {
  it("exposes semantic navigation and opens configured URLs externally", async () => {
    const nav = container?.querySelector("nav");
    expect(nav?.getAttribute("aria-label")).toBe("Legal and support");
    expect(container?.querySelectorAll("button")).toHaveLength(3);
    expect(link("Privacy").getAttribute("aria-label")).toContain(
      "default browser",
    );

    await act(async () => link("Privacy").click());
    expect(mocks.openUrl).toHaveBeenCalledWith(LEGAL_URLS.privacy);
    expect(container?.querySelector('[role="alert"]')).toBeNull();
  });

  it("contains native-launch failures and gives the user a recovery path", async () => {
    mocks.openUrl.mockRejectedValueOnce(
      new Error("private shell detail must not leak"),
    );

    await act(async () => link("Support").click());
    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(
      "Moosewave couldn't open your browser. Check your default-browser settings and try again.",
    );
    expect(alert?.textContent).not.toContain("private shell detail");
  });
});
