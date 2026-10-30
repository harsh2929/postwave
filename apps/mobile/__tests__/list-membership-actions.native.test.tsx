/**
 * Editing a list's membership FROM THE LIST — the affordances, and who gets
 * offered them.
 *
 * What this pins:
 *  - the add control and the remove swipe are WITHHELD below editor (one
 *    caption instead of a disabled button) and while the gate is closed;
 *  - the remove verb reaches the VoiceOver rotor, so the invisible gesture is
 *    never the only path to it, and it carries the row it names;
 *  - a row the DELETE could never resolve (non-uuid id) gets no action at all;
 *  - a candidate ALREADY on the list cannot be selected — the picker's whole
 *    reason for asking the server who is already a member.
 *
 * WHY ReanimatedSwipeable IS STUBBED: the real component renders no action
 * panel until a gesture opens one (RNTL cannot produce one) and
 * `SwipeableRow.run()` calls a Reanimated worklet that throws off the UI
 * thread. The stub keeps everything under test real — the rotor publication,
 * the panel contents, the handler mapping. (Same idiom as
 * approval-row-swipe.native.test.tsx.)
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, renderHook } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

const swipeableProps: Record<string, unknown>[] = [];

jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => {
  const ReactModule = require("react") as typeof import("react");
  return {
    __esModule: true,
    default: ({
      children,
      ...props
    }: { children: React.ReactNode } & Record<string, unknown>) => {
      swipeableProps.push(props);
      return ReactModule.createElement(
        require("react-native").View,
        null,
        children,
      );
    },
  };
});

/**
 * ONLY the add mutation is replaced (everything else stays real via
 * requireActual): the react-query mock hands out a fresh `mutate` per render,
 * so the sheet's own send is otherwise unobservable — and "does the confirm
 * actually gate the write" is the one thing worth observing about it.
 */
const mockAddMutate = jest.fn();
jest.mock("../src/hooks/useListMembership", () => ({
  ...(jest.requireActual("../src/hooks/useListMembership") as object),
  useAddListMembers: () => ({ mutate: mockAddMutate, isPending: false }),
}));

// eslint-disable-next-line import/first -- must follow the stub above.
import { ConfirmProvider } from "../src/components/ConfirmSheet";
// eslint-disable-next-line import/first
import { ListAddMembersSheet } from "../src/components/lists/ListAddMembersSheet";
// eslint-disable-next-line import/first
import { ListMemberRow } from "../src/components/lists/ListMemberRow";
// eslint-disable-next-line import/first
import { ListMembershipActions } from "../src/components/lists/ListMembershipActions";
// eslint-disable-next-line import/first
import { useListMemberRemoval } from "../src/hooks/useListMembership";

const {
  __setOnlineGateForTests,
  __resetOnlineGateForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/queryHooks.cjs");
const {
  __setQueryResultForTests,
  __resetQueryResultForTests,
  // eslint-disable-next-line @typescript-eslint/no-require-imports
} = require("./mocks/reactQuery.cjs");

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  __resetOnlineGateForTests();
  __resetQueryResultForTests();
  mockAddMutate.mockReset();
  swipeableProps.length = 0;
});

type HostLike = { props: Record<string, unknown> };
type View = Awaited<ReturnType<typeof render>>;

/** Host nodes carrying rotor actions. RNTL 14 dropped the UNSAFE_ queries. */
function rotorNames(view: View): string[] {
  return (
    view.root as unknown as {
      queryAll: (p: (el: HostLike) => boolean) => HostLike[];
    }
  )
    .queryAll((el) => Array.isArray(el.props?.accessibilityActions))
    .flatMap((node) =>
      (node.props.accessibilityActions as { name: string }[]).map((a) => a.name),
    );
}

describe("ListMembershipActions — who is offered the membership verbs", () => {
  it("offers the add control, and states the row swipe, to an editor", async () => {
    const view = await render(
      <ListMembershipActions listId="7" listName="Weekly" blocked={false} />,
    );
    expect(view.getByLabelText("Add members to Weekly")).toBeTruthy();
    expect(view.getByText("Swipe a member row to take them off this list.")).toBeTruthy();
    await view.unmount();
  });

  it("gives a viewer ONE caption instead of a button they cannot press", async () => {
    __setOnlineGateForTests({ effectiveRole: "viewer" });
    const view = await render(
      <ListMembershipActions listId="7" listName="Weekly" blocked={false} />,
    );
    expect(view.queryByLabelText("Add members to Weekly")).toBeNull();
    expect(
      view.getByText("Adding or removing members needs the editor role or above."),
    ).toBeTruthy();
    await view.unmount();
  });

  it("renders nothing while the gate is closed — there is nothing truthful to queue", async () => {
    const view = await render(
      <ListMembershipActions listId="7" listName="Weekly" blocked />,
    );
    expect(view.toJSON()).toBeNull();
    await view.unmount();
  });
});

describe("useListMemberRemoval — the gate on the verb itself", () => {
  it("hands the roster a remove handler for an editor who is online", async () => {
    const hook = await renderHook(() => useListMemberRemoval("7", "Weekly"));
    expect(hook.result.current.canAct).toBe(true);
    expect(typeof hook.result.current.onRemove).toBe("function");
    await hook.unmount();
  });

  it("withholds it from a VIEWER — both routes are editor-floor", async () => {
    __setOnlineGateForTests({ effectiveRole: "viewer" });
    const hook = await renderHook(() => useListMemberRemoval("7", "Weekly"));
    expect(hook.result.current.canEdit).toBe(false);
    expect(hook.result.current.canAct).toBe(false);
    expect(hook.result.current.onRemove).toBeUndefined();
    await hook.unmount();
  });

  it("withholds it while the online gate is closed — this write cannot queue", async () => {
    __setOnlineGateForTests({ enabled: false });
    const hook = await renderHook(() => useListMemberRemoval("7", "Weekly"));
    expect(hook.result.current.onRemove).toBeUndefined();
    await hook.unmount();
  });

  it("withholds it when there is no list to remove from", async () => {
    const hook = await renderHook(() => useListMemberRemoval(undefined, "Weekly"));
    expect(hook.result.current.onRemove).toBeUndefined();
    await hook.unmount();
  });
});

describe("ListMemberRow — the remove action", () => {
  it("publishes Remove to the rotor and hands it THIS row", async () => {
    const onRemove = jest.fn();
    const view = await render(
      <ListMemberRow
        item={{ id: UUID_A, email: "dana@example.com", status: "enabled" }}
        onRemove={onRemove}
      />,
    );
    expect(rotorNames(view)).toEqual(["Remove"]);

    const [host] = (
      view.root as unknown as {
        queryAll: (p: (el: HostLike) => boolean) => HostLike[];
      }
    ).queryAll((el) => Array.isArray(el.props?.accessibilityActions));
    await fireEvent(host as never, "accessibilityAction", {
      nativeEvent: { actionName: "Remove" },
    });
    expect(onRemove).toHaveBeenCalledWith({
      id: UUID_A,
      email: "dana@example.com",
    });
    await view.unmount();
  });

  it("offers no action at all when the caller withheld the verb", async () => {
    const view = await render(
      <ListMemberRow
        item={{ id: UUID_A, email: "dana@example.com", status: "enabled" }}
      />,
    );
    expect(rotorNames(view)).toEqual([]);
    await view.unmount();
  });

  it("offers no action for a row the DELETE could never resolve", async () => {
    // membership_write.go 400s a sub_id that is not a uuid.
    const view = await render(
      <ListMemberRow
        item={{ id: "42", email: "dana@example.com", status: "enabled" }}
        onRemove={jest.fn()}
      />,
    );
    expect(rotorNames(view)).toEqual([]);
    await view.unmount();
  });
});

describe("ListAddMembersSheet — an existing member is not addable", () => {
  /** One candidate already on the list, one not. */
  function seedCandidates() {
    __setQueryResultForTests({
      data: {
        items: [
          { id: UUID_A, email: "already@example.com", status: "enabled", name: "" },
          { id: UUID_B, email: "new@example.com", status: "enabled", name: "" },
        ],
        total: 2,
        memberIds: new Set([UUID_A]),
      },
      error: null,
      isError: false,
      isFetching: false,
      isLoading: false,
      isPending: false,
      isSuccess: true,
      refetch: jest.fn(),
    });
  }

  const sheet = (
    <ListAddMembersSheet
      visible
      listId="7"
      listName="Weekly"
      onClose={jest.fn()}
      onAdded={jest.fn()}
    />
  );

  async function openSheet() {
    seedCandidates();
    return render(sheet);
  }

  it("marks the existing member On list and refuses to select them", async () => {
    const view = await openSheet();
    expect(view.getByText("On list")).toBeTruthy();

    await fireEvent.press(
      view.getByLabelText("already@example.com — already on this list"),
    );
    // Still nothing to send: pressing a member must not arm the submit.
    expect(view.getByLabelText("Select subscribers to add")).toBeTruthy();
    await view.unmount();
  });

  it("arms the submit with the candidate who is NOT already a member", async () => {
    const view = await openSheet();
    await fireEvent.press(view.getByLabelText("Select new@example.com"));
    expect(view.getByLabelText("Add 1 subscriber to Weekly")).toBeTruthy();
    await view.unmount();
  });

  it("confirms the write by NAMING the person and the list before sending it", async () => {
    seedCandidates();
    const view = await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <ConfirmProvider>{sheet}</ConfirmProvider>
      </SafeAreaProvider>,
    );
    await fireEvent.press(view.getByLabelText("Select new@example.com"));
    await fireEvent.press(view.getByLabelText("Add 1 subscriber to Weekly"));
    expect(
      view.getByText("new@example.com will be added to “Weekly”."),
    ).toBeTruthy();
    expect(
      view.getByText(
        "They start receiving what this list is sent. Anyone already on it is skipped.",
      ),
    ).toBeTruthy();
    // Nothing has been written yet — the confirm is a gate, not a receipt.
    expect(mockAddMutate).not.toHaveBeenCalled();

    // Cancelling means NOTHING is written — the answer is honoured, not just
    // collected.
    await fireEvent.press(view.getByLabelText("Cancel"));
    expect(mockAddMutate).not.toHaveBeenCalled();

    // Confirming sends ONLY the candidate who was not already a member.
    await fireEvent.press(view.getByLabelText("Add 1 subscriber to Weekly"));
    await fireEvent.press(view.getByLabelText("Add"));
    expect(mockAddMutate).toHaveBeenCalledTimes(1);
    expect(mockAddMutate.mock.calls[0]?.[0]).toEqual([UUID_B]);
    await view.unmount();
  });
});
