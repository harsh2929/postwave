// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "../../components/subscribers/SubscriberNaturalLanguageSegmentPanel",
  () => ({ SubscriberNaturalLanguageSegmentPanel: () => null }),
);

import { SubscribersSegmentsPanels } from "../../pages/subscribers/SubscribersSegmentsPanels";
import type { SubscribersPageController } from "../../pages/subscribers/useSubscribersPageController";

function controllerFor(
  applySavedSegment: () => Promise<boolean>,
): SubscribersPageController {
  return {
    canMutate: true,
    state: { filter: "all", query: "" },
    saved: {
      applySavedSegment,
      openSaveCurrent: vi.fn(),
      savedSegmentsLoading: false,
      savedSegmentsError: null,
      savedSegments: [
        {
          id: "saved-1",
          name: "Reviewed readers",
          description: "",
          updated_at: "2026-07-19T00:00:00.000Z",
        },
      ],
      loadSavedSegments: vi.fn(),
      setPendingSegmentDelete: vi.fn(),
    },
  } as unknown as SubscribersPageController;
}

describe("SubscribersSegmentsPanels navigation ownership", () => {
  it.each([false, true])(
    "switches to Directory only when saved-view application is %s",
    async (applied) => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      const onOpenDirectory = vi.fn();
      act(() => {
        root.render(
          <SubscribersSegmentsPanels
            controller={controllerFor(vi.fn().mockResolvedValue(applied))}
            onOpenDirectory={onOpenDirectory}
          />,
        );
      });

      const open = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Open in Directory",
      );
      await act(async () => open?.click());

      expect(onOpenDirectory).toHaveBeenCalledTimes(applied ? 1 : 0);
      act(() => root.unmount());
      container.remove();
    },
  );
});
