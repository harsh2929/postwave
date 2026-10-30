/**
 * PresenceBar render contract.
 *
 * The whole point of this component is what it does NOT draw. Presence is
 * advisory — the server counts open connections, nothing is locked — so the
 * two failure modes worth pinning are:
 *
 *   - a permanent "0 others" chip on every screen it is mounted on, which is
 *     what happens the moment the empty case renders anything at all; and
 *   - a stack of coloured initials that a screen reader announces as "A B",
 *     which is the same as announcing nothing.
 *
 * It also must not count the phone's own connection: mobile always holds a
 * subscription open, so an un-filtered chip would read "1 other here" in a
 * workspace where the user is alone.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { act, render, screen } from "@testing-library/react-native";

import { PresenceBar } from "@/components/PresenceBar";
import {
  applyWorkspacePresence,
  resetWorkspacePresence,
} from "@/lib/presenceStore";
import * as AuthStore from "@/store/auth";

const authHarness = AuthStore as unknown as {
  __setAuthStateForTests: (value: Record<string, unknown>) => void;
  __resetAuthStateForTests: () => void;
};

/** The signed-in user id the default fixture reports. */
const SELF_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  resetWorkspacePresence();
  authHarness.__resetAuthStateForTests();
});

describe("PresenceBar", () => {
  it("renders nothing when nobody else is here", async () => {
    const tree = await render(<PresenceBar />);
    expect(tree.toJSON()).toBeNull();
  });

  it("renders nothing when the only connection is our own", async () => {
    applyWorkspacePresence({
      count: 1,
      users_v2: [{ id: SELF_ID, label: "alice" }],
    });
    const tree = await render(<PresenceBar />);
    expect(tree.toJSON()).toBeNull();
  });

  it("names the other viewers in one spoken node", async () => {
    applyWorkspacePresence({
      count: 2,
      users_v2: [
        { id: SELF_ID, label: "alice" },
        { id: "u2", label: "bob" },
      ],
    });
    await render(<PresenceBar />);

    // The identities are SPOKEN by the wrapper, not left to the initials.
    expect(screen.getByLabelText("bob in this workspace")).toBeTruthy();
    // The count is also a word on screen, not only a bubble stack. It is
    // hidden from assistive tech on purpose — the wrapper already says it —
    // so the query has to opt into hidden elements to see it.
    expect(
      screen.getByText("1 other here", { includeHiddenElements: true }),
    ).toBeTruthy();
  });

  it("shows initials for each known viewer", async () => {
    applyWorkspacePresence({
      count: 3,
      users_v2: [
        { id: "u2", label: "bob.jones" },
        { id: "u3", label: "carla" },
      ],
    });
    await render(<PresenceBar />);
    expect(screen.getByText("BJ", { includeHiddenElements: true })).toBeTruthy();
    expect(screen.getByText("C", { includeHiddenElements: true })).toBeTruthy();
  });

  it("updates live as frames arrive", async () => {
    await render(<PresenceBar />);
    expect(
      screen.queryByText("1 other here", { includeHiddenElements: true }),
    ).toBeNull();

    await act(async () => {
      applyWorkspacePresence({
        count: 2,
        users_v2: [
          { id: SELF_ID, label: "alice" },
          { id: "u2", label: "bob" },
        ],
      });
    });
    expect(
      screen.getByText("1 other here", { includeHiddenElements: true }),
    ).toBeTruthy();
  });
});
