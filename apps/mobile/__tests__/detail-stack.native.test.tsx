/**
 * The entity-detail push stack, RENDERED (LOVE-V#1).
 *
 * src/lib/detailStack.consistency.test.ts pins the FILE SHAPE — that each
 * family is a directory with a `_layout.tsx`. That is a text scan, and a text
 * scan cannot tell you whether the layout actually mounts a navigator or what
 * options it hands it. This does: it swaps `Stack` for a probe that records the
 * props it receives, then renders every family layout for real.
 *
 * What matters, and why:
 *
 *   headerShown: false  — every screen in this app renders its own
 *                         `<ScreenHeader>` inside its `SafeAreaView`, above the
 *                         scroll view. A native header on top of that is two
 *                         titles, two back affordances, and 100px of dead
 *                         chrome. This is the single option that has to be
 *                         right for the conversion to be invisible.
 *   gestureEnabled: true — the interactive edge-swipe back. It is the reason
 *                         the conversion was worth doing at all, and it does
 *                         NOT depend on the header being visible.
 *
 * `unstable_settings.initialRouteName` is asserted here too: Expo Router reads
 * it off the layout MODULE, so it is an export of these files rather than
 * anything rendered, and it is what puts the list underneath a cold-start
 * detail so Back pops instead of replacing.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render } from "@testing-library/react-native";
import React from "react";
import { View } from "react-native";

const stackProps: Record<string, unknown>[] = [];

jest.mock("expo-router", () => {
  const ReactLocal = require("react") as typeof React;
  const { View: RNView } = require("react-native") as { View: typeof View };
  return {
    Stack: (props: Record<string, unknown>) => {
      stackProps.push(props);
      return ReactLocal.createElement(RNView, { testID: "detail-stack" });
    },
  };
});

import ApprovalsLayout, {
  unstable_settings as approvalsSettings,
} from "../app/(tabs)/approvals/_layout";
import CampaignsLayout, {
  unstable_settings as campaignsSettings,
} from "../app/(tabs)/campaigns/_layout";
import ListsLayout, {
  unstable_settings as listsSettings,
} from "../app/(tabs)/lists/_layout";
import SegmentsLayout, {
  unstable_settings as segmentsSettings,
} from "../app/(tabs)/segments/_layout";
import SubscribersLayout, {
  unstable_settings as subscribersSettings,
} from "../app/(tabs)/subscribers/_layout";
import SuppressionsLayout, {
  unstable_settings as suppressionsSettings,
} from "../app/(tabs)/suppressions/_layout";

type LayoutCase = [
  family: string,
  Layout: () => React.JSX.Element,
  settings: { initialRouteName: string },
];

const LAYOUTS: LayoutCase[] = [
  ["campaigns", CampaignsLayout, campaignsSettings],
  ["subscribers", SubscribersLayout, subscribersSettings],
  ["approvals", ApprovalsLayout, approvalsSettings],
  ["lists", ListsLayout, listsSettings],
  ["segments", SegmentsLayout, segmentsSettings],
  ["suppressions", SuppressionsLayout, suppressionsSettings],
];

describe("entity detail stacks", () => {
  it.each(LAYOUTS)(
    "%s mounts a Stack with the header off and the pop gesture on",
    async (_name, Layout) => {
      stackProps.length = 0;
      const view = await render(React.createElement(Layout));

      expect(view.getByTestId("detail-stack")).toBeTruthy();
      expect(stackProps).toHaveLength(1);
      expect(stackProps[0]?.screenOptions).toEqual({
        headerShown: false,
        gestureEnabled: true,
      });
    },
  );

  it.each(LAYOUTS)("%s seeds its list under a cold-start detail", (
    _name,
    _Layout,
    settings,
  ) => {
    // Without this a deep link straight to /campaigns/{id} builds a stack of
    // ONE, `router.canGoBack()` is false, and `goBackOr()` has to replace with
    // a guessed route rather than pop to the list the user expects.
    expect(settings).toEqual({ initialRouteName: "index" });
  });

  it("hands React Navigation the SAME options object every render", async () => {
    // `screenOptions` is compared by identity; a fresh literal per render
    // reconfigures every screen in the stack on every render of the layout.
    stackProps.length = 0;
    const view = await render(React.createElement(CampaignsLayout));
    await view.rerender(React.createElement(CampaignsLayout));
    expect(stackProps).toHaveLength(2);
    expect(stackProps[0]?.screenOptions).toBe(stackProps[1]?.screenOptions);
  });
});
