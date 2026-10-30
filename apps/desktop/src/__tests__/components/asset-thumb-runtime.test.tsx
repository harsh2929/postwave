// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const imageSource = vi.hoisted(() => ({
  value: "https://example.test/one.png" as string | null,
  status: "ready" as "empty" | "loading" | "ready" | "error",
}));
vi.mock("../../lib/asset-display", () => ({
  useAssetImageSrc: () => ({
    src: imageSource.value,
    failed: imageSource.status === "error",
    status: imageSource.status,
  }),
}));

import { AssetThumb } from "../../components/library/AssetThumb";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  imageSource.value = "https://example.test/one.png";
  imageSource.status = "ready";
});

describe("AssetThumb", () => {
  it("uses private-safe image attributes and resets a decode failure when the source changes", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (): void => {
      act(() =>
        root?.render(
          <AssetThumb
            url={imageSource.value}
            alt="Hero"
            fallback={<span>Unavailable</span>}
          />,
        ),
      );
    };
    render();
    const image = container.querySelector("img")!;
    expect(image.getAttribute("decoding")).toBe("async");
    expect(image.getAttribute("referrerpolicy")).toBe("no-referrer");
    act(() => {
      image.dispatchEvent(new Event("error"));
    });
    expect(container.textContent).toContain("Unavailable");
    imageSource.value = "https://example.test/two.png";
    render();
    expect(container.querySelector("img")?.src).toContain("two.png");
  });

  it("shows a truthful loading state instead of the terminal fallback during a slow blob fetch", () => {
    imageSource.value = null;
    imageSource.status = "loading";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const render = (): void => {
      act(() =>
        root?.render(
          <AssetThumb
            url="/api/v1/assets/asset-1/blob"
            alt="Campaign hero"
            fallback={<span>Unavailable</span>}
          />,
        ),
      );
    };

    render();
    expect(
      container.querySelector('[data-asset-image-state="loading"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Loading");
    expect(container.textContent).not.toContain("Unavailable");

    imageSource.status = "error";
    render();
    expect(
      container.querySelector('[data-asset-image-state="error"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Unavailable");
  });

  it("pauses GIF previews by default and requires an explicit animation opt-in", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() =>
      root?.render(
        <AssetThumb
          url="/api/v1/assets/animated/blob"
          mime="image/gif"
          alt="Animated confetti"
        />,
      ),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(
      container.querySelector('[data-asset-image-state="paused"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("GIF · paused");

    act(() =>
      root?.render(
        <AssetThumb
          url="https://example.test/animated.gif"
          mime="image/gif"
          alt="Animated confetti"
          allowAnimation
        />,
      ),
    );
    expect(container.querySelector("img")).not.toBeNull();
  });
});
