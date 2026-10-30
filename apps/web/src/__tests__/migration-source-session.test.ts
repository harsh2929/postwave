// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it, vi, afterEach } from "vitest";

import {
  sourceSessionBlocksAction,
  sourceSessionStatus,
} from "@/lib/migration-source-session";

afterEach(() => {
  vi.useRealTimers();
});

describe("sourceSessionStatus", () => {
  it("requires reconnect when the saved session expiry is missing", () => {
    expect(sourceSessionStatus("mailchimp", null, "dry-run")).toEqual({
      kind: "missing",
      message:
        "The saved Mailchimp session is no longer available. Reconnect before starting dry-run.",
    });
  });

  it("allows a healthy future source session", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    expect(
      sourceSessionStatus("mailchimp", "2026-07-05T12:00:00.000Z", "dry-run"),
    ).toEqual({ kind: "ok", message: "" });
  });

  it("requires reconnect when the source session has expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    expect(
      sourceSessionStatus(
        "mailchimp",
        "2026-07-02T11:59:59.000Z",
        "the real import",
      ),
    ).toEqual({
      kind: "expired",
      message:
        "The source session has expired. Reconnect before starting the real import.",
    });
  });

  it("warns without blocking short-lived OAuth source sessions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    const status = sourceSessionStatus(
      "mailchimp",
      "2026-07-03T00:00:00.000Z",
      "the real import",
    );

    expect(status.kind).toBe("near");
    expect(status.message).toContain("You can continue the real import");
    expect(status.message).toContain(
      "saved Mailchimp source-session retention",
    );
    expect(status.message).toContain(
      "reconnect if the job runs past this saved-session retention",
    );
    expect(status.message).not.toContain("access token");
    expect(sourceSessionBlocksAction(status)).toBe(false);
  });

  it("blocks ActiveCampaign inside the server's 14-day reconnect window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    const status = sourceSessionStatus(
      "activecampaign",
      "2026-07-15T12:00:00.000Z",
      "cutover checks",
    );

    expect(status.kind).toBe("near");
    expect(status.message).toContain(
      "Reconnect before starting cutover checks",
    );
    expect(sourceSessionBlocksAction(status)).toBe(true);
  });

  it("blocks HubSpot inside the server's 14-day reconnect window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    const status = sourceSessionStatus(
      "hubspot",
      "2026-07-15T12:00:00.000Z",
      "bridge checks",
    );

    expect(status.kind).toBe("near");
    expect(status.message).toContain("Reconnect before starting bridge checks");
    expect(sourceSessionBlocksAction(status)).toBe(true);
  });

  it("blocks Beehiiv inside the server's 14-day reconnect window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    const status = sourceSessionStatus(
      "beehiiv",
      "2026-07-15T12:00:00.000Z",
      "publication cutover checks",
    );

    expect(status.kind).toBe("near");
    expect(status.message).toContain(
      "Reconnect before starting publication cutover checks",
    );
    expect(sourceSessionBlocksAction(status)).toBe(true);
  });

  it("blocks Klaviyo inside the server's 14-day reconnect window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    const status = sourceSessionStatus(
      "klaviyo",
      "2026-07-15T12:00:00.000Z",
      "profile cutover checks",
    );

    expect(status.kind).toBe("near");
    expect(status.message).toContain(
      "Reconnect before starting profile cutover checks",
    );
    expect(sourceSessionBlocksAction(status)).toBe(true);
  });

  it("blocks Customer.io inside the server's 14-day reconnect window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    const status = sourceSessionStatus(
      "customerio",
      "2026-07-15T12:00:00.000Z",
      "workspace cutover checks",
    );

    expect(status.kind).toBe("near");
    expect(status.message).toContain(
      "Reconnect before starting workspace cutover checks",
    );
    expect(sourceSessionBlocksAction(status)).toBe(true);
  });

  it("allows ActiveCampaign sessions outside the 14-day cutover window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    expect(
      sourceSessionStatus(
        "activecampaign",
        "2026-07-17T12:00:00.000Z",
        "cutover checks",
      ),
    ).toEqual({ kind: "ok", message: "" });
  });

  it("keeps the generic near-expiry window at one day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    expect(
      sourceSessionStatus(
        "mailchimp",
        "2026-07-04T12:00:00.000Z",
        "the real import",
      ),
    ).toEqual({ kind: "ok", message: "" });
  });

  it("requires reconnection for malformed legacy expiry metadata", () => {
    const result = sourceSessionStatus("mailchimp", "not-a-date", "dry-run");
    expect(result.kind).toBe("missing");
    expect(sourceSessionBlocksAction(result)).toBe(true);
  });
});

it("blocks a session with an invalid expiry instead of treating it as healthy", () => {
  const result = sourceSessionStatus("convertkit", "not-a-date", "import");
  expect(result.kind).toBe("missing");
  expect(sourceSessionBlocksAction(result)).toBe(true);
});
