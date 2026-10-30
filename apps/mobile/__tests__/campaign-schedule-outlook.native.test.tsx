/**
 * The month-at-a-glance grid over the scheduled agenda — the mobile half of
 * desktop's CampaignCalendar (the density half; the drag half is dead on
 * desktop itself behind CAMPAIGN_SCHEDULING_AVAILABLE=false).
 *
 * The calendar arithmetic (42 cells, local day boundaries, scheduled-only
 * counts) is vitest-pinned in src/lib/campaignCalendarMonth.test.ts. What only
 * a render can pin is the LENS contract:
 *   - collapsed by default (the agenda stays the primary answer);
 *   - a day with sends is a button that narrows to that day, and tapping the
 *     selected day widens back out;
 *   - a day with nothing offers no affordance instead of a dead tap.
 *
 * Rendered via a RELATIVE import: jest.routes.config.cjs maps
 * `@/components/campaigns/*` to a null stub, which would make every assertion
 * here vacuous.
 */
import { describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import React from "react";

import type { AgendaRow } from "../src/lib/campaignAgenda";
import { CampaignScheduleOutlook } from "../src/components/campaigns/CampaignScheduleOutlook";

// Local calendar parts, never ISO literals: the module's contract is that day
// boundaries are LOCAL, so the fixtures must hold in any CI zone. The 15th of
// the current month keeps every fixture inside the default anchor month.
const now = new Date();
const day15 = new Date(now.getFullYear(), now.getMonth(), 15);
const ROWS: AgendaRow[] = [
  {
    id: "c1",
    status: "scheduled",
    scheduled_at: new Date(
      now.getFullYear(),
      now.getMonth(),
      15,
      9,
    ).toISOString(),
  },
  {
    id: "c2",
    status: "scheduled",
    scheduled_at: new Date(
      now.getFullYear(),
      now.getMonth(),
      15,
      18,
    ).toISOString(),
  },
];

async function open(
  over: Partial<React.ComponentProps<typeof CampaignScheduleOutlook>> = {},
) {
  const onSelectDay = jest.fn();
  const result = await render(
    <CampaignScheduleOutlook
      rows={ROWS}
      selectedDay={null}
      onSelectDay={onSelectDay}
      {...over}
    />,
  );
  await fireEvent.press(result.getByLabelText("Show the month view"));
  return { result, onSelectDay };
}

describe("campaign schedule outlook", () => {
  it("stays collapsed until asked — the agenda remains the primary answer", async () => {
    const result = await render(
      <CampaignScheduleOutlook
        rows={ROWS}
        selectedDay={null}
        onSelectDay={jest.fn()}
      />,
    );
    expect(result.getByLabelText("Show the month view")).toBeTruthy();
    expect(result.queryByLabelText("Previous month")).toBeNull();
  });

  it("narrows the agenda to a tapped day with sends", async () => {
    const { result, onSelectDay } = await open();
    await fireEvent.press(result.getByLabelText(/2 scheduled sends/));
    expect(onSelectDay).toHaveBeenCalledWith(day15.getTime());
  });

  it("tapping the selected day widens back out", async () => {
    const { result, onSelectDay } = await open({
      selectedDay: day15.getTime(),
    });
    await fireEvent.press(result.getByLabelText(/2 scheduled sends/));
    expect(onSelectDay).toHaveBeenCalledWith(null);
  });

  it("offers no affordance on an empty day, not a dead tap", async () => {
    const { result, onSelectDay } = await open();
    const empty = result.getAllByLabelText(/nothing scheduled/)[0]!;
    expect(empty.props.accessibilityState.disabled).toBe(true);
    await fireEvent.press(empty);
    expect(onSelectDay).not.toHaveBeenCalled();
  });

  it("counts the month and names the loaded-list caveat", async () => {
    const { result } = await open();
    expect(result.getByText(/2 sends scheduled in/)).toBeTruthy();
    expect(result.getByText(/counted from the loaded list/)).toBeTruthy();
  });
});
