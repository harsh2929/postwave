// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  purgeOrphanedSuppressionHandoffs,
  purgePrivateSessionState,
  registerPrivateSessionReset,
} from "../../lib/private-session-state";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("private session sign-out boundary", () => {
  it("purges orphaned suppression handoffs without waiting for sign-out", () => {
    sessionStorage.setItem(
      "postwave.suppressions.pending-list-filter.v1",
      "list-private",
    );
    sessionStorage.setItem(
      "postwave.suppressions.pending-list-name.v1",
      "Private customers",
    );

    purgeOrphanedSuppressionHandoffs();

    expect(sessionStorage.length).toBe(0);
  });

  it("clears every owner and unsafe legacy prefix without deleting low-risk preferences", () => {
    const reset = vi.fn();
    const unregister = registerPrivateSessionReset("test-owner", reset);
    localStorage.setItem(
      "postwave.cmdk.recents.v1:scope-a",
      "private@example.com",
    );
    localStorage.setItem(
      "postwave.desktop.route.v1:scope-a",
      "/app/subscribers/private%40example.com?q=secret",
    );
    localStorage.setItem(
      "postwave.audit.filters.v1:scope-a",
      JSON.stringify({ actorLabel: "private@example.com" }),
    );
    localStorage.setItem(
      "postwave.helpdesk-note-quarantine.v1:legacy-actor-scope",
      "1",
    );
    localStorage.setItem(
      "postwave.helpdesk-note-quarantine.v2:v2-session-private",
      "1",
    );
    localStorage.setItem(
      "postwave.helpdesk-note-quarantine.v3:v3-session-private",
      "1",
    );
    sessionStorage.setItem(
      "pw.subscribers.recentSearches.v1",
      JSON.stringify(["private@example.com"]),
    );
    sessionStorage.setItem(
      "postwave.suppressions.pending-list-filter.v1",
      "list-private",
    );
    sessionStorage.setItem(
      "postwave.suppressions.pending-list-name.v1",
      "Private customers",
    );
    localStorage.setItem("postwave.desktop.navigation.v1:scope-a", "safe-ui");

    purgePrivateSessionState();

    expect(reset).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("postwave.cmdk.recents.v1:scope-a")).toBeNull();
    expect(
      localStorage.getItem("postwave.desktop.route.v1:scope-a"),
    ).toBeNull();
    expect(
      localStorage.getItem("postwave.audit.filters.v1:scope-a"),
    ).toBeNull();
    expect(
      localStorage.getItem(
        "postwave.helpdesk-note-quarantine.v1:legacy-actor-scope",
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        "postwave.helpdesk-note-quarantine.v2:v2-session-private",
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        "postwave.helpdesk-note-quarantine.v3:v3-session-private",
      ),
    ).toBeNull();
    expect(
      sessionStorage.getItem("pw.subscribers.recentSearches.v1"),
    ).toBeNull();
    expect(
      sessionStorage.getItem("postwave.suppressions.pending-list-filter.v1"),
    ).toBeNull();
    expect(
      sessionStorage.getItem("postwave.suppressions.pending-list-name.v1"),
    ).toBeNull();
    expect(localStorage.getItem("postwave.desktop.navigation.v1:scope-a")).toBe(
      "safe-ui",
    );
    unregister();
  });

  it("preserves v2/v3 recovery tombstones only during workspace identity cleanup", () => {
    localStorage.setItem(
      "postwave.helpdesk-note-quarantine.v1:legacy-actor-scope",
      "1",
    );
    localStorage.setItem(
      "postwave.helpdesk-note-quarantine.v2:v2-session-private",
      "1",
    );
    localStorage.setItem(
      "postwave.helpdesk-note-quarantine.v3:v3-session-private",
      "1",
    );
    localStorage.setItem(
      "postwave.desktop.route.v1:scope-a",
      "/app/subscribers/private%40example.com?q=secret",
    );
    sessionStorage.setItem(
      "pw.subscribers.recentSearches.v1",
      JSON.stringify(["private@example.com"]),
    );

    purgePrivateSessionState({ preserveInternalNoteQuarantine: true });

    expect(
      localStorage.getItem(
        "postwave.helpdesk-note-quarantine.v1:legacy-actor-scope",
      ),
    ).toBeNull();
    expect(
      localStorage.getItem(
        "postwave.helpdesk-note-quarantine.v2:v2-session-private",
      ),
    ).toBe("1");
    expect(
      localStorage.getItem(
        "postwave.helpdesk-note-quarantine.v3:v3-session-private",
      ),
    ).toBe("1");
    expect(
      localStorage.getItem("postwave.desktop.route.v1:scope-a"),
    ).toBeNull();
    expect(
      sessionStorage.getItem("pw.subscribers.recentSearches.v1"),
    ).toBeNull();
  });
});
