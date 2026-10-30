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

const defaultTheme = {
  logo_url: "",
  primary_color: "#2563eb",
  footer_text: "",
  show_postwave_badge: true,
};

const mocks = vi.hoisted(() => ({
  getTheme: vi.fn(),
  saveTheme: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("../../lib/api-client", () => ({
  defaultPreferenceCustomization: () => ({ ...defaultTheme }),
  api: {
    privacyPortal: {
      getPreferenceCustomization: mocks.getTheme,
      savePreferenceCustomization: mocks.saveTheme,
    },
  },
}));

vi.mock("../../components/Toast", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

import { PreferenceCenterCustomization } from "../../components/privacy/PreferenceCenterCustomization";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTheme.mockResolvedValue({ data: defaultTheme });
  mocks.saveTheme.mockResolvedValue({ data: defaultTheme });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

async function renderTheme(): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<PreferenceCenterCustomization />));
  await flush();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function setInput(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  act(() => {
    const prototype =
      target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      target,
      value,
    );
    target.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("PreferenceCenterCustomization interaction maturity", () => {
  it("keeps the preview inert and blocks unsafe URLs and inaccessible colors", async () => {
    await renderTheme();
    const preview = document.querySelector<HTMLElement>(
      '.preference-theme-preview[aria-label="Hosted preference-center live preview"]',
    );
    if (!preview) throw new Error("Missing theme preview");
    expect(preview.querySelector("button,input,textarea,select")).toBeNull();
    expect(document.body.textContent).toContain("current ratio:");
    expect(container?.querySelector("[title]")).toBeNull();

    const logo = document.querySelector<HTMLInputElement>('input[type="url"]');
    if (!logo) throw new Error("Missing logo URL field");
    const colorText = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="text"]'),
    ).find((input) => input.value.startsWith("#"));
    if (!colorText) throw new Error("Missing color text field");

    setInput(logo, "javascript:alert(1)");
    expect(document.body.textContent).toContain(
      "Logo URL must be a public HTTPS URL without embedded credentials.",
    );
    expect(button("Save").getAttribute("aria-disabled")).toBe("true");
    expect(preview.querySelector("img")).toBeNull();

    setInput(logo, "https://127.0.0.1/private-logo.png");
    expect(document.body.textContent).toContain(
      "Logo URL must be a public HTTPS URL",
    );
    expect(preview.querySelector("img")).toBeNull();

    setInput(logo, "https://cdn.example.test/brand.png#tracking");
    setInput(colorText, "#ffffff");
    expect(document.body.textContent).toContain("choose a darker color");
    act(() => button("Save").click());
    expect(mocks.saveTheme).not.toHaveBeenCalled();
    setInput(colorText, "#000000");
    expect(button("Save").getAttribute("aria-disabled")).toBeNull();
    const image = preview.querySelector<HTMLImageElement>("img");
    expect(image?.referrerPolicy).toBe("no-referrer");
    expect(image?.src).toBe("https://cdn.example.test/brand.png");

    const result = await axe.run(container ?? document.body);
    expect(
      result.violations.filter(
        (violation) =>
          violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
  });

  it("single-flights a safe catalog retry and never exposes the thrown detail", async () => {
    mocks.getTheme
      .mockImplementationOnce(() => {
        throw new Error("private theme database and tenant detail");
      })
      .mockResolvedValueOnce({ data: defaultTheme });
    await renderTheme();
    expect(document.body.textContent).toContain(
      "The service could not be reached. Check the connection and retry.",
    );
    expect(document.body.textContent).not.toContain("private theme database");
    expect(button("Save").disabled).toBe(false);
    expect(button("Save").getAttribute("aria-disabled")).toBe("true");
    const retry = button("Retry");
    act(() => {
      retry.click();
      retry.click();
    });
    await flush();
    expect(mocks.getTheme).toHaveBeenCalledTimes(2);
    expect(
      document.querySelector<HTMLTextAreaElement>("textarea")?.disabled,
    ).toBe(false);
  });

  it("single-flights save, preserves focusability, and waits for acknowledgement", async () => {
    const pending = deferred<{ data: typeof defaultTheme }>();
    mocks.saveTheme.mockReturnValue(pending.promise);
    await renderTheme();
    const footer = document.querySelector<HTMLTextAreaElement>("textarea");
    if (!footer) throw new Error("Missing footer field");
    setInput(footer, "Complete legal footer");
    const save = button("Save");
    act(() => {
      save.click();
      save.click();
    });
    expect(mocks.saveTheme).toHaveBeenCalledTimes(1);
    expect(button("Saving…").disabled).toBe(false);
    expect(button("Saving…").getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(
      "waiting for the server acknowledgement",
    );

    await act(async () => {
      pending.resolve({
        data: { ...defaultTheme, footer_text: "Complete legal footer" },
      });
      await pending.promise;
    });
    await flush();
    expect(button("Save").getAttribute("aria-disabled")).toBe("true");
    expect(mocks.toastSuccess).toHaveBeenCalledWith({
      message: "Saved preference-center theme.",
      detail: "The hosted preference center will use this acknowledged theme.",
    });
  });
});
