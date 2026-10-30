/**
 * The seam that makes "generate, then score" one flow instead of two features
 * sharing a screen.
 *
 * Untested it fails silently and plausibly: the generator still renders its
 * variants, the scorer still scores, and the button between them does nothing
 * — which is indistinguishable from a person not having pressed it.
 *
 * The scorer's box is NOT a controlled field. It is seeded by a handoff and
 * then belongs to the person again, so what is pinned here is that identity —
 * not text — is what re-seeds it: pressing "Score these" twice on the same
 * variants has to refill a box that has since been emptied.
 */
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  Text: "Text",
  TextInput: "TextInput",
  View: "View",
}));

vi.mock("@/components/Card", () => ({
  Card: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ErrorState", () => ({ ErrorState: () => null }));
vi.mock("@/components/Pill", () => ({ Pill: () => null }));
// Not what this file is about, and its real import chain (useCampaigns →
// store/auth → expo-secure-store) cannot load in node vitest.
vi.mock("@/components/voice/SubjectLabBanditRow", () => ({
  SubjectLabBanditRow: () => null,
}));

// The mutation is not what this file is about; an idle one keeps the panel in
// its resting state so the box is the only thing moving.
vi.mock("@/hooks/useSubjectLab", () => ({
  useScoreSubjects: () => ({
    data: undefined,
    error: null,
    isPending: false,
    mutate: vi.fn(),
  }),
}));

vi.mock("@/lib/haptics", () => ({ haptics: { tap: vi.fn() } }));
vi.mock("@/lib/theme", () => ({
  useTheme: () => ({
    t: {
      accent: "#e60",
      accentFg: "#fff",
      bgSubtle: "#111",
      border: "#333",
      borderSubtle: "#222",
      danger: "#f33",
      fg: "#fff",
      fgMuted: "#aaa",
      fgSubtle: "#888",
      warning: "#fa0",
    },
  }),
}));
vi.mock("@/lib/fonts", () => ({
  FONT: { regular: "Inter", medium: "Inter", semibold: "Inter", bold: "Inter" },
}));

const { SubjectLabScorePanel } = await import("./SubjectLabScorePanel");

function isHost(node: TestRenderer.ReactTestInstance, name: string): boolean {
  return (node.type as unknown) === name;
}

function render(handoff?: { candidates: string }) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  const element = (
    <SubjectLabScorePanel offline={false} handoff={handoff} />
  );
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return {
    renderer: renderer!,
    rerender(next?: { candidates: string }) {
      act(() => {
        renderer!.update(
          <SubjectLabScorePanel offline={false} handoff={next} />,
        );
      });
    },
  };
}

function boxValue(renderer: TestRenderer.ReactTestRenderer): string {
  return String(
    renderer.root.find((node) => isHost(node, "TextInput")).props.value,
  );
}

function typeInBox(renderer: TestRenderer.ReactTestRenderer, next: string) {
  const box = renderer.root.find((node) => isHost(node, "TextInput"));
  act(() => {
    (box.props.onChangeText as (value: string) => void)(next);
  });
}

describe("candidates handed down from the generator", () => {
  it("starts empty when nothing has been handed over", () => {
    const { renderer } = render();
    expect(boxValue(renderer)).toBe("");
  });

  it("fills the box with what was handed over", () => {
    const { renderer } = render({ candidates: "Seed\nVariant A" });
    expect(boxValue(renderer)).toBe("Seed\nVariant A");
  });

  it("leaves the box the person's own after the handoff lands", () => {
    // A controlled field would fight every keystroke. The handoff seeds it and
    // then lets go.
    const { renderer } = render({ candidates: "Seed\nVariant A" });
    typeInBox(renderer, "Something I typed instead");
    expect(boxValue(renderer)).toBe("Something I typed instead");
  });

  it("re-seeds on a second handoff of the SAME text", () => {
    // The one behaviour a text-equality guard would break: press "Score
    // these", clear the box, press it again — and nothing comes back.
    const handoff = { candidates: "Seed\nVariant A" };
    const { renderer, rerender } = render(handoff);
    typeInBox(renderer, "");
    expect(boxValue(renderer)).toBe("");
    rerender({ candidates: "Seed\nVariant A" });
    expect(boxValue(renderer)).toBe("Seed\nVariant A");
  });

  it("does not re-seed on an unrelated re-render", () => {
    // Same handoff object, new render — a parent re-rendering for any other
    // reason must not wipe what the person is typing.
    const handoff = { candidates: "Seed\nVariant A" };
    const { renderer, rerender } = render(handoff);
    typeInBox(renderer, "My own edit");
    rerender(handoff);
    expect(boxValue(renderer)).toBe("My own edit");
  });
});
