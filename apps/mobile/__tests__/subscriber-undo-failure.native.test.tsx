import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

/**
 * The UNDO actions on a subscriber profile, and the failure that used to be
 * completely silent.
 *
 * Every FORWARD write on this profile reports its failure — suppress, status
 * change and tag removal each pass an `onError` that raises an error toast. The
 * UNDO buttons offered inside their success toasts did not: they called
 * `mutate` with no callbacks at all.
 *
 * That is the worst shape this can take, because the undo is the SECOND thing
 * the operator does and the one they stop watching. `useSetSubscriberStatus`
 * rolls its optimistic patch back on error and says nothing, so the toast
 * dismissed, the status pill flicked back over a second, and the operator
 * walked away believing the person had been resubscribed when the consent state
 * on the server never moved. A tag undo failed the same way and left the tag
 * removed.
 *
 * These tests drive the real hook: forward write succeeds, undo is pressed,
 * undo fails — and the screen must say so.
 */

// eslint-disable-next-line import/first
import { ToastProvider } from "@/components/Toast";

const subscriberHooks = require("./mocks/queryHooks.cjs");

/** A mutation whose Nth `mutate` call takes a scripted outcome. */
function scriptedMutation(script: readonly ("success" | "error")[]) {
  let call = 0;
  return {
    isPending: false,
    data: undefined,
    error: null,
    reset: jest.fn(),
    variables: undefined,
    mutateAsync: jest.fn(async () => ({})),
    mutate: jest.fn(
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
    ),
  };
}

/**
 * Renders the hook under test and exposes its verbs as buttons. Nothing else
 * from the profile screen is involved, so a failure here is a failure of the
 * action layer and not of the composition above it.
 */
function Harness({ tags }: { tags?: readonly string[] }) {
  const {
    useSubscriberProfileActions,
  } = require("@/hooks/useSubscriberProfileActions");
  const actions = useSubscriberProfileActions({
    id: "sub-1",
    email: "person@example.com",
    currentStatus: "enabled",
    currentTags: tags ?? ["vip"],
    canMutate: true,
  });
  const { Text } = require("react-native");
  return (
    <>
      <Text accessibilityRole="button" onPress={actions.onUnsubscribe}>
        Unsubscribe
      </Text>
      <Text
        accessibilityRole="button"
        onPress={() => actions.onRemoveTag("vip")}
      >
        Remove tag
      </Text>
    </>
  );
}

function wrap(node: React.ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { height: 844, width: 390, x: 0, y: 0 },
        insets: { bottom: 34, left: 0, right: 0, top: 47 },
      }}
    >
      <ToastProvider>{node}</ToastProvider>
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  subscriberHooks.__resetHookResultsForTests();
});

describe("a failed UNDO is never silent", () => {
  it("reports a status undo that the server refused", async () => {
    // Call 1 = the unsubscribe (succeeds, offering Undo). Call 2 = the undo.
    subscriberHooks.__setHookResultForTests(
      "useSetSubscriberStatus",
      scriptedMutation(["success", "error"]),
    );
    await wrap(<Harness />);

    await fireEvent.press(screen.getByText("Unsubscribe"));
    // The forward write landed and offered the reversal.
    expect(screen.getByText("Unsubscribed")).toBeTruthy();

    await fireEvent.press(screen.getByText("Undo"));

    // The subscriber is STILL unsubscribed. Saying nothing here is the bug.
    expect(screen.getByText(/Couldn't undo/)).toBeTruthy();
    expect(screen.getByText(/gateway 500/)).toBeTruthy();
  });

  it("stays quiet when the status undo actually works", async () => {
    subscriberHooks.__setHookResultForTests(
      "useSetSubscriberStatus",
      scriptedMutation(["success", "success"]),
    );
    await wrap(<Harness />);
    await fireEvent.press(screen.getByText("Unsubscribe"));
    await fireEvent.press(screen.getByText("Undo"));
    expect(screen.queryByText(/Couldn't undo/)).toBeNull();
  });

  it("reports a tag restore that the server refused", async () => {
    subscriberHooks.__setHookResultForTests(
      "useUpdateSubscriberTags",
      scriptedMutation(["success", "error"]),
    );
    await wrap(<Harness />);

    await fireEvent.press(screen.getByText("Remove tag"));
    expect(screen.getByText('Removed "vip"')).toBeTruthy();

    await fireEvent.press(screen.getByText("Undo"));

    // The tag is still gone, so the screen has to admit the restore failed.
    expect(screen.getByText(/Couldn't put that tag back/)).toBeTruthy();
  });

  it("still reports a failure of the FORWARD write (the branch that worked)", async () => {
    subscriberHooks.__setHookResultForTests(
      "useSetSubscriberStatus",
      scriptedMutation(["error"]),
    );
    await wrap(<Harness />);
    await fireEvent.press(screen.getByText("Unsubscribe"));
    expect(screen.getByText(/Unsubscribed failed/)).toBeTruthy();
  });
});
