/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-only
//
// Template previews are sized by max-height/max-width with no intrinsic size,
// so until the (large, unresized) screenshot decodes the <img> lays out at
// height 0 and then expands by up to 1,200px — a big layout shift on the
// template detail and capture surfaces, both of which the API already gives
// exact width/height for.

import { act, createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { trackRoot, unmountRoots } from "../_roots";

import { PreviewImage } from "@/app/(dashboard)/app/templates/_components/preview-image";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  // Every root: a test that renders twice would otherwise leave the first
  // one mounted for the rest of the file.
  unmountRoots();
  document.body.innerHTML = "";
});

function render(props: React.ComponentProps<typeof PreviewImage>): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = trackRoot(container);
  act(() => {
    root.render(createElement(PreviewImage, props));
  });
  return container;
}

describe("PreviewImage intrinsic size", () => {
  it("forwards the asset's width and height so the box is reserved", () => {
    const container = render({
      src: "https://assets.example.com/capture.png",
      alt: "Desktop capture",
      width: 1200,
      height: 2400,
    });

    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("width")).toBe("1200");
    expect(img?.getAttribute("height")).toBe("2400");
  });

  it("omits both when the caller has no dimensions", () => {
    const container = render({
      src: "https://assets.example.com/capture.png",
      alt: "Desktop capture",
    });

    const img = container.querySelector("img");
    expect(img?.hasAttribute("width")).toBe(false);
    expect(img?.hasAttribute("height")).toBe(false);
  });

  it("ignores a partial or nonsensical pair rather than constraining one axis", () => {
    const onlyWidth = render({
      src: "https://assets.example.com/capture.png",
      alt: "Desktop capture",
      width: 1200,
    }).querySelector("img");
    expect(onlyWidth?.hasAttribute("width")).toBe(false);

    const zeroHeight = render({
      src: "https://assets.example.com/capture.png",
      alt: "Desktop capture",
      width: 1200,
      height: 0,
    }).querySelector("img");
    expect(zeroHeight?.hasAttribute("width")).toBe(false);
    expect(zeroHeight?.hasAttribute("height")).toBe(false);
  });
});
