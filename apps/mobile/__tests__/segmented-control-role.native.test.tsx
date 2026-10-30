/**
 * The segmented control's accessibility ROLE, pinned per platform.
 *
 * THE DEFECT THIS FILE EXISTS FOR. Every option declared
 * `accessibilityRole="tab"`. React Native's own iOS trait table maps that word
 * to nothing —
 *
 *     React/Views/RCTViewManager.m:  @"tab" : @(UIAccessibilityTraitNone)
 *
 * — so on iOS the chips carried no button trait at all and VoiceOver never
 * announced them as actionable. Driving the real app confirmed it: the
 * dashboard's 7d/30d/90d row reported three elements of type GenericElement
 * with traits ["None"]. `tab` is meaningful on Android (TalkBack reads
 * "tab, 2 of 3"), so the role is chosen per platform rather than replaced.
 *
 * WHAT MUST NOT REGRESS ALONGSIDE IT: `accessibilityState={{ selected }}` DOES
 * map to `UIAccessibilityTraitSelected` on iOS, so selection was already
 * announced correctly and the fix must not disturb it. Both halves are
 * asserted here, on both platforms, because a role that carries the trait but
 * loses the selection would be a different regression with the same shape.
 *
 * Queries go through the render result rather than the module-level `screen`,
 * because two of these cases mount the control more than once.
 *
 * The option's accessible NAME is pinned here too (see "badge counts are
 * spoken" below): a role announced correctly is no use if the name it
 * announces drops the number the chip shows.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { Platform } from "react-native";

import {
  SegmentedControl,
  type SegmentedOption,
} from "@/components/SegmentedControl";

const RANGES = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
] as const;

type Range = (typeof RANGES)[number]["value"];

const realOS = Platform.OS;

function runningOn(os: "ios" | "android") {
  Object.defineProperty(Platform, "OS", { configurable: true, value: os });
}

afterEach(() => {
  Object.defineProperty(Platform, "OS", { configurable: true, value: realOS });
});

async function renderRanges(onChange: (next: Range) => void = () => undefined) {
  return render(
    <SegmentedControl
      accessibilityLabel="Reporting window"
      options={RANGES}
      value="30d"
      onChange={onChange}
    />,
  );
}

describe("SegmentedControl option role", () => {
  it("uses a role iOS actually maps to a trait, never the inert `tab`", async () => {
    runningOn("ios");
    const view = await renderRanges();

    // The whole finding in one assertion: on iOS not a single option may
    // carry the role whose iOS trait is None.
    expect(view.queryAllByRole("tab")).toHaveLength(0);
    expect(view.getAllByRole("button")).toHaveLength(3);
    for (const option of RANGES) {
      expect(view.getByRole("button", { name: option.label })).toBeTruthy();
    }
  });

  it("keeps `tab` on Android, where the role is real", async () => {
    runningOn("android");
    const view = await renderRanges();

    expect(view.getAllByRole("tab")).toHaveLength(3);
    expect(view.queryAllByRole("button")).toHaveLength(0);
  });

  // One mount per case, rather than a loop over both platforms in a single
  // test: React Testing Library's auto-cleanup registry does not survive two
  // mounts and an explicit unmount inside one `it`, and the next test in the
  // file then queries a stale tree.
  it("still announces which option is selected on iOS", async () => {
    runningOn("ios");
    const view = await renderRanges();

    expect(
      view.getByRole("button", { name: "30d" }).props.accessibilityState,
    ).toEqual({ selected: true });
    expect(
      view.getByRole("button", { name: "7d" }).props.accessibilityState,
    ).toEqual({ selected: false });
  });

  it("still announces which option is selected on Android", async () => {
    runningOn("android");
    const view = await renderRanges();

    expect(
      view.getByRole("tab", { name: "30d" }).props.accessibilityState,
    ).toEqual({ selected: true });
    expect(
      view.getByRole("tab", { name: "7d" }).props.accessibilityState,
    ).toEqual({ selected: false });
  });

  it("remains pressable under the role it now declares", async () => {
    runningOn("ios");
    const onChange = jest.fn();
    const view = await renderRanges(onChange as (next: Range) => void);

    await fireEvent.press(view.getByRole("button", { name: "90d" }));
    expect(onChange).toHaveBeenCalledWith("90d");
  });
});

/**
 * BADGE COUNTS ARE SPOKEN.
 *
 * THE DEFECT (A11Y-6). An accessibilityLabel on a Pressable REPLACES its
 * children for assistive tech, and the control defaulted every option's label
 * to the bare `option.label`. A chip that visibly reads "Failing 3" was
 * therefore announced as "Failing": the count, often the whole reason the
 * filter exists, only reached sighted users. Fourteen call sites pass a
 * numeric `badge` with no label of their own, so the repair is the control's
 * default rather than fourteen caller edits.
 *
 * Pinned on both platforms, through the role each platform really declares:
 *  - a badged option is named "<label>, <count>", including a count of 0,
 *    because the chip shows that 0;
 *  - a caller's own `accessibilityLabel` still wins outright, since only the
 *    caller knows what the number counts;
 *  - an option with no badge keeps its bare label, with no trailing ", ".
 */
type Facet = "all" | "failing" | "paused";

const OPTION_ROLE = { ios: "button", android: "tab" } as const;

async function renderFacets(options: readonly SegmentedOption<Facet>[]) {
  return render(
    <SegmentedControl
      accessibilityLabel="Sync health"
      options={options}
      value="all"
      onChange={() => undefined}
    />,
  );
}

describe("SegmentedControl badge counts are spoken", () => {
  for (const os of ["ios", "android"] as const) {
    const role = OPTION_ROLE[os];

    it(`names a badged option by its label and its count on ${os}`, async () => {
      runningOn(os);
      const view = await renderFacets([
        { value: "all", label: "All" },
        { value: "failing", label: "Failing", badge: 3 },
      ]);

      const failing = view.getByRole(role, { name: "Failing, 3" });
      expect(failing.props.accessibilityLabel).toBe("Failing, 3");
      // The count joins the name without costing the selection state.
      expect(failing.props.accessibilityState).toEqual({ selected: false });
      // The bare label is exactly what a screen reader used to hear.
      expect(view.queryByLabelText("Failing")).toBeNull();
      // Nothing changes for sighted users: label and numeral still render.
      expect(view.getByText("Failing")).toBeTruthy();
      expect(view.getByText("3")).toBeTruthy();
    });

    it(`speaks a zero count, because the chip shows one, on ${os}`, async () => {
      runningOn(os);
      const view = await renderFacets([
        { value: "all", label: "All" },
        { value: "paused", label: "Paused", badge: 0 },
      ]);

      expect(view.getByText("0")).toBeTruthy();
      expect(view.getByRole(role, { name: "Paused, 0" })).toBeTruthy();
      expect(view.queryByLabelText("Paused")).toBeNull();
    });

    it(`lets a caller's own label say what the count counts on ${os}`, async () => {
      runningOn(os);
      const view = await renderFacets([
        { value: "all", label: "All" },
        {
          value: "failing",
          label: "Failing",
          badge: 3,
          accessibilityLabel: "Failing syncs, 3 syncs",
        },
      ]);

      expect(
        view.getByRole(role, { name: "Failing syncs, 3 syncs" }).props
          .accessibilityLabel,
      ).toBe("Failing syncs, 3 syncs");
      expect(view.queryByLabelText("Failing, 3")).toBeNull();
      expect(view.queryByLabelText("Failing")).toBeNull();
    });

    it(`keeps the bare label on an option with no badge on ${os}`, async () => {
      runningOn(os);
      const view = await renderFacets([
        { value: "all", label: "All" },
        { value: "failing", label: "Failing", badge: 3 },
      ]);

      expect(
        view.getByRole(role, { name: "All" }).props.accessibilityLabel,
      ).toBe("All");
      expect(view.queryByLabelText(/^All,/)).toBeNull();
    });
  }
});
