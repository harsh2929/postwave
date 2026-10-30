/**
 * SmsSendersSection — the piece that composes the card, its read and its
 * write. The card, the hook and the route all existed; nothing rendered them
 * together, so "stop sending from this number" was a tested component no
 * operator could reach. These tests drive the section the way SmsPolicyPanel
 * mounts it (handed the panel's single `useSmsInboxAccess` read), and assert
 * consequences: the mutation's arguments, the toast, the readiness gate, the
 * single-writer guard, and that an offline read never reads as "none".
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";

import type { SmsInboxAccess } from "../src/hooks/smsInboxIdentity";
import type { SmsSenderProfile } from "../src/lib/smsConversation";

const mockSenders: { current: Record<string, unknown> } = { current: {} };
const mockPaused: { current: Record<string, unknown> } = { current: {} };
const mockToast = jest.fn();

jest.mock("@/hooks/useSmsInbox", () => ({
  useSmsSenders: () => mockSenders.current,
}));
jest.mock("@/hooks/useSmsInboxTriage", () => ({
  useSmsSenderPaused: () => mockPaused.current,
}));
jest.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

// eslint-disable-next-line import/first
import { SmsSendersSection, sendersUnavailableReason } from "../src/components/sms/SmsSendersSection";

const sender = (over: Partial<SmsSenderProfile> = {}): SmsSenderProfile => ({
  id: "snd_1",
  tenantId: "11111111-1111-4111-8111-111111111111",
  provider: "twilio",
  country: "US",
  senderType: "long_code",
  phoneNumber: "+1 415 555 0100",
  registrationStatus: "approved",
  paused: false,
  ...over,
});

const access = (over: Partial<SmsInboxAccess> = {}): SmsInboxAccess => ({
  identity: {
    baseUrl: "https://api.example.com",
    tenantId: "11111111-1111-4111-8111-111111111111",
    userId: "u1",
    effectiveRole: "admin",
    mode: "session",
    contextEpoch: null,
    fingerprint: "fp",
  },
  roleAllowed: true,
  canRequest: true,
  online: true,
  sessionReady: true,
  denialReason: null,
  ...over,
});

type PausedInput = { senderId: string; paused: boolean };
type PausedResult = { id: string; paused: boolean };
const pausedMock = () => jest.fn<(input: PausedInput) => Promise<PausedResult>>();

function readOk(data: SmsSenderProfile[]) {
  return { data, isLoading: false, isFetching: false, isSuccess: true, isError: false };
}

beforeEach(() => {
  mockToast.mockReset();
  mockSenders.current = readOk([sender()]);
  mockPaused.current = { mutateAsync: pausedMock().mockResolvedValue({ id: "snd_1", paused: true }), isPending: false };
});

describe("SmsSendersSection", () => {
  it("pauses a sender: the mutation gets the id and the new state, and the toast says so", async () => {
    await render(<SmsSendersSection access={access()} />);
    const sw = screen.getByLabelText("Sending from +1 415 555 0100");
    // A live sender's switch is ON; flipping it OFF means paused=true.
    await fireEvent(sw, "valueChange", false);
    await waitFor(() =>
      expect((mockPaused.current.mutateAsync as ReturnType<typeof pausedMock>).mock.calls[0]?.[0]).toEqual({
        senderId: "snd_1",
        paused: true,
      }),
    );
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "success", message: expect.stringMatching(/paused\. Nothing sends/u) }),
      ),
    );
  });

  it("resumes a paused sender with paused=false", async () => {
    mockSenders.current = readOk([sender({ paused: true })]);
    await render(<SmsSendersSection access={access()} />);
    await fireEvent(screen.getByLabelText("Sending from +1 415 555 0100"), "valueChange", true);
    await waitFor(() =>
      expect((mockPaused.current.mutateAsync as ReturnType<typeof pausedMock>).mock.calls[0]?.[0]).toEqual({
        senderId: "snd_1",
        paused: false,
      }),
    );
  });

  it("surfaces the server's own sentence when the write is refused, and claims no success", async () => {
    mockPaused.current = { mutateAsync: pausedMock().mockRejectedValue(new Error("Sender is under carrier review.")), isPending: false };
    await render(<SmsSendersSection access={access()} />);
    await fireEvent(screen.getByLabelText("Sending from +1 415 555 0100"), "valueChange", false);
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", message: "Sender is under carrier review." })),
    );
    expect(mockToast).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "success" }));
  });

  it("refuses to write on a stale read: a fetching list is not a current one", async () => {
    // The card withholds the switch entirely when a write is not ready — the
    // sender is still LISTED, but there is nothing to tap. That is stricter
    // than a disabled switch, and it is what the section asks for by passing
    // canEdit=false while the read is in flight.
    mockSenders.current = { ...readOk([sender()]), isFetching: true };
    await render(<SmsSendersSection access={access()} />);
    expect(screen.getByText(/\+1 415 555 0100/u)).toBeTruthy();
    expect(screen.queryByLabelText(/^Sending from/u)).toBeNull();
    expect(mockPaused.current.mutateAsync).not.toHaveBeenCalled();
  });

  it("states WHY when the read failed instead of rendering an empty list", async () => {
    mockSenders.current = { data: undefined, isLoading: false, isFetching: false, isSuccess: false, isError: true };
    await render(<SmsSendersSection access={access()} />);
    expect(screen.getByText(/couldn't be loaded, so this is not a statement that none exist/u)).toBeTruthy();
    expect(screen.queryByLabelText(/^Sending from/u)).toBeNull();
  });

  it("never answers 'none configured' from a read that could not run offline", async () => {
    // Offline, `useSmsSenders` is disabled and never runs: TanStack v5 reports
    // isLoading=false, isError=false, data=undefined — which the card would
    // otherwise render as the reassuring (and false) "nothing can send".
    mockSenders.current = { data: undefined, isLoading: false, isFetching: false, isSuccess: false, isError: false };
    await render(<SmsSendersSection access={access({ online: false, canRequest: false })} />);
    expect(screen.getByText(/can't be read offline/u)).toBeTruthy();
    expect(screen.queryByText(/No sender profiles are configured/u)).toBeNull();
    expect(screen.queryByLabelText(/^Sending from/u)).toBeNull();
  });

  it("states the role denial when the workspace role cannot read senders", async () => {
    mockSenders.current = { data: undefined, isLoading: false, isFetching: false, isSuccess: false, isError: false };
    await render(<SmsSendersSection access={access({ roleAllowed: false, denialReason: "Your role can't read SMS senders." })} />);
    expect(screen.getByText("Your role can't read SMS senders.")).toBeTruthy();
  });
});

describe("sendersUnavailableReason", () => {
  it("prefers the denial, then distinguishes offline from a failed read, and is null when fine", () => {
    expect(sendersUnavailableReason({ roleAllowed: false, denialReason: "no", failed: true, offline: true })).toBe("no");
    expect(sendersUnavailableReason({ roleAllowed: true, denialReason: null, failed: true, offline: true })).toMatch(/offline/u);
    expect(sendersUnavailableReason({ roleAllowed: true, denialReason: null, failed: true, offline: false })).toMatch(/not a statement that none exist/u);
    expect(sendersUnavailableReason({ roleAllowed: true, denialReason: null, failed: false, offline: true })).toBeNull();
  });
});
