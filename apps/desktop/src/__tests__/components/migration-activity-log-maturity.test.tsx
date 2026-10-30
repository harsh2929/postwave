// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  ActivityLog,
  type ActivityEntry,
} from "../../components/migration/ActivityLog";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.useRealTimers();
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.replaceChildren();
});

function entry(id: number, message: string): ActivityEntry {
  return { id, message, at: `2026-08-09T10:00:0${id}.000Z` };
}

function render(events: ActivityEntry[]): void {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  act(() => root?.render(<ActivityLog events={events} />));
}

function announced(): string {
  return (
    document.querySelector("[data-migration-activity-announcement]")
      ?.textContent ?? ""
  );
}

describe("migration activity announcements", () => {
  it("throttles a continuous event stream without starving announcements", () => {
    vi.useFakeTimers();
    render([entry(1, "First checkpoint")]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    render([entry(1, "First checkpoint"), entry(2, "Second checkpoint")]);
    act(() => {
      vi.advanceTimersByTime(399);
    });
    expect(announced()).toBe("");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(announced()).toBe("Second checkpoint");

    render([
      entry(1, "First checkpoint"),
      entry(2, "Second checkpoint"),
      entry(3, "Third checkpoint"),
    ]);
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(announced()).toBe("Third checkpoint");
  });
});
