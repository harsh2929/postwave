/**
 * The dashboard's two list cards, against a payload the wire should never send
 * but a RESTORED CACHE can.
 *
 * app/(tabs)/dashboard.tsx passes `goals.data ?? []` and `anomalies.data ?? []`.
 * That is a NULLISH guard: it catches undefined and null and passes a truthy
 * `{}` or `{items: []}` straight through. Both cards then did
 * `x.length === 0` -- which is FALSY on an object, so execution fell through --
 * and threw on the very next line:
 *
 *   TypeError: goals.slice is not a function
 *   TypeError: events.map is not a function
 *
 * On the dashboard that is not a broken card, it is a blank first screen after
 * launch. The vector is a persisted cache written by an older response shape,
 * which is exactly how api-keys shipped its spread crash.
 */
import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react-native";

import { AnomalyHistoryCard } from "@/components/dashboard/AnomalyHistoryCard";
import { GoalsCard } from "@/components/dashboard/GoalsCard";

const HOSTILE: readonly unknown[] = [{}, { items: [] }, "nope", 7, true];

describe("dashboard cards survive a non-array payload", () => {
  it("GoalsCard renders nothing instead of throwing", async () => {
    for (const bad of HOSTILE) {
      await expect(
        render(<GoalsCard goals={bad as never} loading={false} />),
      ).resolves.toBeTruthy();
    }
  });

  it("AnomalyHistoryCard renders nothing instead of throwing", async () => {
    for (const bad of HOSTILE) {
      await expect(
        render(<AnomalyHistoryCard events={bad as never} />),
      ).resolves.toBeTruthy();
    }
  });

  it("still renders REAL rows — the guard must not swallow good input", async () => {
    // A guard returning [] unconditionally would pass both assertions above.
    // The row is COMPLETE on purpose: lib/anomalies.ts normalises zScore with
    // `finite()`, so a parsed event never carries undefined, and a test row that
    // omitted it would be asserting against a shape the product cannot produce.
    await render(
      <AnomalyHistoryCard
        events={
          [
            {
              id: "a1",
              metric: "bounces",
              label: "Bounces",
              value: 42,
              mean: 10,
              zScore: 4.2,
              detectedAt: "2026-08-18T10:00:00Z",
              dayBucket: "2026-08-18",
            },
          ] as never
        }
      />,
    );
    expect(screen.toJSON()).not.toBeNull();
  });
});
