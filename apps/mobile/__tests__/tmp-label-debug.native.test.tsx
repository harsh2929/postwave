import { describe, expect, it, jest } from "@jest/globals";
import { render, renderHook, screen } from "@testing-library/react-native";
import React from "react";

import { MoreSection, type MoreRow } from "../src/components/more/MoreRows";
import { useMoreDestinations } from "../src/hooks/useMoreDestinations";
import { NEW_FEATURES } from "../src/lib/newFeatures";

describe("debug label", () => {
  it("prints the rendered row label", async () => {
    jest
      .spyOn(Date, "now")
      .mockReturnValue(
        Math.max(...NEW_FEATURES.map((e) => Date.parse(e.shippedAt))) + 86400000,
      );
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
    const billing = rows.find((r) => r.key === "billing") as MoreRow;
    // eslint-disable-next-line no-console
    console.log("row", JSON.stringify(billing));
    const theme = {
      fg: "#000",
      fgMuted: "#444",
      fgSubtle: "#666",
      surface: "#fff",
      borderSubtle: "#ccc",
      danger: "#c00",
      accent: "#06c",
      accentFg: "#fff",
    } as unknown as Parameters<typeof MoreSection>[0]["t"];
    render(<MoreSection title="Account" rows={[billing]} t={theme} />);
    const json = JSON.stringify(screen.toJSON());
    // eslint-disable-next-line no-console
    console.log("tree", json.slice(0, 1500));
    expect(true).toBe(true);
  });
});
