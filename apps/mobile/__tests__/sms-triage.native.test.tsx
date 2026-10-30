/**
 * SMS triage — the two controls that were missing verbs, rendered.
 *
 * The inbox shipped Snoozed / Archived filter chips with live server counts and
 * no way to move a row into either, and the senders read had no pause beside
 * it. The rules live in `smsTriageOptions` (node-tested); these pin what an
 * operator can actually REACH:
 *
 *   - a snoozed conversation offers "Wake now" and never a second "Archive";
 *   - a thread that does not know its lifecycle state SAYS SO rather than
 *     guessing a toggle;
 *   - a failed sender read never renders as "no senders are configured", which
 *     is the reassuring answer and the wrong one;
 *   - a viewer sees sender STATE and no switch, because pause/resume are
 *     ScopeAdmin (apps/api/internal/sms/handlers.go:152-153).
 */
import { describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { SmsConversationTriageSheet } from "@/components/sms/SmsConversationTriageSheet";
import { SmsSendersCard } from "@/components/sms/SmsSendersCard";
import type { SmsSenderProfile } from "@/lib/smsConversation";

const NOW = Date.UTC(2026, 7, 27, 12, 0, 0);
const ME = "11111111-1111-4111-8111-111111111111";
const THEM = "22222222-2222-4222-8222-222222222222";

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

function sender(over: Partial<SmsSenderProfile> = {}): SmsSenderProfile {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    tenantId: ME,
    provider: "twilio",
    country: "US",
    senderType: "10dlc",
    registrationStatus: "approved",
    phoneNumber: "+15555550123",
    paused: false,
    ...over,
  };
}

describe("SmsConversationTriageSheet", () => {
  it("offers Wake now for a snoozed conversation and no Restore", async () => {
    const onSelect = jest.fn();
    await wrap(
      <SmsConversationTriageSheet
        visible
        conversation={{ snoozeUntil: new Date(NOW + 60_000).toISOString() }}
        title="+15555550123"
        currentUserId={ME}
        now={NOW}
        busy={false}
        onClose={jest.fn()}
        onSelect={onSelect}
      />,
    );

    expect(screen.getByLabelText("Wake now")).toBeTruthy();
    expect(screen.queryByLabelText("Restore from archive")).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Wake now"));
    });
    expect(onSelect).toHaveBeenCalledWith("unsnooze");
  });

  it("offers Restore for an archived conversation and no second Archive", async () => {
    await wrap(
      <SmsConversationTriageSheet
        visible
        conversation={{ archivedAt: new Date(NOW - 1).toISOString() }}
        title="+15555550123"
        currentUserId={ME}
        now={NOW}
        busy={false}
        onClose={jest.fn()}
        onSelect={jest.fn()}
      />,
    );

    expect(screen.getByLabelText("Restore from archive")).toBeTruthy();
    expect(screen.queryByLabelText("Archive")).toBeNull();
  });

  it("says the lifecycle state is unknown rather than guessing a toggle", async () => {
    await wrap(
      <SmsConversationTriageSheet
        visible
        conversation={null}
        title="+15555550123"
        currentUserId={ME}
        now={NOW}
        busy={false}
        onClose={jest.fn()}
        onSelect={jest.fn()}
      />,
    );

    expect(
      screen.getByText(/current snooze and archive state isn't loaded/i),
    ).toBeTruthy();
    expect(screen.getByLabelText("Archive")).toBeTruthy();
    expect(screen.getByLabelText("Restore from archive")).toBeTruthy();
  });

  it("takes over a conversation held by a teammate and can clear it", async () => {
    const onSelect = jest.fn();
    await wrap(
      <SmsConversationTriageSheet
        visible
        conversation={{ assigneeUserId: THEM }}
        title="+15555550123"
        currentUserId={ME}
        now={NOW}
        busy={false}
        onClose={jest.fn()}
        onSelect={onSelect}
      />,
    );

    await act(async () => {
      fireEvent.press(screen.getByLabelText("Assign to me"));
    });
    expect(onSelect).toHaveBeenCalledWith("assign_me");
    expect(screen.getByLabelText("Clear the assignee")).toBeTruthy();
  });

  it("refuses every verb while a previous change is still saving", async () => {
    const onSelect = jest.fn();
    await wrap(
      <SmsConversationTriageSheet
        visible
        conversation={{}}
        title="+15555550123"
        currentUserId={ME}
        now={NOW}
        busy
        onClose={jest.fn()}
        onSelect={onSelect}
      />,
    );

    const archive = screen.getByLabelText("Archive");
    expect(archive.props.accessibilityState).toMatchObject({ disabled: true });
    await act(async () => {
      fireEvent.press(archive);
    });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("SmsSendersCard", () => {
  it("names a paused sender and pauses a sending one", async () => {
    const onToggle = jest.fn();
    const rows = [
      sender(),
      sender({
        id: "55555555-5555-4555-8555-555555555555",
        phoneNumber: "+15555559999",
        paused: true,
      }),
    ];
    await wrap(
      <SmsSendersCard
        senders={rows}
        unavailableReason={null}
        loading={false}
        canEdit
        pendingId={null}
        onToggle={onToggle}
      />,
    );

    expect(screen.getByText(/2 senders · 1 paused/)).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();

    await act(async () => {
      fireEvent(
        screen.getByLabelText("Sending from +15555550123"),
        "valueChange",
        false,
      );
    });
    expect(onToggle).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumber: "+15555550123" }),
      true,
    );
  });

  it("says the read FAILED rather than 'no senders are configured'", async () => {
    await wrap(
      <SmsSendersCard
        senders={[]}
        unavailableReason="Senders couldn't be loaded, so this is not a statement that none exist."
        loading={false}
        canEdit
        pendingId={null}
        onToggle={jest.fn()}
      />,
    );

    expect(screen.getByText(/not a statement that none exist/)).toBeTruthy();
    expect(screen.queryByText(/No sender profiles are configured/)).toBeNull();
  });

  it("shows a viewer the sender state and no switch", async () => {
    await wrap(
      <SmsSendersCard
        senders={[sender({ paused: true })]}
        unavailableReason={null}
        loading={false}
        canEdit={false}
        pendingId={null}
        onToggle={jest.fn()}
      />,
    );

    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.queryByLabelText("Sending from +15555550123")).toBeNull();
  });

  it("only the row being written goes busy", async () => {
    const rows = [
      sender(),
      sender({
        id: "55555555-5555-4555-8555-555555555555",
        phoneNumber: "+15555559999",
      }),
    ];
    await wrap(
      <SmsSendersCard
        senders={rows}
        unavailableReason={null}
        loading={false}
        canEdit
        pendingId={rows[0]!.id}
        onToggle={jest.fn()}
      />,
    );

    expect(
      screen.getByLabelText("Sending from +15555550123").props.disabled,
    ).toBe(true);
    expect(
      screen.getByLabelText("Sending from +15555559999").props.disabled,
    ).toBe(false);
  });
});
