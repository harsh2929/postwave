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

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  createObjectURL: vi.fn(() => "blob:postwave-asset"),
  revokeObjectURL: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
  getApiKey: () => "desktop-test-key",
  getApiUrl: () => "http://127.0.0.1:8080",
}));
vi.mock("../lib/native-api-fetch", () => ({ nativeAwareFetch: mocks.fetch }));

import { useAssetImageSrc } from "../lib/asset-display";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function Probe(): React.ReactElement {
  const image = useAssetImageSrc("/api/v1/assets/asset-1/blob");
  return (
    <output data-status={image.status} data-src={image.src ?? ""}>
      {image.status}
    </output>
  );
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.createObjectURL.mockClear();
  mocks.revokeObjectURL.mockClear();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: mocks.createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: mocks.revokeObjectURL,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("useAssetImageSrc", () => {
  it("keeps an authenticated blob in loading state until the slow response is usable", async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;
    mocks.fetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    act(() => root?.render(<Probe />));
    expect(
      container?.querySelector("output")?.getAttribute("data-status"),
    ).toBe("loading");
    expect(container?.querySelector("output")?.getAttribute("data-src")).toBe(
      "",
    );
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/api/v1/assets/asset-1/blob",
      expect.objectContaining({
        credentials: "include",
        headers: { Authorization: "Bearer pw_desktop-test-key" },
      }),
    );

    await act(async () => {
      resolveFetch?.({
        ok: true,
        blob: vi
          .fn()
          .mockResolvedValue(new Blob(["image"], { type: "image/png" })),
      });
      for (let index = 0; index < 4; index += 1) await Promise.resolve();
    });
    expect(
      container?.querySelector("output")?.getAttribute("data-status"),
    ).toBe("ready");
    expect(container?.querySelector("output")?.getAttribute("data-src")).toBe(
      "blob:postwave-asset",
    );

    act(() => root?.unmount());
    root = null;
    expect(mocks.revokeObjectURL).toHaveBeenCalledWith("blob:postwave-asset");
  });

  it("uses error only for a terminal HTTP failure", async () => {
    mocks.fetch.mockResolvedValue({ ok: false });
    await act(async () => {
      root?.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      container?.querySelector("output")?.getAttribute("data-status"),
    ).toBe("error");
    expect(mocks.createObjectURL).not.toHaveBeenCalled();
  });
});
