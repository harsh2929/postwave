// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { SmsPhonePreview } from "@/app/(dashboard)/app/sms/sms-phone-preview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("SmsPhonePreview external media privacy", () => {
  it("does not create a media request target until the operator opts in", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <SmsPhonePreview
          body="Preview body"
          mediaUrl="https://media.example.test/private.png"
        />,
      );
    });

    expect(host.querySelector("img[src]")).toBeNull();
    expect(host.textContent).toContain("External media is hidden");

    const load = Array.from(host.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Load external media",
    );
    expect(load).toBeDefined();
    act(() => load?.click());

    const image = host.querySelector("img");
    expect(image?.getAttribute("src")).toBe(
      "https://media.example.test/private.png",
    );
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("requires fresh consent when the media URL changes", () => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);

    act(() => {
      root?.render(
        <SmsPhonePreview body="Preview" mediaUrl="https://one.example/a.png" />,
      );
    });
    act(() =>
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent?.trim() === "Load external media")
        ?.click(),
    );
    expect(host.querySelector("img")?.getAttribute("src")).toContain(
      "one.example",
    );

    act(() => {
      root?.render(
        <SmsPhonePreview body="Preview" mediaUrl="https://two.example/b.png" />,
      );
    });
    expect(host.querySelector("img[src]")).toBeNull();
  });
});
