/**
 * The More menu's notification badge, as VoiceOver hears it.
 *
 * `MoreRow.badgeSpoken` exists because the visible pill is CAPPED — the row
 * geometry has room for three glyphs, so 250 unread renders as "99+". The
 * spoken label has no such constraint, and "99 plus unread" withholds the one
 * thing a count is for.
 *
 * The prop shipped read-but-never-written: `MoreRows.tsx` reads
 * `row.badgeSpoken ?? row.badge`, and the sole producer
 * (`useMoreDestinations`) spread only `badge`, so the `??` fallback ALWAYS
 * took the capped string. The same user hears the exact number from the tab
 * bar (`badgeAccessibilityLabel`, app/(tabs)/_layout.tsx) and the capped one
 * from the More row one screen away.
 *
 * This pins the PRODUCER rather than the read, because the read was never
 * broken — nothing fed it. It also renders the row, so the two halves are
 * asserted against each other rather than in isolation.
 */
import { describe, expect, it } from "@jest/globals";
import { render, renderHook, screen } from "@testing-library/react-native";
import React from "react";

import { MoreSection, type MoreRow } from "../src/components/more/MoreRows";
import { useMoreDestinations } from "../src/hooks/useMoreDestinations";

async function destinations(unread: number) {
  return await renderHook(() =>
    useMoreDestinations({
      effectiveRole: "owner",
      mode: "session",
      unread,
      query: "",
      startTour: () => {},
      onPinChanged: () => {},
    }),
  );
}

async function notificationsRow(unread: number): Promise<MoreRow> {
  const { result } = await destinations(unread);
  const rows: MoreRow[] = [];
  for (const section of result.current.sections.values()) rows.push(...section);
  const row = rows.find((r) => r.key === "notifications");
  // Vacuity floor: every assertion below reads off this row, so a manifest
  // that stopped shipping it must fail here rather than silently pass.
  expect(row).toBeTruthy();
  return row as MoreRow;
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

describe("More menu badge — spoken vs. drawn", () => {
  it("produces the EXACT count alongside the capped pill", async () => {
    const row = await notificationsRow(250);
    expect(row.badge).toBe("99+");
    expect(row.badgeSpoken).toBe("250");
  });

  it("agrees with the pill below the cap", async () => {
    const row = await notificationsRow(12);
    expect(row.badge).toBe("12");
    expect(row.badgeSpoken).toBe("12");
  });

  it("badges nothing at zero, so neither half is emitted", async () => {
    const row = await notificationsRow(0);
    expect(row.badge).toBeUndefined();
    expect(row.badgeSpoken).toBeUndefined();
  });

  it("speaks the uncapped number in the rendered row's label", async () => {
    const row = await notificationsRow(250);
    await render(
      <MoreSection title="Account" rows={[row]} t={theme} />,
    );
    // The failure this replaces: "Notifications. 99+ unread".
    expect(screen.getByLabelText(/250 unread/u)).toBeTruthy();
    expect(screen.queryByLabelText(/99\+ unread/u)).toBeNull();
    // …while the PILL still shows the capped glyph, which is the whole reason
    // the two values are separate.
    // `includeHiddenElements` because the pill is deliberately
    // `accessibilityElementsHidden` — a bare coloured count is invisible to
    // VoiceOver, which is why the label carries it instead.
    expect(
      screen.getByText("99+", { includeHiddenElements: true }),
    ).toBeTruthy();
  });
});
