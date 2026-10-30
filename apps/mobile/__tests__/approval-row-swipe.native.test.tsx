/**
 * The approval row's two decision gestures, and which EDGE each lives on.
 *
 * `SwipeableRow` shipped a complete, symmetric left-panel implementation
 * (`left` prop → `renderLeftActions`, sharing `renderPanel` and the same rotor
 * publication) that no call site in the app ever used: all seventeen passed
 * only `right`. Approvals is the row where that mattered, because it is the
 * only one whose panel carried an irreversible verb NEXT TO a constructive one
 * — two adjacent 84pt buttons distinguished by colour and a five-letter word,
 * where overshooting "Approve" lands on "Reject".
 *
 * Split, the direction of the drag IS the decision.
 *
 * WHY ReanimatedSwipeable IS STUBBED HERE. The real component mounts fine, but
 * two things about it make the behaviour under test unobservable: it renders
 * neither action panel until a gesture opens one (RNTL cannot produce one), and
 * `SwipeableRow.run()` calls `ref.current?.close()`, a Reanimated worklet that
 * throws `_WORKLET is not defined` off the UI thread. The stub captures the
 * props SwipeableRow hands it — which is exactly the contract this test is
 * about — and leaves everything under test (the panels' contents, the rotor
 * publication, the handler mapping) real.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";

const swipeableProps: Record<string, unknown>[] = [];

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

// eslint-disable-next-line import/first -- must follow the stub above.
import { ApprovalRow } from "../src/components/approvals/ApprovalRow";
// eslint-disable-next-line import/first
import type { Approval } from "../src/hooks/useApprovals";

const NOW = Date.parse("2026-02-01T00:00:00Z");

type HostLike = { props: Record<string, unknown> };

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: "a-1",
    tenantId: "t-1",
    resourceType: "campaign",
    resourceId: "c-00000000",
    requestedByActorType: "user",
    requestedByActorLabel: "Dana",
    requestedByUserId: "u-2",
    status: "pending",
    requestedAt: "2026-01-31T23:00:00Z",
    expiresAt: "2026-02-02T00:00:00Z",
    ...over,
  };
}

// `render` in this harness resolves asynchronously (see more-filter.native).
async function mount(over: Partial<Approval> = {}) {
  swipeableProps.length = 0;
  const onApprove = jest.fn();
  const onReject = jest.fn();
  const view = await render(
    <ApprovalRow
      approval={approval(over)}
      decidingId={null}
      anyDeciding={false}
      gateNotice={null}
      now={NOW}
      currentUserId="u-1"
      onOpen={jest.fn()}
      onApprove={onApprove}
      onReject={onReject}
    />,
  );
  return { onApprove, onReject, view, gesture: swipeableProps[0] };
}

type View = Awaited<ReturnType<typeof mount>>["view"];

/** Host nodes carrying rotor actions. RNTL 14 dropped the UNSAFE_ queries. */
function rotorHosts(view: View): HostLike[] {
  return (
    view.root as unknown as {
      queryAll: (p: (el: HostLike) => boolean) => HostLike[];
    }
  ).queryAll((el) => Array.isArray(el.props?.accessibilityActions));
}

function rotorNames(view: View): string[] {
  return rotorHosts(view).flatMap((node) =>
    (node.props.accessibilityActions as { name: string }[]).map((a) => a.name),
  );
}

/** The labels a panel renderer would draw, read out of its element tree. */
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

describe("approval row — the decision verbs sit on opposite edges", () => {
  it("mounts a LEFT panel at all, which no row in the app previously did", async () => {
    const { gesture } = await mount();
    expect(typeof gesture?.renderLeftActions).toBe("function");
    expect(typeof gesture?.renderRightActions).toBe("function");
  });

  it("draws Approve on the left edge and Reject on the right", async () => {
    const { gesture } = await mount();
    await expect(panelLabels(gesture?.renderLeftActions)).resolves.toEqual([
      "Approve",
    ]);
    await expect(panelLabels(gesture?.renderRightActions)).resolves.toEqual([
      "Reject",
    ]);
  });

  it("still publishes BOTH verbs to the rotor after the split", async () => {
    const { view } = await mount();
    // `[...left, ...right]` — a screen-reader user must lose nothing to the
    // split, and the ORDER is the read-out of which edge each verb sits on.
    // Stacked in one panel this was ["Reject", "Approve"].
    expect(rotorNames(view)).toEqual(["Approve", "Reject"]);
  });

  it("runs the handler each action NAMES, not whichever one it inherited", async () => {
    const { onApprove, onReject, view } = await mount();
    const [host] = rotorHosts(view);
    expect(host).toBeTruthy();

    await fireEvent(host as never, "accessibilityAction", {
      nativeEvent: { actionName: "Approve" },
    });
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();

    await fireEvent(host as never, "accessibilityAction", {
      nativeEvent: { actionName: "Reject" },
    });
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("offers neither edge on a row that cannot be decided", async () => {
    // Already decided — the predicate that used to empty the single right-hand
    // panel must empty both. With no actions at all SwipeableRow renders its
    // children bare, so there is no gesture host and no rotor entry.
    const { view, gesture } = await mount({
      status: "approved",
      decidedAt: "2026-01-31T23:30:00Z",
    });
    expect(gesture).toBeUndefined();
    expect(rotorNames(view)).toEqual([]);
  });
});
