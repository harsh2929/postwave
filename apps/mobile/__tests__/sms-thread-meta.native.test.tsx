/**
 * SMS thread meta — tags, internal note, and activity wiring.
 *
 * Claims pinned:
 *  1. Tag removal hands the mutation the tag's exact `createdAt` (the CAS
 *     value) from the loaded inventory — without it, the server's conflict
 *     detection is dead for every removal.
 *  2. The note save sends the TRIMMED text and the overwrite caveat is on
 *     screen (notes are write-only by server contract).
 *  3. The activity feed is press-driven: not enabled until opened, and its
 *     incompleteness caption renders with the events.
 */
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";

const mockTags: { current: Record<string, unknown> } = { current: {} };
const mockActivity: { current: Record<string, unknown> } = { current: {} };
const mockTagMutations: { current: { mutate: jest.Mock; isPending: boolean } } =
  { current: { mutate: jest.fn(), isPending: false } };
const mockNotesSave: { current: { mutate: jest.Mock; isPending: boolean } } = {
  current: { mutate: jest.fn(), isPending: false },
};
const activityEnabled: { current: boolean | null } = { current: null };

jest.mock("@/hooks/useSmsConversationMeta", () => ({
  useSmsConversationTags: () => mockTags.current,
  useSmsConversationActivity: (
    _phone: string,
    _access: unknown,
    enabled: boolean,
  ) => {
    activityEnabled.current = enabled;
    return enabled
      ? mockActivity.current
      : { data: undefined, isError: false, isLoading: false };
  },
  useSmsTagMutations: () => mockTagMutations.current,
  useSmsNotesSave: () => mockNotesSave.current,
}));

// eslint-disable-next-line import/first -- must follow the hook mocks.
import { SmsThreadMetaSection } from "@/components/sms/SmsThreadMetaSection";

const PHONE = "+15552345678";
const ACCESS = {
  identity: { fingerprint: "identity-1", tenantId: "t", userId: "u" },
  roleAllowed: true,
  canRequest: true,
  online: true,
  sessionReady: true,
  denialReason: null,
} as never;

function resetMocks() {
  mockTags.current = {
    data: {
      tenantId: "t",
      phoneE164: PHONE,
      tags: [{ tag: "refund", createdAt: "2026-08-21T09:00:00Z" }],
      snapshotAt: "2026-08-21T10:00:00Z",
      truncated: false,
    },
    isError: false,
    isLoading: false,
  };
  mockActivity.current = {
    data: {
      tenantId: "t",
      phoneE164: PHONE,
      events: [
        { kind: "consent", at: "2026-08-21T09:00:00Z", title: "Consent granted" },
      ],
      snapshotAt: "2026-08-21T10:00:00Z",
      truncated: false,
      historyComplete: false,
    },
    isError: false,
    isLoading: false,
  };
  mockTagMutations.current = { mutate: jest.fn(), isPending: false };
  mockNotesSave.current = { mutate: jest.fn(), isPending: false };
  activityEnabled.current = null;
}
resetMocks();
afterEach(resetMocks);

async function renderSection() {
  return render(<SmsThreadMetaSection phoneE164={PHONE} access={ACCESS} />);
}

describe("sms thread meta", () => {
  it("removes a tag with its exact CAS createdAt", async () => {
    await renderSection();
    await fireEvent.press(screen.getByLabelText("Remove tag refund"));
    expect(mockTagMutations.current.mutate.mock.calls[0]?.[0]).toEqual({
      action: "remove",
      tag: "refund",
      expectedCreatedAt: "2026-08-21T09:00:00Z",
    });
  });

  it("adds a trimmed tag and refuses an invalid one in place", async () => {
    await renderSection();
    const field = screen.getByLabelText("New tag");
    await fireEvent.changeText(field, "vip");
    await fireEvent.press(screen.getByLabelText("Add tag"));
    expect(mockTagMutations.current.mutate.mock.calls[0]?.[0]).toEqual({
      action: "add",
      tag: "vip",
    });
    await fireEvent.changeText(field, "refund");
    await fireEvent.press(screen.getByLabelText("Add tag"));
    expect(
      screen.getByText("This conversation already carries that tag."),
    ).toBeTruthy();
    expect(mockTagMutations.current.mutate).toHaveBeenCalledTimes(1);
  });

  it("saves the trimmed note and shows the overwrite caveat", async () => {
    await renderSection();
    expect(
      screen.getByText(/Saving OVERWRITES the stored note/u),
    ).toBeTruthy();
    await fireEvent.changeText(
      screen.getByLabelText("Internal note"),
      "customer promised refund",
    );
    await fireEvent.press(
      screen.getByLabelText("Save internal note, overwriting the stored note"),
    );
    expect(mockNotesSave.current.mutate.mock.calls[0]?.[0]).toEqual({
      notes: "customer promised refund",
    });
  });

  it("keeps the activity feed press-driven and labeled incomplete", async () => {
    await renderSection();
    expect(activityEnabled.current).toBe(false);
    expect(screen.queryByText(/Consent granted/u)).toBeNull();
    await fireEvent.press(screen.getByLabelText("Show consent activity"));
    expect(activityEnabled.current).toBe(true);
    expect(screen.getByText(/Consent granted/u)).toBeTruthy();
    expect(
      screen.getByText(/not a complete operator log/u),
    ).toBeTruthy();
  });
});
