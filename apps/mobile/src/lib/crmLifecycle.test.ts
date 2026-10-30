import { describe, expect, it } from "vitest";

import {
  CRM_VERB_LABELS,
  crmIsDisconnected,
  crmIsPaused,
  crmStatusSummary,
  crmVerbErrorMessage,
  crmVerbIsDestructive,
  crmVerbsFor,
} from "./crmLifecycle";

const row = (extra: Partial<Parameters<typeof crmStatusSummary>[0]> = {}) => ({
  id: "c1",
  provider: "hubspot",
  name: "HubSpot",
  status: "active",
  lastSyncAt: "",
  errorMessage: "",
  ...extra,
});

describe("crmVerbsFor", () => {
  it("offers nothing for a disconnected row, which the server refuses twice", () => {
    // handlers.go:94-96 short-circuits with 409 at seven call sites, and the
    // pause/resume UPDATE carries `AND status <> 'disconnected'` (repo.go:1053).
    expect(crmVerbsFor("disconnected")).toEqual([]);
    expect(crmVerbsFor("DISCONNECTED")).toEqual([]);
    expect(crmVerbsFor("  disconnected  ")).toEqual([]);
  });

  it("offers the full set for a live row, with disconnect last", () => {
    const verbs = crmVerbsFor("active");
    expect(verbs).toEqual(["sync", "backfill", "pause", "disconnect"]);
    expect(verbs[verbs.length - 1]).toBe("disconnect");
  });

  it("treats an errored row as live, because retrying is the point", () => {
    // The server's only guard is `disconnected`, so a failing connection must
    // still offer Sync — that is the verb the operator opened the screen for.
    expect(crmVerbsFor("error")).toContain("sync");
  });

  it("swaps pause for resume on a paused row, never both", () => {
    const verbs = crmVerbsFor("paused");
    expect(verbs).toContain("resume");
    expect(verbs).not.toContain("pause");
    expect(crmVerbsFor("active")).not.toContain("resume");
  });

  it("does not offer Sync on a paused row", () => {
    // The server would accept it, but syncing a connection someone deliberately
    // halted is a surprise rather than a feature.
    expect(crmVerbsFor("paused")).not.toContain("sync");
  });

  it("treats `connected` as live too", () => {
    // repo.go:1019 lists it alongside active/paused/error.
    expect(crmVerbsFor("connected")).toContain("sync");
  });

  it("treats an unknown status as live rather than dead", () => {
    // Failing toward "no verbs" would strand an operator whenever the server adds
    // a status; only `disconnected` is a real refusal.
    expect(crmVerbsFor("reticulating")).toContain("sync");
    expect(crmVerbsFor("")).toContain("sync");
  });

  it("labels every verb it can return", () => {
    for (const status of ["active", "paused", "error", "connected"]) {
      for (const verb of crmVerbsFor(status)) {
        expect(CRM_VERB_LABELS[verb]).toBeTruthy();
      }
    }
  });
});

describe("crmVerbIsDestructive", () => {
  it("marks only disconnect", () => {
    expect(crmVerbIsDestructive("disconnect")).toBe(true);
    for (const verb of ["sync", "backfill", "pause", "resume"] as const) {
      expect(crmVerbIsDestructive(verb)).toBe(false);
    }
  });
});

describe("crmIsDisconnected / crmIsPaused", () => {
  it("compares case- and whitespace-insensitively", () => {
    expect(crmIsDisconnected(" Disconnected ")).toBe(true);
    expect(crmIsPaused("PAUSED")).toBe(true);
    expect(crmIsPaused("active")).toBe(false);
  });
});

describe("crmStatusSummary", () => {
  it("names the remedy for a disconnected row", () => {
    expect(crmStatusSummary(row({ status: "disconnected" }))).toContain(
      "Reconnect",
    );
  });

  it("says nothing syncs while paused", () => {
    expect(crmStatusSummary(row({ status: "paused" }))).toContain(
      "Nothing syncs",
    );
  });

  it("shows the provider's own error when there is one", () => {
    expect(
      crmStatusSummary(row({ status: "error", errorMessage: "401 from API" })),
    ).toContain("401 from API");
  });

  it("still says the row is failing when no message came back", () => {
    const summary = crmStatusSummary(row({ status: "error" }));
    expect(summary).toContain("Failing");
    expect(summary).not.toContain("undefined");
  });

  it("reports the last sync when active", () => {
    expect(
      crmStatusSummary(row({ status: "active", lastSyncAt: "2 hours ago" })),
    ).toContain("2 hours ago");
    expect(crmStatusSummary(row({ status: "active" }))).toBe("Active.");
  });
});

describe("crmVerbErrorMessage", () => {
  it("turns the 409 into the actual next step", () => {
    expect(crmVerbErrorMessage("integration_disconnected", "x")).toContain(
      "Reconnect",
    );
  });

  it("falls back rather than inventing a diagnosis", () => {
    expect(crmVerbErrorMessage("teapot", "FALLBACK")).toBe("FALLBACK");
  });
});
