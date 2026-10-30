import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  Text: "Text",
  View: "View",
}));

vi.mock("@/lib/fonts", () => ({
  FONT: {
    regular: "Inter_400Regular",
    semibold: "Inter_600SemiBold",
    bold: "Inter_700Bold",
  },
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({
    t: {
      warning: "#B45309",
      fgMuted: "#6B7280",
    },
  }),
}));

// eslint-disable-next-line import/first
import {
  CachedSessionNotice,
  cachedSessionNotice,
} from "./CachedSessionNotice";

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => (node.type as unknown) === "Text")
    .map((node) => node.children.join(""))
    .join(" ");
}

describe("cachedSessionNotice", () => {
  it("stays hidden while online services are available", () => {
    expect(
      cachedSessionNotice({
        gateEnabled: true,
        hasTenant: true,
        surface: "dashboard",
      }),
    ).toBeNull();
  });

  it("uses a workspace reconnect message when tenant scope is missing", () => {
    expect(
      cachedSessionNotice({
        gateEnabled: false,
        hasTenant: false,
        surface: "campaigns",
      }),
    ).toMatchObject({
      title: "Reconnect your workspace",
    });
  });

  it("uses screen-specific copy when a cached tenant is present", () => {
    expect(
      cachedSessionNotice({
        gateEnabled: false,
        hasTenant: true,
        surface: "subscribers",
      }),
    ).toMatchObject({
      title: "Reconnect to load subscribers",
      staleMessage: expect.stringContaining("last loaded results"),
    });
  });

  it("covers sequence and A/B result surfaces", () => {
    expect(
      cachedSessionNotice({
        gateEnabled: false,
        hasTenant: true,
        surface: "sequences",
      }),
    ).toMatchObject({
      title: "Reconnect to load sequences",
    });
    expect(
      cachedSessionNotice({
        gateEnabled: false,
        hasTenant: true,
        surface: "sequence",
      }),
    ).toMatchObject({
      staleMessage: expect.stringContaining("builder state"),
    });
    expect(
      cachedSessionNotice({
        gateEnabled: false,
        hasTenant: true,
        surface: "abResults",
      }),
    ).toMatchObject({
      title: "Reconnect to load A/B results",
    });
  });
});

describe("CachedSessionNotice render", () => {
  it("renders blocked cached-session copy with an alert label", () => {
    const notice = cachedSessionNotice({
      gateEnabled: false,
      hasTenant: true,
      surface: "campaigns",
    });
    expect(notice).not.toBeNull();

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    act(() => {
      renderer = TestRenderer.create(<CachedSessionNotice notice={notice!} />);
    });

    expect(renderedText(renderer!)).toContain("Reconnect to load campaigns");
    expect(renderedText(renderer!)).toContain(
      "Reconnect before loading campaigns.",
    );
    expect(
      renderer!.root.find((node) => (node.type as unknown) === "View").props
        .accessibilityRole,
    ).toBe("alert");
  });

  it("renders stale cached-session copy when cached rows are visible", () => {
    const notice = cachedSessionNotice({
      gateEnabled: false,
      hasTenant: true,
      surface: "dashboard",
    });
    expect(notice).not.toBeNull();

    let renderer: TestRenderer.ReactTestRenderer | null = null;
    act(() => {
      renderer = TestRenderer.create(
        <CachedSessionNotice notice={notice!} variant="stale" />,
      );
    });

    expect(renderedText(renderer!)).toContain("last loaded results");
    expect(renderedText(renderer!)).not.toContain("before loading");
  });
});
