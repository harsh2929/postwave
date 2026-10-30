/**
 * The nav-badge half of the what's-new mechanism.
 *
 * Its own file rather than a second describe beside the card's: both surfaces
 * pin Date.now, and the card's asynchronous dismissal read settles inside the
 * React act environment — mixing them in one module made the hook renders here
 * fail for reasons that had nothing to do with badges.
 *
 * Pinned here: the badge lands on the announced destination's row and nowhere
 * else, a screen reader hears the FEATURE's name rather than a bare "New", and
 * the whole thing clears itself when the shared window closes.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { render, renderHook, screen } from "@testing-library/react-native";
import React from "react";

import { MoreSection, type MoreRow } from "../src/components/more/MoreRows";
import { useMoreDestinations } from "../src/hooks/useMoreDestinations";
import { NEW_FEATURES } from "../src/lib/newFeatures";

const DAY_MS = 24 * 60 * 60 * 1000;

function insideWindow(): number {
  return Math.max(...NEW_FEATURES.map((e) => Date.parse(e.shippedAt))) + DAY_MS;
}

function pastWindow(): number {
  return insideWindow() + 400 * DAY_MS;
}

function pinNow(value: number): void {
  jest.spyOn(Date, "now").mockReturnValue(value);
}

const theme = {
  fg: "#000",
  fgMuted: "#444",
  fgSubtle: "#666",
  surface: "#fff",
  surfaceElevated: "#eee",
  borderSubtle: "#ccc",
  danger: "#c00",
  accent: "#06c",
  accentFg: "#fff",
} as unknown as Parameters<typeof MoreSection>[0]["t"];

async function moreRows(): Promise<MoreRow[]> {
  const { result } = await renderHook(() =>
    useMoreDestinations({
      effectiveRole: "owner",
      mode: "session",
      unread: 0,
      query: "",
      startTour: () => {},
      onPinChanged: () => {},
    }),
  );
  const rows: MoreRow[] = [];
  for (const section of result.current.sections.values()) rows.push(...section);
  // Vacuity floor: every assertion below reads off this list.
  expect(rows.length).toBeGreaterThan(0);
  return rows;
}

describe("nav discovery badge", () => {
  it("marks the announced destination's row, and only it", async () => {
    pinNow(insideWindow());
    const rows = await moreRows();
    const billing = rows.find((row) => row.key === "billing");
    expect(billing).toBeTruthy();
    expect(billing?.newFeatureKey).toBe("billing-api-usage");
    expect(rows.find((row) => row.key === "audit")?.newFeatureKey).toBeUndefined();
  });

  it("speaks the feature's name on the row instead of a bare pill", async () => {
    pinNow(insideWindow());
    const rows = await moreRows();
    const billing = rows.find((row) => row.key === "billing") as MoreRow;
    await render(<MoreSection title="Account" rows={[billing]} t={theme} />);
    expect(screen.getByLabelText(/New: API usage & cost dashboard/)).toBeTruthy();
    // The pill is deliberately hidden from the accessibility tree (the row
    // label above carries its meaning), so it has to be asked for explicitly.
    expect(screen.getByText("New", { includeHiddenElements: true })).toBeTruthy();
  });

  it("clears itself when the window closes — no code change, no stored flag", async () => {
    pinNow(pastWindow());
    const rows = await moreRows();
    expect(rows.every((row) => row.newFeatureKey === undefined)).toBe(true);
    const billing = rows.find((row) => row.key === "billing") as MoreRow;
    await render(<MoreSection title="Account" rows={[billing]} t={theme} />);
    expect(
      screen.queryByText("New", { includeHiddenElements: true }),
    ).toBeNull();
  });
});
