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
  qr: vi.fn(),
  clipboard: vi.fn(),
}));

vi.mock("qrcode", () => ({
  default: { toDataURL: mocks.qr },
}));
vi.mock("../../lib/clipboard", () => ({
  writeClipboardText: mocks.clipboard,
}));
vi.mock("../../components/Toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { EmbedPreviewCard } from "../../components/forms/EmbedPreviewCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.qr.mockResolvedValue("data:image/png;base64,locally-generated");
  mocks.clipboard.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function render(status: string): Promise<void> {
  act(() =>
    root?.render(
      <EmbedPreviewCard publicUrl="about:blank#newsletter" status={status} />,
    ),
  );
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function previewButton(): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === "Show live",
  );
  if (!found) throw new Error("Missing live-preview button");
  return found;
}

describe("EmbedPreviewCard maturity", () => {
  it("generates QR data locally and keeps an archived preview focusable, described, and inert", async () => {
    await render("archived");

    expect(mocks.qr).toHaveBeenCalledWith("about:blank#newsletter", {
      margin: 1,
      width: 160,
    });
    const qr = document.querySelector<HTMLImageElement>('img[alt^="QR code"]');
    expect(qr?.src).toBe("data:image/png;base64,locally-generated");
    expect(document.querySelector('[src*="qrserver"]')).toBeNull();

    const action = previewButton();
    expect(action.disabled).toBe(false);
    expect(action.getAttribute("aria-disabled")).toBe("true");
    expect(action.getAttribute("title")).toBeNull();
    const descriptionId = action.getAttribute("aria-describedby");
    expect(document.getElementById(descriptionId ?? "")?.textContent).toContain(
      "Archived forms cannot be loaded",
    );
    action.focus();
    expect(document.activeElement).toBe(action);
    act(() => action.click());
    expect(document.querySelector("iframe")).toBeNull();

    const result = await axe.run(document.body);
    expect(
      result.violations.filter((violation) => violation.impact === "serious"),
    ).toEqual([]);
  });

  it("loads a requested preview with a constrained sandbox and no referrer", async () => {
    await render("published");
    act(() => previewButton().click());

    const frame = document.querySelector<HTMLIFrameElement>("iframe");
    expect(frame?.title).toBe("Form preview");
    expect(frame?.getAttribute("sandbox")).toBe("allow-forms allow-scripts");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("src")).toBe("about:blank#newsletter");
  });
});
