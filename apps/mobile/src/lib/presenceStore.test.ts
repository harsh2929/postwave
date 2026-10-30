import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_PRESENCE } from "./presence";
import {
  applyWorkspacePresence,
  getWorkspacePresence,
  resetWorkspacePresence,
  subscribeWorkspacePresence,
} from "./presenceStore";

afterEach(() => {
  resetWorkspacePresence();
});

describe("presenceStore", () => {
  it("starts empty", () => {
    expect(getWorkspacePresence()).toEqual(EMPTY_PRESENCE);
  });

  it("applies a live frame and notifies subscribers", () => {
    let notified = 0;
    const unsubscribe = subscribeWorkspacePresence(() => {
      notified += 1;
    });

    expect(
      applyWorkspacePresence({
        count: 2,
        users_v2: [
          { id: "u1", label: "alice" },
          { id: "u2", label: "bob" },
        ],
      }),
    ).toBe(true);
    expect(getWorkspacePresence().count).toBe(2);
    expect(notified).toBe(1);

    unsubscribe();
  });

  it("keeps the previous snapshot when a frame is unparseable", () => {
    applyWorkspacePresence({ count: 2, users_v2: [{ id: "u1", label: "alice" }] });
    expect(applyWorkspacePresence("garbage")).toBe(false);
    expect(applyWorkspacePresence(undefined)).toBe(false);
    expect(getWorkspacePresence().count).toBe(2);
  });

  it("does not notify when nothing changed", () => {
    const frame = { count: 1, users_v2: [{ id: "u1", label: "alice" }] };
    applyWorkspacePresence(frame);

    let notified = 0;
    const unsubscribe = subscribeWorkspacePresence(() => {
      notified += 1;
    });
    expect(applyWorkspacePresence(frame)).toBe(false);
    expect(notified).toBe(0);

    unsubscribe();
  });

  it("notifies when only an identity changed at the same count", () => {
    applyWorkspacePresence({ count: 1, users_v2: [{ id: "u1", label: "alice" }] });
    expect(
      applyWorkspacePresence({ count: 1, users_v2: [{ id: "u2", label: "bob" }] }),
    ).toBe(true);
    expect(getWorkspacePresence().viewers[0]?.id).toBe("u2");
  });

  it("resets to empty", () => {
    applyWorkspacePresence({ count: 3, users: ["alice"] });
    resetWorkspacePresence();
    expect(getWorkspacePresence()).toEqual(EMPTY_PRESENCE);
  });
});
