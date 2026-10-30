import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { router } from "expo-router";

/**
 * LOVE#32 — long press is the phone's right-click, and every list row in this
 * app was spending it on exactly one verb: `Share.share()`.
 *
 * `RowActionSheet` is the general answer; the tag catalogue is the first
 * adopter, chosen because it is the clearest instance of the finding —
 * long-pressing a tag almost always means "get me the exact string so I can
 * paste it into a segment rule", and Share was the only thing on offer.
 *
 * Pinned here:
 *   - the sheet does not exist until a row is long-pressed;
 *   - it offers MORE THAN ONE verb, with the likely one first;
 *   - Cancel is a real focusable control, not just a backdrop (a backdrop is
 *     invisible to VoiceOver);
 *   - a disabled item explains itself instead of dimming in silence;
 *   - choosing an item DISMISSES before acting, so a navigating action does
 *     not leave the sheet mounted over its destination.
 */
const mockCopy = jest.fn(async (_value: string) => true);
jest.mock("@/lib/clipboard", () => ({
  copyToClipboard: (value: string) => mockCopy(value),
}));

const mockTags: {
  data: unknown;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  error: unknown;
  dataUpdatedAt: number;
  refetch: () => Promise<unknown>;
} = {
  data: undefined,
  isLoading: false,
  isError: false,
  isRefetching: false,
  error: null,
  dataUpdatedAt: 0,
  refetch: jest.fn(async () => undefined),
};

jest.mock("@/hooks/useTagCatalogue", () => ({
  useTagCatalogue: () => mockTags,
  useTagGroups: () => ({ data: [], isLoading: false, isError: false }),
}));

// eslint-disable-next-line import/first
import { RowActionSheet } from "@/components/RowActionSheet";
// eslint-disable-next-line import/first
import Tags from "../app/(tabs)/tags";

function wrap(node: React.ReactElement) {
  return render(node, {
    wrapper: ({ children }) => (
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        {children}
      </SafeAreaProvider>
    ),
  });
}

describe("RowActionSheet", () => {
  it("offers Cancel as a real control, not only a backdrop tap", async () => {
    const screen = await wrap(
      <RowActionSheet
        visible
        title="VIP"
        actions={[{ key: "a", label: "Do a thing", onPress: jest.fn() }]}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByLabelText("Cancel")).toBeTruthy();
  });

  it("dismisses BEFORE running the action", async () => {
    const order: string[] = [];
    const onClose = jest.fn(() => order.push("close"));
    const onPress = jest.fn(() => order.push("press"));
    const screen = await wrap(
      <RowActionSheet
        visible
        title="VIP"
        actions={[{ key: "a", label: "Go somewhere", onPress }]}
        onClose={onClose}
      />,
    );
    await fireEvent.press(screen.getByLabelText("Go somewhere"));
    expect(order).toEqual(["close", "press"]);
  });

  it("explains a disabled item rather than dimming it in silence", async () => {
    const onPress = jest.fn();
    const screen = await wrap(
      <RowActionSheet
        visible
        title="VIP"
        actions={[
          {
            key: "a",
            label: "Delete tag",
            destructive: true,
            disabled: true,
            disabledReason: "Deleting tags is a desk action.",
            onPress,
          },
        ]}
        onClose={jest.fn()}
      />,
    );
    const item = screen.getByLabelText("Delete tag");
    expect(item.props.accessibilityState?.disabled).toBe(true);
    expect(item.props.accessibilityHint).toBe("Deleting tags is a desk action.");
    await fireEvent.press(item);
    expect(onPress).not.toHaveBeenCalled();
  });
});
describe("tag catalogue — long press opens a MENU, not a share sheet", () => {
  function reset() {
    mockTags.data = {
      rows: [{ id: "t1", name: "VIP", description: "Top accounts" }],
      fromSnapshot: false,
      capturedAt: null,
    };
    mockTags.isLoading = false;
    mockTags.isError = false;
    mockCopy.mockClear();
    (router.push as unknown as { mockClear?: () => void }).mockClear?.();
  }

  it("shows nothing until the chip is long-pressed", async () => {
    reset();
    const screen = await wrap(<Tags />);
    expect(screen.queryByLabelText("Copy tag name")).toBeNull();
  });

  it("offers three verbs, with the useful one first", async () => {
    reset();
    const screen = await wrap(<Tags />);
    const chip = screen
      .getAllByRole("button")
      .find((node) => String(node.props.accessibilityLabel).includes("VIP"));
    expect(chip).toBeTruthy();
    await fireEvent(chip!, "longPress");
    expect(screen.getByLabelText("See who's tagged")).toBeTruthy();
    expect(screen.getByLabelText("Copy tag name")).toBeTruthy();
    expect(screen.getByLabelText("Share tag name")).toBeTruthy();
  });

  it("copies the EXACT name, which is why the menu exists", async () => {
    reset();
    const screen = await wrap(<Tags />);
    const chip = screen
      .getAllByRole("button")
      .find((node) => String(node.props.accessibilityLabel).includes("VIP"));
    await fireEvent(chip!, "longPress");
    await fireEvent.press(screen.getByLabelText("Copy tag name"));
    expect(mockCopy).toHaveBeenCalledWith("VIP");
  });
});

/**
 * NATIVE — the menu's verbs, reachable WITHOUT the gesture.
 *
 * A long press cannot be performed with VoiceOver at all, so a menu that only
 * a long press opens is a set of verbs that exists for sighted users only.
 * That is the exact regression `SwipeableRow`'s header refuses to ship ("swipe
 * actions make the app *less* accessible than it was, because functionality
 * moves from a visible button into an unreachable gesture"), and `MoreRows`
 * already answers it by publishing its long press as an `accessibilityAction`
 * as well.
 *
 * `tagSpokenLabel` made it worse than an omission: it narrated "Long press to
 * copy", advertising a path this listener does not have.
 */
describe("tag chip — the menu's verbs are rotor actions too", () => {
  function reset() {
    mockTags.data = {
      rows: [{ id: "t1", name: "VIP", description: "Top accounts" }],
      fromSnapshot: false,
      capturedAt: null,
    };
    mockTags.isLoading = false;
    mockTags.isError = false;
    mockCopy.mockClear();
    (router.push as unknown as { mockClear?: () => void }).mockClear?.();
  }

  type View = Awaited<ReturnType<typeof wrap>>;

  async function chipOf(view: View) {
    const chip = view
      .getAllByRole("button")
      .find((node: { props: { accessibilityLabel?: unknown } }) =>
        String(node.props.accessibilityLabel).includes("VIP"),
      );
    expect(chip).toBeTruthy();
    return chip!;
  }

  it("publishes the SAME three verbs the sheet offers", async () => {
    reset();
    const screen = await wrap(<Tags />);
    const chip = await chipOf(screen);
    const published = (
      chip.props.accessibilityActions as { name: string; label: string }[]
    ).map((a) => a.label);
    // Drift guard: the rotor list is a module constant and the sheet builds
    // per-row closures, so nothing but this ties the two together.
    await fireEvent(chip, "longPress");
    for (const label of published) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    expect(published).toEqual([
      "See who's tagged",
      "Copy tag name",
      "Share tag name",
      // Viewer-scoped maintenance read (GET /tags/{id}/history): in the
      // rotor for everyone, unlike the editor-floored Edit verb.
      "Membership history",
    ]);
  });

  it("copies from the rotor with no long press at all", async () => {
    reset();
    const screen = await wrap(<Tags />);
    const chip = await chipOf(screen);
    await fireEvent(chip, "accessibilityAction", {
      nativeEvent: { actionName: "copy" },
    });
    expect(mockCopy).toHaveBeenCalledWith("VIP");
    // …and it did NOT have to open the sheet to do it.
    expect(screen.queryByLabelText("Cancel")).toBeNull();
  });

  it("routes to the tagged subscribers from the rotor", async () => {
    reset();
    const screen = await wrap(<Tags />);
    await fireEvent(await chipOf(screen), "accessibilityAction", {
      nativeEvent: { actionName: "subscribers" },
    });
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/(tabs)/subscribers",
      params: { q: "VIP" },
    });
  });

  it("ignores an action name it does not publish", async () => {
    reset();
    const screen = await wrap(<Tags />);
    await fireEvent(await chipOf(screen), "accessibilityAction", {
      nativeEvent: { actionName: "delete" },
    });
    expect(mockCopy).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("stops promising a gesture VoiceOver cannot make", async () => {
    reset();
    const screen = await wrap(<Tags />);
    const chip = await chipOf(screen);
    expect(String(chip.props.accessibilityLabel)).not.toContain("Long press");
  });
});
