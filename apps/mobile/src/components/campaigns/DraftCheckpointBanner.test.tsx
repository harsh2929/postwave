/**
 * The visible half of ECO-03 on a phone.
 *
 * What is pinned here is the part a redesign could quietly break: the banner
 * NEVER resolves anything on the person's behalf. It offers a draft rather
 * than applying it, it names both sides of a conflict rather than picking one,
 * and when the server could not hand back the other draft it offers no choice
 * at all — because both choices need the version we do not have.
 */
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({
    t: {
      bg: "#000",
      bgSubtle: "#111",
      fg: "#fff",
      fgMuted: "#aaa",
      fgSubtle: "#888",
      border: "#333",
      borderSubtle: "#222",
      accent: "#e60",
      accentFg: "#fff",
      danger: "#f33",
      warning: "#fa0",
      info: "#3af",
    },
  }),
}));

vi.mock("@/lib/fonts", () => ({
  FONT: { regular: "Inter", semibold: "Inter", bold: "Inter" },
}));

const { DraftCheckpointBanner } = await import("./DraftCheckpointBanner");

/**
 * react-native is mocked to host strings, so a node's `type` really is
 * "Pressable"/"Text" at runtime — but its declared type is ElementType, which
 * TypeScript will not compare to a string literal. Narrowed once here rather
 * than casting at every call site.
 */
function isHost(node: TestRenderer.ReactTestInstance, name: string): boolean {
  return (node.type as unknown) === name;
}

interface Draft {
  subject: string;
}

function stateWith(
  over: Partial<Parameters<typeof DraftCheckpointBanner<Draft>>[0]["state"]>,
) {
  return {
    offer: null,
    conflict: null,
    refusal: null,
    saving: false,
    lastSavedAt: null,
    resume: vi.fn(),
    dismiss: vi.fn(),
    keepMine: vi.fn(),
    useTheirs: vi.fn(),
    flush: vi.fn(async () => undefined),
    ...over,
  };
}

function checkpoint(subject: string) {
  return {
    entity_key: "campaign",
    entity_id: "cmp_1",
    content: { subject },
    version: 3,
    updated_at: new Date(Date.now() - 5 * 60_000).toISOString(),
  };
}

function render(node: React.ReactElement) {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(node);
  });
  return renderer!;
}

/** Every accessibilityLabel on a rendered button. */
function buttonLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => isHost(node, "Pressable"), { deep: true })
    .map((node) => String(node.props.accessibilityLabel));
}

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll((node) => isHost(node, "Text"), { deep: true })
    .map((node) => node.children.filter((c) => typeof c === "string").join(""))
    .join(" ");
}

describe("DraftCheckpointBanner", () => {
  it("renders nothing when there is nothing to say", () => {
    const renderer = render(
      <DraftCheckpointBanner state={stateWith({})} canEdit />,
    );
    expect(renderer.toJSON()).toBeNull();
  });

  it("offers a draft rather than applying it", () => {
    const resume = vi.fn();
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({ offer: checkpoint("from the laptop"), resume })}
        canEdit
      />,
    );
    expect(textContent(renderer)).toContain("unsaved draft from another device");
    expect(buttonLabels(renderer)).toEqual([
      "Resume this draft",
      "Discard it and keep the saved version",
    ]);
    expect(resume).not.toHaveBeenCalled();
  });

  it("explains a draft it cannot resume instead of hiding it", () => {
    // A sent campaign. The draft is real and the person should be told where
    // it is, not left wondering why nothing happened.
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({ offer: checkpoint("from the laptop") })}
        canEdit={false}
      />,
    );
    expect(textContent(renderer)).toContain("can no longer be edited");
    expect(buttonLabels(renderer)).toEqual([]);
  });

  it("names both drafts in a conflict and chooses neither", () => {
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({ conflict: { current: checkpoint("theirs") } })}
        canEdit
      />,
    );
    expect(textContent(renderer)).toContain("Nothing has been overwritten");
    expect(buttonLabels(renderer)).toEqual([
      "Use the newer draft",
      "Keep what's on this phone",
    ]);
  });

  it("offers no resolution when the other draft could not be read", () => {
    // Both resolutions need the other version. Offering one anyway would let
    // someone overwrite work they were never shown.
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({ conflict: { current: null } })}
        canEdit
      />,
    );
    expect(textContent(renderer)).toContain("nothing has been overwritten");
    expect(buttonLabels(renderer)).toEqual([]);
  });

  it("says plainly when the draft is not being kept", () => {
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({ refusal: "a draft checkpoint is limited to 256 KiB" })}
        canEdit
      />,
    );
    const text = textContent(renderer);
    expect(text).toContain("isn't being kept");
    expect(text).toContain("256 KiB");
    expect(text).toContain("won't survive closing it");
  });

  it("says autosave is working while it is working", () => {
    // The healthy state. Without it the whole feature is invisible and a
    // person locking their phone mid-sentence has no reason to believe the
    // work is anywhere but on this screen.
    const renderer = render(
      <DraftCheckpointBanner state={stateWith({ saving: true })} canEdit />,
    );
    expect(textContent(renderer)).toContain("Keeping a draft");
  });

  it("names when the draft was last kept", () => {
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({ lastSavedAt: new Date().toISOString() })}
        canEdit
      />,
    );
    expect(textContent(renderer)).toContain("Draft kept");
  });

  it("does not promise a kept draft while the server is refusing it", () => {
    // Both facts can be set at once — an earlier draft was kept, this one is
    // not. Printing the reassurance under the refusal is the exact confusion
    // the refusal state exists to prevent.
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({
          refusal: "a draft checkpoint is limited to 256 KiB",
          lastSavedAt: new Date().toISOString(),
        })}
        canEdit
      />,
    );
    expect(textContent(renderer)).not.toContain("Draft kept");
  });

  it("does not promise a kept draft while a conflict is unresolved", () => {
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({
          conflict: { current: checkpoint("theirs") },
          lastSavedAt: new Date().toISOString(),
        })}
        canEdit
      />,
    );
    expect(textContent(renderer)).not.toContain("Draft kept");
  });

  it("never hands Pressable a function-style style", () => {
    // NativeWind v4 silently DROPS layout for `style={({pressed}) => …}`, and
    // that has broken whole screens in this app before. The banner's buttons
    // come from ActionButton; this asserts the property rather than trusting
    // the import.
    const renderer = render(
      <DraftCheckpointBanner
        state={stateWith({ offer: checkpoint("from the laptop") })}
        canEdit
      />,
    );
    const styles = renderer.root
      .findAll((node) => isHost(node, "Pressable"), { deep: true })
      .map((node) => node.props.style);
    expect(styles).not.toHaveLength(0);
    for (const style of styles) expect(typeof style).not.toBe("function");
  });
});
