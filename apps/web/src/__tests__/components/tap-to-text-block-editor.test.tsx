// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Tap-to-text block (desktop→web parity messaging-35): copy the SMS link, copy
// the HTML snippet, download the QR. Each verb is asserted by what reaches the
// clipboard / the downloaded file, and nothing is sent over the network.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  copy: vi.fn(
    async (_text: string): Promise<"copied" | "unavailable" | "error"> =>
      "copied",
  ),
  download: vi.fn(
    (_name: string, _content: string, _mime?: string) => undefined,
  ),
  fetch: vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("{}"),
  ),
}));

vi.mock("@/lib/clipboard", () => ({
  copyToClipboard: mocks.copy,
  isClipboardAvailable: () => true,
}));
vi.mock("@/lib/download", () => ({ downloadTextFile: mocks.download }));

import {
  buildSmsUri,
  parseSmsDestination,
  TapToTextBlockEditor,
} from "@/components/sms/TapToTextBlockEditor";

let root: Root | null = null;

function render() {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(createElement(TapToTextBlockEditor)));
}

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
};

function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const el = Array.from(document.querySelectorAll("label")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  const target = el && document.getElementById(el.htmlFor);
  if (!target) throw new Error(`field ${label} missing`);
  return target as HTMLInputElement | HTMLTextAreaElement;
}

function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el) as object,
      "value",
    )!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll("button")).find(
    (b) => b.textContent?.trim() === label,
  );
  if (!found) throw new Error(`button ${label} missing`);
  return found as HTMLButtonElement;
}

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

describe("tap-to-text helpers", () => {
  it("accepts only reviewed destinations and encodes the keyword as %20, never +", () => {
    expect(parseSmsDestination("12345")).toBe("12345");
    expect(parseSmsDestination("+1 (415) 555-0123")).toBe("+14155550123");
    expect(parseSmsDestination("4155550123")).toBeNull();
    expect(
      parseSmsDestination(`+1415555012${String.fromCharCode(0x202e)}3`),
    ).toBeNull();
    expect(buildSmsUri("12345", "JOIN NOW")).toBe("sms:12345?body=JOIN%20NOW");
  });
});

describe("TapToTextBlockEditor", () => {
  it("copies the generated SMS link and HTML snippet, and downloads the QR as SVG", async () => {
    render();
    expect(button("Copy link").disabled).toBe(true);
    typeInto(
      field("Short code or number") as HTMLInputElement,
      "+1 (415) 555-0123",
    );
    typeInto(field("Keyword") as HTMLInputElement, "JOIN");
    typeInto(
      field("Button label (optional)") as HTMLInputElement,
      "Text us <now>",
    );
    await flush();

    expect(field("Generated SMS link").value).toBe(
      "sms:+14155550123?body=JOIN",
    );

    act(() => button("Copy link").click());
    await flush(2);
    expect(mocks.copy).toHaveBeenLastCalledWith("sms:+14155550123?body=JOIN");
    expect(document.body.textContent).toContain("SMS link copied.");

    act(() => button("Copy HTML").click());
    await flush(2);
    const html = mocks.copy.mock.calls.at(-1)?.[0] ?? "";
    expect(html).toContain('href="sms:+14155550123?body=JOIN"');
    expect(html).toContain(">Text us &lt;now&gt;</a>");
    expect(html).not.toContain("<now>");

    // The QR paints after its own render pass; under a loaded full-suite run
    // that can land after the copy flushes above, so wait for it.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (document.querySelector('[data-testid="tap-to-text-qr"] path')) break;
      await flush();
    }
    expect(
      document.querySelector('[data-testid="tap-to-text-qr"] path'),
    ).not.toBeNull();
    act(() => button("Download QR").click());
    expect(mocks.download).toHaveBeenCalledTimes(1);
    const [name, svg, mime] = mocks.download.mock.calls[0]!;
    expect(name).toBe("postwave-tap-to-text-qr.svg");
    expect(mime).toBe("image/svg+xml;charset=utf-8");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('<path d="M');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("escapes what encodeURIComponent leaves raw inside the copied href attribute", async () => {
    render();
    typeInto(field("Short code or number") as HTMLInputElement, "12345");
    typeInto(field("Keyword") as HTMLInputElement, "IT'S");
    await flush();
    expect(field("Generated SMS link").value).toBe("sms:12345?body=IT'S");
    act(() => button("Copy HTML").click());
    await flush(2);
    const html = mocks.copy.mock.calls.at(-1)?.[0] ?? "";
    expect(html).toContain('<a href="sms:12345?body=IT&#39;S"');
    expect(html).toContain(">Text IT&#39;S to 12345</a>");
  });

  it("refuses an ambiguous destination: no link, no copy, no QR", async () => {
    render();
    typeInto(field("Short code or number") as HTMLInputElement, "4155550123");
    typeInto(field("Keyword") as HTMLInputElement, "JOIN");
    await flush();
    expect(document.body.textContent).toContain(
      "Enter a 5–6 digit short code or a plus-prefixed E.164",
    );
    expect(field("Generated SMS link").value).toBe("");
    expect(button("Copy link").disabled).toBe(true);
    expect(button("Copy HTML").disabled).toBe(true);
    expect(button("Download QR").disabled).toBe(true);
  });

  it("reports a refused clipboard write instead of claiming success", async () => {
    mocks.copy.mockResolvedValueOnce("error");
    render();
    typeInto(field("Short code or number") as HTMLInputElement, "12345");
    typeInto(field("Keyword") as HTMLInputElement, "JOIN");
    await flush();
    act(() => button("Copy link").click());
    await flush(2);
    expect(document.body.textContent).toContain(
      "The browser refused the clipboard write",
    );
    expect(document.body.textContent).not.toContain("SMS link copied.");
  });

  it("is mounted on the SMS workspace Audience tab", () => {
    const workspace = readFileSync(
      resolve(process.cwd(), "src/app/(dashboard)/app/sms/sms-workspace.tsx"),
      "utf8",
    );
    expect(workspace).toContain(
      'import("@/components/sms/TapToTextBlockEditor")',
    );
    const audience = workspace.slice(
      workspace.indexOf('<TabsContent value="audience"'),
      workspace.indexOf('<TabsContent value="campaigns"'),
    );
    expect(audience).toContain("<TapToTextBlockEditor />");
  });
});
