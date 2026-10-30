/**
 * SubscriberRow's FOUR gestures, and the fact that one of them means two
 * different things.
 *
 * The row carries a twenty-line comment describing this contract precisely
 * because it is subtle, and nothing had ever pressed it. Four controls, zero
 * presses: tap-to-open, long-press-to-enter-selection, tap-to-TOGGLE while
 * selecting, and swipe-to-Suppress.
 *
 * The mode-dependence is the part a regression breaks silently. A tap on the
 * same pixel navigates away from the list before a long press and mutates the
 * selection after one; drop the `if (selecting)` branch and the row still
 * renders, still reads correctly in a screenshot, and quietly navigates out of
 * a half-built multi-select. So the harness holds REAL selection state — the
 * `useSubscriberSelection` hook the list screen uses, wired the way
 * `useSubscribersActions.renderRow` wires it — and the tests drive the row from
 * one mode into the other by gesture rather than by prop.
 *
 * Suppress runs the real `useSubscriberRowSuppress`, so the assertion is the
 * id it sends and the receipt it raises, not that a supplied `jest.fn()` fired.
 *
 * WHY ReanimatedSwipeable IS STUBBED (same reason as approval-row-swipe): the
 * real component renders no action panel until a gesture opens one, which RNTL
 * cannot produce, and `SwipeableRow.run()` calls a Reanimated worklet that
 * throws off the UI thread. The stub captures the props SwipeableRow hands it
 * and leaves the panel contents, the rotor publication and the handler mapping
 * real.
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const swipeableProps: Record<string, unknown>[] = [];
/** Every `href` the row handed to expo-router's Link, in render order. */
const linkHrefs: unknown[] = [];

jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => {
  const ReactModule = require("react") as typeof import("react");
  return {
    __esModule: true,
    default: ({
      children,
      ...props
    }: {
      children: React.ReactNode;
    } & Record<string, unknown>) => {
      swipeableProps.push(props);
      return ReactModule.createElement(
        require("react-native").View,
        null,
        children,
      );
    },
  };
});

// The shared expo-router stub renders Link's children and DISCARDS the href,
// so "tap to open" had no observable destination. Keep every other export of
// that stub (the route suites depend on `router`, `useLocalSearchParams`, …)
// and record the href.
jest.mock("expo-router", () => {
  const actual = jest.requireActual("expo-router") as Record<string, unknown>;
  const ReactModule = require("react") as typeof import("react");
  return {
    ...actual,
    __esModule: true,
    Link: ({
      href,
      children,
    }: {
      href: unknown;
      children: React.ReactNode;
    }) => {
      linkHrefs.push(href);
      return ReactModule.createElement(
        require("react-native").View,
        null,
        children,
      );
    },
  };
});

// eslint-disable-next-line import/first -- must follow the stubs above.
import { ConfirmProvider } from "@/components/ConfirmSheet";
// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";
// eslint-disable-next-line import/first
import {
  SubscriberRow,
  type SubscriberListRow,
} from "@/components/subscriber/SubscriberRow";
// eslint-disable-next-line import/first
import { useSubscriberRowSuppress } from "@/hooks/useSubscriberRowSuppress";
// eslint-disable-next-line import/first
import { useSubscriberSelection } from "@/hooks/useSubscriberSelection";

const subscriberHooks = require("./mocks/queryHooks.cjs");

const ALICE: SubscriberListRow = {
  id: "sub-1",
  email: "alice@example.com",
  status: "enabled",
  first_name: "Alice",
};
const BOB: SubscriberListRow = {
  id: "sub-2",
  email: "bob@example.com",
  status: "enabled",
};
/** The server sent no id, so the bulk endpoints cannot take this row. */
const GHOST: SubscriberListRow = {
  email: "ghost@example.com",
  status: "enabled",
};

/** What VoiceOver says for each row, spelled out rather than recomputed. */
const ALICE_SPOKEN = "Alice, alice@example.com, Subscribed";
const BOB_SPOKEN = "bob@example.com, Subscribed";
const GHOST_SPOKEN = "ghost@example.com, Subscribed";

/**
 * The list screen's row, with the screen's REAL selection state behind it.
 * Mirrors `useSubscribersActions.renderRow`: the swipe action is withheld
 * while selecting, and the two selection callbacks are the hook's own.
 */
function Harness({
  items,
  gated = false,
  keepSuppressWhileSelecting = false,
}: {
  items: readonly SubscriberListRow[];
  gated?: boolean;
  /**
   * Keep handing the row `onSuppress` after selection starts — which the list
   * screen never does. It exists to press the ROW's own withdrawal rule
   * rather than the screen's: two independent guards, and only one of them
   * is in this file's subject.
   */
  keepSuppressWhileSelecting?: boolean;
}) {
  const selection = useSubscriberSelection({
    loadedIds: items.flatMap((i) => (i.id ? [i.id] : [])),
    hasAdminRole: true,
    online: true,
    gated: false,
  });
  const onSuppress = useSubscriberRowSuppress(!gated);
  return (
    <>
      {items.map((item) => (
        <SubscriberRow
          key={item.email}
          item={item}
          selecting={selection.active}
          selected={Boolean(item.id) && selection.ids.includes(item.id ?? "")}
          onToggleSelect={selection.toggle}
          onBeginSelect={selection.begin}
          {...(gated || (selection.active && !keepSuppressWhileSelecting)
            ? {}
            : { onSuppress })}
        />
      ))}
    </>
  );
}

async function mount(
  items: readonly SubscriberListRow[],
  options: { gated?: boolean; keepSuppressWhileSelecting?: boolean } = {},
) {
  swipeableProps.length = 0;
  linkHrefs.length = 0;
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ConfirmProvider>
        <ToastProvider>
          <Harness
            items={items}
            gated={options.gated ?? false}
            keepSuppressWhileSelecting={
              options.keepSuppressWhileSelecting ?? false
            }
          />
        </ToastProvider>
      </ConfirmProvider>
    </SafeAreaProvider>,
  );
}

type HostLike = { props: Record<string, unknown> };

/**
 * Host nodes publishing swipe verbs to the VoiceOver rotor.
 *
 * Takes the ROOT rather than reading `screen`: `panelLabels` renders a second
 * tree, and RNTL's `screen` then points at that one.
 */
function rotorHosts(root: unknown = screen.root): HostLike[] {
  return (
    root as {
      queryAll: (p: (el: HostLike) => boolean) => HostLike[];
    }
  ).queryAll((el) => Array.isArray(el.props?.accessibilityActions));
}

function rotorNames(root?: unknown): string[] {
  return rotorHosts(root ?? screen.root).flatMap((node) =>
    (node.props.accessibilityActions as { name: string }[]).map((a) => a.name),
  );
}

/** The labels a captured panel renderer would draw. */
async function panelLabels(renderer: unknown): Promise<string[]> {
  if (typeof renderer !== "function") return [];
  const view = await render(
    (renderer as () => React.ReactElement)() as React.ReactElement,
  );
  return (
    view.root as unknown as {
      queryAll: (p: (el: HostLike) => boolean) => HostLike[];
    }
  )
    .queryAll((el) => typeof el.props?.accessibilityLabel === "string")
    .map((el) => el.props.accessibilityLabel as string);
}

/** A mutation whose Nth `mutate` call takes a scripted outcome. */
function scriptedMutation(script: readonly ("success" | "error")[]) {
  let call = 0;
  const mutate = jest.fn(
    (
      _vars: unknown,
      options?: {
        onSuccess?: (d: unknown) => void;
        onError?: (e: unknown) => void;
      },
    ) => {
      const outcome = script[call] ?? "success";
      call += 1;
      if (outcome === "error") options?.onError?.(new Error("gateway 500"));
      else options?.onSuccess?.(undefined);
    },
  );
  return {
    isPending: false,
    data: undefined,
    error: null,
    reset: jest.fn(),
    variables: undefined,
    mutateAsync: jest.fn(async () => ({})),
    mutate,
  };
}

beforeEach(() => {
  subscriberHooks.__resetHookResultsForTests();
});

describe("a tap OPENS the profile — while the list is not selecting", () => {
  it("routes to the subscriber's own detail path, by id", async () => {
    await mount([ALICE]);
    // The destination IS the consequence of the tap; the shared router stub
    // used to throw it away.
    expect(linkHrefs.at(-1)).toEqual({
      pathname: "/(tabs)/subscribers/[id]",
      params: { id: "sub-1" },
    });
    const row = screen.getByLabelText(`Open ${ALICE_SPOKEN}`);
    expect(row.props.accessibilityRole).toBe("button");
  });

  it("falls back to the ADDRESS when the server sent no id", async () => {
    await mount([GHOST]);
    expect(linkHrefs.at(-1)).toEqual({
      pathname: "/(tabs)/subscribers/[id]",
      params: { id: "ghost@example.com" },
    });
  });

  it("does not toggle anything — no row becomes a checkbox", async () => {
    await mount([ALICE, BOB]);
    await fireEvent.press(screen.getByLabelText(`Open ${ALICE_SPOKEN}`));
    // Same pixel, different mode: outside selection a tap must not select.
    expect(screen.queryByLabelText(ALICE_SPOKEN)).not.toBeNull(); // swipe wrapper
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByLabelText(`Open ${BOB_SPOKEN}`)).toBeTruthy();
  });
});

describe("a LONG press enters selection mode", () => {
  it("advertises itself, then flips the whole list into checkboxes", async () => {
    await mount([ALICE, BOB]);
    const row = screen.getByLabelText(`Open ${ALICE_SPOKEN}`);
    expect(row.props.accessibilityHint).toBe(
      "Long press to start selecting subscribers",
    );

    await fireEvent(row, "longPress");

    // The real selection hook ran: the pressed row is selected, its sibling
    // is offered but not, and NEITHER is a navigation target any more.
    const alice = screen.getByLabelText(ALICE_SPOKEN);
    expect(alice.props.accessibilityRole).toBe("checkbox");
    expect(alice.props.accessibilityState).toMatchObject({
      checked: true,
      disabled: false,
    });
    const bob = screen.getByLabelText(BOB_SPOKEN);
    expect(bob.props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.queryByLabelText(`Open ${ALICE_SPOKEN}`)).toBeNull();
    expect(screen.queryByLabelText(`Open ${BOB_SPOKEN}`)).toBeNull();
  });

  it("leaves the long press UNBOUND on a row that cannot be selected", async () => {
    await mount([GHOST]);
    const row = screen.getByLabelText(`Open ${GHOST_SPOKEN}`);
    // No id → no bulk endpoint can take it → no hint promising selection and
    // no handler to run.
    expect(row.props.accessibilityHint).toBeUndefined();
    expect(row.props.onLongPress).toBeUndefined();
    await fireEvent(row, "longPress");
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});

describe("the SAME tap toggles once the list is selecting", () => {
  it("adds and removes rows instead of navigating", async () => {
    await mount([ALICE, BOB]);
    await fireEvent(screen.getByLabelText(`Open ${ALICE_SPOKEN}`), "longPress");

    await fireEvent.press(screen.getByLabelText(BOB_SPOKEN));
    expect(
      screen.getByLabelText(BOB_SPOKEN).props.accessibilityState,
    ).toMatchObject({ checked: true });

    // …and a second tap takes it back out, which is the half that proves the
    // tap is a toggle rather than a one-way "select".
    await fireEvent.press(screen.getByLabelText(BOB_SPOKEN));
    expect(
      screen.getByLabelText(BOB_SPOKEN).props.accessibilityState,
    ).toMatchObject({ checked: false });
    // Alice, selected by the long press, is untouched by Bob's taps.
    expect(
      screen.getByLabelText(ALICE_SPOKEN).props.accessibilityState,
    ).toMatchObject({ checked: true });
  });

  it("refuses the tap on an id-less row, and says why", async () => {
    await mount([ALICE, GHOST]);
    await fireEvent(screen.getByLabelText(`Open ${ALICE_SPOKEN}`), "longPress");

    const ghost = screen.getByLabelText(GHOST_SPOKEN);
    expect(ghost.props.accessibilityState).toMatchObject({
      checked: false,
      disabled: true,
    });
    expect(ghost.props.accessibilityHint).toBe(
      "This row can't be selected — the server sent it without an id",
    );
    await fireEvent.press(ghost);
    expect(
      screen.getByLabelText(GHOST_SPOKEN).props.accessibilityState,
    ).toMatchObject({ checked: false });
  });
});

describe("swipe-to-Suppress", () => {
  it("draws one danger action and publishes it to the rotor", async () => {
    const view = await mount([ALICE]);
    await expect(
      panelLabels(swipeableProps.at(-1)?.renderRightActions),
    ).resolves.toEqual(["Suppress"]);
    expect(rotorNames(view.root)).toEqual(["Suppress"]);
    // Right edge only: there is no constructive verb to confuse it with.
    expect(swipeableProps.at(-1)?.renderLeftActions).toBeUndefined();
  });

  it("suppresses THIS row's id and offers an honest undo", async () => {
    const suppress = scriptedMutation(["success"]);
    const unsuppress = scriptedMutation(["error"]);
    subscriberHooks.__setHookResultForTests("useSuppressSubscriber", suppress);
    subscriberHooks.__setHookResultForTests(
      "useUnsuppressSubscriber",
      unsuppress,
    );
    await mount([ALICE, BOB]);

    const [host] = rotorHosts();
    expect(host).toBeTruthy();
    await fireEvent(host as never, "accessibilityAction", {
      nativeEvent: { actionName: "Suppress" },
    });

    // The id it sent, and the address it named back — not Bob's.
    expect(suppress.mutate).toHaveBeenCalledTimes(1);
    expect(suppress.mutate.mock.calls[0]?.[0]).toBe("sub-1");
    expect(screen.getByText("Suppressed alice@example.com")).toBeTruthy();

    // Suppress blocklists as well as writing a suppression row, so the undo
    // has to restore the status it found — and admit it when the server
    // refuses, or the operator walks away believing the row came back.
    await fireEvent.press(screen.getByText("Undo"));
    expect(unsuppress.mutate.mock.calls[0]?.[0]).toEqual({
      id: "sub-1",
      email: "alice@example.com",
      restoreStatus: "enabled",
    });
    expect(screen.getByText(/Couldn't undo/)).toBeTruthy();
  });

  it("reports a suppress the server refused", async () => {
    subscriberHooks.__setHookResultForTests(
      "useSuppressSubscriber",
      scriptedMutation(["error"]),
    );
    await mount([ALICE]);
    await fireEvent(rotorHosts()[0] as never, "accessibilityAction", {
      nativeEvent: { actionName: "Suppress" },
    });
    expect(
      screen.getByText(/Couldn't suppress alice@example.com/),
    ).toBeTruthy();
  });

  it("WITHDRAWS the swipe once the list is selecting", async () => {
    const suppress = scriptedMutation(["success"]);
    subscriberHooks.__setHookResultForTests("useSuppressSubscriber", suppress);
    await mount([ALICE]);
    expect(rotorNames()).toEqual(["Suppress"]);

    await fireEvent(screen.getByLabelText(`Open ${ALICE_SPOKEN}`), "longPress");

    // A swipe that suppressed a row mid-multi-select would be an
    // unrecoverable surprise, so the gesture host is gone entirely — there is
    // nothing left to fire, by gesture or by rotor.
    expect(rotorNames()).toEqual([]);
    expect(suppress.mutate).not.toHaveBeenCalled();
  });

  it("withdraws it even when the SCREEN keeps offering the handler", async () => {
    // The row's own rule, not the screen's. `renderRow` already drops
    // `onSuppress` while selecting, so without this case the row could stop
    // withdrawing the action entirely and every other test here would still
    // pass — while any caller that does not know the screen's rule (the list
    // roster, a future screen) would ship a destructive swipe inside a
    // multi-select. Note WHICH guard carries it: the `!selecting` term in the
    // `actions` memo is belt-and-braces, because the selection branch returns
    // before `actions` is ever read. Deleting that term alone changes
    // nothing; deleting the early return is what this catches.
    const suppress = scriptedMutation(["success"]);
    subscriberHooks.__setHookResultForTests("useSuppressSubscriber", suppress);
    await mount([ALICE], { keepSuppressWhileSelecting: true });
    expect(rotorNames()).toEqual(["Suppress"]);

    await fireEvent(screen.getByLabelText(`Open ${ALICE_SPOKEN}`), "longPress");

    // The whole gesture host is gone — SwipeableRow renders its children bare
    // when the action list is empty — so there is nothing left to fire.
    expect(rotorNames()).toEqual([]);
    expect(screen.getByLabelText(ALICE_SPOKEN).props.accessibilityRole).toBe(
      "checkbox",
    );
    expect(suppress.mutate).not.toHaveBeenCalled();
  });

  it("offers no swipe at all on a row the server sent without an id", async () => {
    await mount([GHOST]);
    expect(rotorNames()).toEqual([]);
  });

  it("offers no swipe when the screen withheld the handler", async () => {
    // Offline or gated: `renderRow` drops `onSuppress` entirely.
    await mount([ALICE], { gated: true });
    expect(rotorNames()).toEqual([]);
  });
});
