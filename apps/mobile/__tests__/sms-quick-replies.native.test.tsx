/**
 * SMS quick replies — picker wiring and use-recording.
 *
 * Claims pinned:
 *  1. Picking INSERTS (calls onInsert with the reply) and never sends; the
 *     sheet's subtitle carries the dispatch-hold caveat out loud.
 *  2. Creating hands the mutation the trimmed label and the body.
 *  3. `useSmsQuickReplyInsert` records ONE use only when a persisted send's
 *     body still equals the inserted reply — a mismatched body (the operator
 *     edited the draft) records nothing.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { Pressable, Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

const mockList: { current: Record<string, unknown> } = { current: {} };
const mockWrites: { current: { mutate: jest.Mock; isPending: boolean } } = {
  current: { mutate: jest.fn(), isPending: false },
};
const mockUse: { current: { mutate: jest.Mock; isPending: boolean } } = {
  current: { mutate: jest.fn(), isPending: false },
};

jest.mock("@/hooks/useSmsQuickReplies", () => ({
  useSmsQuickReplies: () => mockList.current,
  useSmsQuickReplyWrites: () => mockWrites.current,
  useSmsQuickReplyUse: () => mockUse.current,
}));

/* eslint-disable import/first -- must follow the hook mocks. */
import { ConfirmProvider } from "@/components/ConfirmSheet";
import { SmsQuickReplyPicker } from "@/components/sms/SmsQuickReplyPicker";
import { useSmsQuickReplyInsert } from "@/hooks/useSmsQuickReplyInsert";
import type { SmsQuickReply } from "@/lib/smsQuickReply";
/* eslint-enable import/first */

const ID = "44444444-4444-4444-8444-444444444444";
const ACCESS = {
  identity: { fingerprint: "identity-1", tenantId: "t", userId: "u" },
  roleAllowed: true,
  canRequest: true,
  online: true,
  sessionReady: true,
  denialReason: null,
} as never;

const REPLY: SmsQuickReply = {
  id: ID,
  label: "Refund policy",
  body: "Refunds are processed within 5 business days.",
  useCount: 2,
  createdAt: "2026-08-21T09:00:00Z",
  updatedAt: "2026-08-21T09:00:00Z",
};

function resetMocks() {
  mockList.current = {
    data: {
      tenantId: "t",
      replies: [REPLY],
      snapshotAt: "2026-08-21T10:00:00Z",
      truncated: false,
    },
    isError: false,
    isLoading: false,
  };
  mockWrites.current = { mutate: jest.fn(), isPending: false };
  mockUse.current = { mutate: jest.fn(), isPending: false };
}
resetMocks();
afterEach(resetMocks);

describe("quick reply picker", () => {
  it("inserts the picked reply and says nothing is sent", async () => {
    const onInsert = jest.fn();
    const onClose = jest.fn();
    await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <ConfirmProvider>
          <SmsQuickReplyPicker
            visible
            access={ACCESS}
            onInsert={onInsert}
            onClose={onClose}
          />
        </ConfirmProvider>
      </SafeAreaProvider>,
    );
    expect(
      screen.getByText(/nothing is sent\. Live reply dispatch is still release-held/u),
    ).toBeTruthy();
    await fireEvent.press(screen.getByText("Refund policy"));
    expect(onInsert.mock.calls[0]?.[0]).toEqual(REPLY);
    expect(onClose).toHaveBeenCalled();
  });

  it("creates with the trimmed label", async () => {
    await render(
      <SafeAreaProvider
        initialMetrics={{
          frame: { height: 844, width: 390, x: 0, y: 0 },
          insets: { bottom: 34, left: 0, right: 0, top: 47 },
        }}
      >
        <ConfirmProvider>
          <SmsQuickReplyPicker
            visible
            access={ACCESS}
            onInsert={jest.fn()}
            onClose={jest.fn()}
          />
        </ConfirmProvider>
      </SafeAreaProvider>,
    );
    await fireEvent.press(screen.getByText("New quick reply…"));
    await fireEvent.changeText(
      screen.getByLabelText("Quick reply label"),
      "  Shipping delay  ",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Quick reply text"),
      "Your order ships tomorrow.",
    );
    await fireEvent.press(screen.getByLabelText("Save quick reply"));
    expect(mockWrites.current.mutate.mock.calls[0]?.[0]).toEqual({
      action: "create",
      label: "Shipping delay",
      body: "Your order ships tomorrow.",
    });
  });
});

function InsertHarness() {
  const insert = useSmsQuickReplyInsert(ACCESS, jest.fn() as never);
  return (
    <>
      <Pressable
        accessibilityLabel="note"
        onPress={() => insert.noteInserted(REPLY)}
      >
        <Text>note</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="persist-match"
        onPress={() => insert.onPersisted(REPLY.body)}
      >
        <Text>persist-match</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="persist-edited"
        onPress={() => insert.onPersisted("edited body")}
      >
        <Text>persist-edited</Text>
      </Pressable>
    </>
  );
}

describe("use recording", () => {
  it("records one use for a matching persisted body only", async () => {
    await render(<InsertHarness />);
    await fireEvent.press(screen.getByLabelText("note"));
    await fireEvent.press(screen.getByLabelText("persist-edited"));
    expect(mockUse.current.mutate).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByLabelText("persist-match"));
    expect(mockUse.current.mutate.mock.calls[0]?.[0]).toEqual({ id: ID });
    // The memory is consumed: a second persisted send records nothing new.
    await fireEvent.press(screen.getByLabelText("persist-match"));
    expect(mockUse.current.mutate).toHaveBeenCalledTimes(1);
  });
});
