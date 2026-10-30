/**
 * The rules that decide what this device is allowed to connect to, and what a
 * "switch" actually costs.
 *
 * The ones worth stating: a stored row is re-validated (never trusted), the
 * same server can never be saved twice, the active profile cannot be deleted
 * out from under a live session, and an offline switch is refused rather than
 * queued — a queued identity change would sign the user out of a server it
 * then could not sign them in to.
 */
import { describe, expect, it } from "vitest";

import {
  EMPTY_CONNECTION_PROFILES,
  MAX_CONNECTION_PROFILES,
  MAX_PROFILE_NAME_CHARS,
  addConnectionProfile,
  connectionHostLabel,
  connectionProfileProblem,
  connectionSwitchConsequence,
  connectionSwitchDecision,
  parseConnectionProfiles,
  reconcileActiveProfile,
  removeConnectionProfile,
  sortConnectionProfiles,
  suggestConnectionName,
  type ConnectionProfilesState,
} from "@/lib/connectionProfiles";

const PROD = { id: "p1", name: "Acme production", baseUrl: "https://api.acme.com" };
const STAGE = { id: "p2", name: "Acme staging", baseUrl: "https://stage.acme.com" };

function state(
  profiles: ConnectionProfilesState["profiles"],
  activeId: string | null = null,
): ConnectionProfilesState {
  return { profiles, activeId };
}

describe("parseConnectionProfiles", () => {
  it("round-trips a well-formed record", () => {
    const parsed = parseConnectionProfiles({
      profiles: [PROD, STAGE],
      activeId: "p2",
    });
    expect(parsed.profiles).toEqual([PROD, STAGE]);
    expect(parsed.activeId).toBe("p2");
  });

  it("drops a row whose URL the app's policy refuses", () => {
    const parsed = parseConnectionProfiles({
      profiles: [PROD, { id: "bad", name: "Sketchy", baseUrl: "ftp://x.com" }],
      activeId: null,
    });
    expect(parsed.profiles).toEqual([PROD]);
  });

  it("drops a row with no name rather than rendering an unlabelled button", () => {
    const parsed = parseConnectionProfiles({
      profiles: [{ id: "x", name: "   ", baseUrl: "https://api.acme.com" }],
    });
    expect(parsed.profiles).toEqual([]);
  });

  it("collapses a duplicated server to the first row", () => {
    const parsed = parseConnectionProfiles({
      profiles: [PROD, { ...PROD, id: "other", name: "Copy" }],
    });
    expect(parsed.profiles).toHaveLength(1);
  });

  it("forgets an activeId no surviving row claims", () => {
    const parsed = parseConnectionProfiles({
      profiles: [PROD],
      activeId: "ghost",
    });
    expect(parsed.activeId).toBeNull();
  });

  it("caps a hostile record", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: `id-${i}`,
      name: `Server ${i}`,
      baseUrl: `https://api-${i}.acme.com`,
    }));
    expect(parseConnectionProfiles({ profiles: many }).profiles).toHaveLength(
      MAX_CONNECTION_PROFILES,
    );
  });

  it("reads garbage as no connections", () => {
    expect(parseConnectionProfiles(null)).toEqual(EMPTY_CONNECTION_PROFILES);
    expect(parseConnectionProfiles({ profiles: "nope" })).toEqual(
      EMPTY_CONNECTION_PROFILES,
    );
  });
});

describe("connectionProfileProblem", () => {
  it("accepts a named https server", () => {
    expect(
      connectionProfileProblem(
        { name: "Acme", baseUrl: "https://api.acme.com" },
        EMPTY_CONNECTION_PROFILES,
      ),
    ).toBeNull();
  });

  it("requires a name before anything else", () => {
    const problem = connectionProfileProblem(
      { name: "  ", baseUrl: "nonsense" },
      EMPTY_CONNECTION_PROFILES,
    );
    expect(problem?.field).toBe("name");
  });

  it("bounds the name", () => {
    const problem = connectionProfileProblem(
      { name: "x".repeat(MAX_PROFILE_NAME_CHARS + 1), baseUrl: "https://a.com" },
      EMPTY_CONNECTION_PROFILES,
    );
    expect(problem?.field).toBe("name");
  });

  it("reports the app's own URL verdict verbatim", () => {
    const problem = connectionProfileProblem(
      { name: "Acme", baseUrl: "https://user:pw@api.acme.com" },
      EMPTY_CONNECTION_PROFILES,
    );
    expect(problem).toEqual({
      field: "baseUrl",
      message: "API URL must not include credentials.",
    });
  });

  it("names the profile that already holds that server, trailing slash and all", () => {
    const problem = connectionProfileProblem(
      { name: "Second copy", baseUrl: "https://api.acme.com/" },
      state([PROD]),
    );
    expect(problem?.field).toBe("baseUrl");
    expect(problem?.message).toContain("Acme production");
  });

  it("refuses past the cap", () => {
    const full = Array.from({ length: MAX_CONNECTION_PROFILES }, (_, i) => ({
      id: `id-${i}`,
      name: `Server ${i}`,
      baseUrl: `https://api-${i}.acme.com`,
    }));
    const problem = connectionProfileProblem(
      { name: "One more", baseUrl: "https://extra.acme.com" },
      state(full),
    );
    expect(problem?.field).toBe("form");
  });
});

describe("addConnectionProfile", () => {
  it("adds without stealing the active flag", () => {
    const result = addConnectionProfile(state([PROD], "p1"), {
      id: "p2",
      name: "  Acme staging  ",
      baseUrl: "https://stage.acme.com/",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile).toEqual(STAGE);
    expect(result.state.activeId).toBe("p1");
  });

  it("refuses a duplicate id rather than shadowing a row", () => {
    const result = addConnectionProfile(state([PROD]), {
      id: "p1",
      name: "Another",
      baseUrl: "https://other.acme.com",
    });
    expect(result.ok).toBe(false);
  });
});

describe("removeConnectionProfile", () => {
  it("removes an inactive profile", () => {
    const result = removeConnectionProfile(state([PROD, STAGE], "p1"), "p2");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.profiles).toEqual([PROD]);
    expect(result.state.activeId).toBe("p1");
  });

  it("refuses to remove the connection this device is signed in to", () => {
    const result = removeConnectionProfile(state([PROD, STAGE], "p1"), "p1");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("Switch to another one first");
  });

  it("says so when the row is already gone", () => {
    expect(removeConnectionProfile(state([PROD]), "ghost").ok).toBe(false);
  });
});

describe("reconcileActiveProfile", () => {
  it("adopts the live server on a device that has never opened the sheet", () => {
    const next = reconcileActiveProfile(
      EMPTY_CONNECTION_PROFILES,
      "https://api.acme.com",
      "seeded",
    );
    expect(next.profiles).toEqual([
      { id: "seeded", name: "api.acme.com", baseUrl: "https://api.acme.com" },
    ]);
    expect(next.activeId).toBe("seeded");
  });

  it("marks the matching saved profile active instead of duplicating it", () => {
    const next = reconcileActiveProfile(state([PROD, STAGE]), "https://stage.acme.com", "new");
    expect(next.profiles).toHaveLength(2);
    expect(next.activeId).toBe("p2");
  });

  it("returns the SAME object when nothing changed, so no write is issued", () => {
    const before = state([PROD], "p1");
    expect(reconcileActiveProfile(before, "https://api.acme.com", "new")).toBe(
      before,
    );
    expect(reconcileActiveProfile(before, null, "new")).toBe(before);
  });

  it("ignores a live address the URL policy refuses", () => {
    const before = state([PROD], "p1");
    expect(reconcileActiveProfile(before, "ftp://api.acme.com", "new")).toBe(
      before,
    );
  });

  it("adopts nothing when the id it is handed is unusable", () => {
    // `Crypto.randomUUID()` answers undefined wherever the native module is
    // absent. A row with no id can be listed but never switched away from or
    // removed, so no row is the better answer.
    const before = EMPTY_CONNECTION_PROFILES;
    expect(
      reconcileActiveProfile(before, "https://api.acme.com", ""),
    ).toBe(before);
    expect(
      reconcileActiveProfile(
        before,
        "https://api.acme.com",
        undefined as unknown as string,
      ),
    ).toBe(before);
  });
});

describe("sortConnectionProfiles", () => {
  it("pins the active profile first, then sorts by name case-insensitively", () => {
    const rows = sortConnectionProfiles(
      state(
        [
          { id: "z", name: "zebra", baseUrl: "https://z.acme.com" },
          { id: "a", name: "Acme", baseUrl: "https://a.acme.com" },
          STAGE,
        ],
        "p2",
      ),
    );
    expect(rows.map((row) => row.id)).toEqual(["p2", "a", "z"]);
  });
});

describe("connectionSwitchDecision", () => {
  it("treats the current connection as not a button", () => {
    expect(
      connectionSwitchDecision({ profile: PROD, activeId: "p1", online: true }),
    ).toEqual({ kind: "current" });
  });

  it("refuses offline rather than signing the user out of both servers", () => {
    const decision = connectionSwitchDecision({
      profile: STAGE,
      activeId: "p1",
      online: false,
    });
    expect(decision.kind).toBe("offline");
  });

  it("states the whole transaction in the confirmation", () => {
    const decision = connectionSwitchDecision({
      profile: STAGE,
      activeId: "p1",
      online: true,
    });
    expect(decision.kind).toBe("sign-out");
    if (decision.kind !== "sign-out") return;
    expect(decision.title).toContain("Acme staging");
    expect(decision.message).toContain("signs out");
    expect(decision.message).toContain("stage.acme.com");
  });
});

describe("connectionSwitchConsequence", () => {
  it("counts what the sign-out discards", () => {
    expect(connectionSwitchConsequence(1)).toContain("1 change");
    expect(connectionSwitchConsequence(3)).toContain("3 changes");
    expect(connectionSwitchConsequence(0)).toContain("offline data");
  });
});

describe("labels", () => {
  it("shows the host, and never invents one", () => {
    expect(connectionHostLabel("https://api.acme.com:8443/x")).toBe(
      "api.acme.com:8443",
    );
    expect(connectionHostLabel("not a url")).toBe("not a url");
    expect(suggestConnectionName("https://api.acme.com/")).toBe("api.acme.com");
  });
});
